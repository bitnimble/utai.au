"""In-graph STFT / iSTFT for BS-Roformer, so the framing + DFT + complex-mask +
iDFT + overlap-add run on the accelerator instead of numpy on the CPU.

Measured: the numpy pre/post (`bs_pack` + `bs_apply_mask` + `bs_unpack`) is ~half
of each separation chunk (the iSTFT + mask alone ~380ms vs the model's ~390ms);
folding it onto the GPU makes separation ~2x faster and lifts GPU utilisation
from ~50% to ~100%. These builders emit torch-free onnx graphs (via `onnx.helper`,
like the rest of the runtime) that are numerically identical to the numpy path
(verified in `tests/test_onnx_stft.py`); `np_inference._RoformerFold` /
`_RoformerFoldMac` run them as their own sessions chained around the model (plain
`run` today; a resident IOBinding chain that keeps the spectrogram/mask in VRAM is
a later optimisation).

- `build_forward` mirrors `bs_pack` / `np_stft.stft` (reflect-`center`, periodic
  Hann, one-sided rFFT as a matmul).
- `build_inverse` mirrors `bs_apply_mask` + `bs_unpack` / `np_stft.istft` (complex
  mask multiply, iRFFT-as-matmul, windowed Σw² weighted-overlap-add, center strip)
  -- the full CUDA inverse.
- `build_inverse_frames` is the Mac split: mask + iRFFT only (the matmuls the ANE
  runs), emitting windowed time-frames for `np_stft.overlap_add` to finish in numpy
  (the ANE won't run the index-heavy overlap-add).

All fixed-shape (one chunk), fp32 (the model's I/O is fp32, so no casts).
"""

from __future__ import annotations

import numpy as np
import onnx
from onnx import TensorProto, helper


def _f(name: str, arr) -> onnx.TensorProto:
    a = np.asarray(arr, np.float32)
    return helper.make_tensor(name, TensorProto.FLOAT, a.shape, a.flatten().tolist())


def _i(name: str, vals) -> onnx.TensorProto:
    return helper.make_tensor(name, TensorProto.INT64, [len(vals)], list(vals))


def _model(nodes, inits, inputs, outputs) -> onnx.ModelProto:
    # fp32 throughout: the model's I/O is fp32 (keep_io_types), so the fold must be
    # fp32 to chain without casts, and the fold's compute (~8ms) is ~2% of a chunk
    # -- fp16 tensor-cores would save nothing measurable against the ~390ms model.
    g = helper.make_graph(
        nodes, "stft",
        [helper.make_tensor_value_info(n, TensorProto.FLOAT, s) for n, s in inputs],
        [helper.make_tensor_value_info(n, TensorProto.FLOAT, s) for n, s in outputs],
        initializer=inits,
    )
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 10  # onnxruntime rejects ir_version >= 11
    return m


def _forward_basis(n_fft: int, window: np.ndarray):
    """Windowed rDFT: cos/sin bases [n_fft, n_freq] s.t. (windowed frame) @ basis
    gives Re / Im. Window is folded in so the graph feeds raw frames."""
    n_freq = n_fft // 2 + 1
    ang = -2 * np.pi * np.outer(np.arange(n_fft), np.arange(n_freq)) / n_fft
    return window[:, None] * np.cos(ang), window[:, None] * np.sin(ang)


def _inverse_basis(n_fft: int, window: np.ndarray):
    """iRFFT-with-synthesis-window bases [n_freq, n_fft] s.t.
    Re @ IB_RE + Im @ IB_IM == irfft(spec) * window (bins 1..Nyq-1 doubled)."""
    n_freq = n_fft // 2 + 1
    theta = 2 * np.pi * np.outer(np.arange(n_freq), np.arange(n_fft)) / n_fft
    c = np.full(n_freq, 2.0)
    c[0] = 1.0
    if n_fft % 2 == 0:
        c[-1] = 1.0
    ib_re = (c[:, None] / n_fft) * np.cos(theta) * window[None, :]
    ib_im = -(c[:, None] / n_fft) * np.sin(theta) * window[None, :]
    return ib_re, ib_im


def _window_envelope(n_fft: int, hop: int, n_frames: int, window: np.ndarray) -> np.ndarray:
    """Σw² weighted-overlap-add envelope over the output, floored (matches
    np_stft.istft). Length = n_fft + hop*(n_frames-1)."""
    out_len = n_fft + hop * (n_frames - 1)
    w2 = (window ** 2).astype(np.float64)
    env = np.zeros(out_len)
    for i in range(n_frames):
        env[i * hop:i * hop + n_fft] += w2
    return np.where(env > 1e-11, env, 1.0)


def build_inverse(n_fft, hop, n_freq, n_frames, n_stems, channels, window):
    """(stft_repr [1,fs,T,2], mask [1,n,fs,T,2]) -> stems [1,n,s,chunk], mirroring
    bs_apply_mask + bs_unpack exactly (fs = n_freq*s, chunk = hop*(T-1))."""
    s, n, t = channels, n_stems, n_frames
    fs = n_freq * s
    k = n_fft // hop
    n_blocks = t + k - 1
    out_len = n_fft + hop * (t - 1)
    p = n_fft // 2
    b = n * s
    ib_re, ib_im = _inverse_basis(n_fft, window)
    env = _window_envelope(n_fft, hop, t, window)
    N = helper.make_node
    inits = [
        _f("ib_re", ib_re), _f("ib_im", ib_im), _f("env", env),
        helper.make_tensor("g0", TensorProto.INT64, [], [0]),
        helper.make_tensor("g1", TensorProto.INT64, [], [1]),
        _i("un", [1, 1, fs, t]),          # sr broadcast shape
        _i("split5", [1, n, n_freq, s, t]),
        _i("mrs", [b, n_freq, t]),
        _i("olashp", [b, t, k, hop]),
        _i("outshp", [b, out_len]),
        _i("stems", [1, n, s, out_len - 2 * p]),
        _i("ax2", [2]),
    ]
    nodes = [
        # split re/im (scalar Gather drops the last axis)
        N("Gather", ["stft_repr", "g0"], ["sr_re"], axis=3),   # [1,fs,T]
        N("Gather", ["stft_repr", "g1"], ["sr_im"], axis=3),
        N("Gather", ["mask", "g0"], ["mk_re"], axis=4),        # [1,n,fs,T]
        N("Gather", ["mask", "g1"], ["mk_im"], axis=4),
        N("Reshape", ["sr_re", "un"], ["sre"]),                # [1,1,fs,T]
        N("Reshape", ["sr_im", "un"], ["sim"]),
        # complex mask multiply (broadcast over n stems)
        N("Mul", ["sre", "mk_re"], ["a"]), N("Mul", ["sim", "mk_im"], ["b_"]),
        N("Sub", ["a", "b_"], ["m_re"]),                       # [1,n,fs,T]
        N("Mul", ["sre", "mk_im"], ["c"]), N("Mul", ["sim", "mk_re"], ["d"]),
        N("Add", ["c", "d"], ["m_im"]),
    ]
    # repack [1,n,fs,T] -> [b, n_freq, T] for each of re/im
    for tag in ("re", "im"):
        nodes += [
            N("Reshape", [f"m_{tag}", "split5"], [f"r5_{tag}"]),           # [1,n,n_freq,s,T]
            N("Transpose", [f"r5_{tag}"], [f"rt_{tag}"], perm=[0, 1, 3, 2, 4]),  # [1,n,s,n_freq,T]
            N("Reshape", [f"rt_{tag}", "mrs"], [f"mm_{tag}"]),             # [b,n_freq,T]
            N("Transpose", [f"mm_{tag}"], [f"mtt_{tag}"], perm=[0, 2, 1]),  # [b,T,n_freq]
        ]
    # iRFFT (with synthesis window folded into the bases): frames = mre@IB_RE + mim@IB_IM
    nodes += [
        N("MatMul", ["mtt_re", "ib_re"], ["f_re"]),
        N("MatMul", ["mtt_im", "ib_im"], ["f_im"]),
        N("Add", ["f_re", "f_im"], ["frames"]),                # [b,T,n_fft]
        N("Reshape", ["frames", "olashp"], ["fb"]),            # [b,T,k,hop]
    ]
    # weighted overlap-add: block j of frame i -> output block i+j (Pad+Add)
    for j in range(k):
        inits += [_i(f"s{j}", [j]), _i(f"e{j}", [j + 1]),
                  _i(f"pad{j}", [0, j, 0, 0, n_blocks - t - j, 0])]
        nodes += [N("Slice", ["fb", f"s{j}", f"e{j}", "ax2"], [f"sl{j}"]),     # [b,T,1,hop]
                  N("Reshape", [f"sl{j}", "bth"], [f"bt{j}"]),                 # [b,T,hop]
                  N("Pad", [f"bt{j}", f"pad{j}"], [f"pd{j}"])]                 # [b,n_blocks,hop]
    inits.append(_i("bth", [b, t, hop]))
    acc = "pd0"
    for j in range(1, k):
        nodes.append(N("Add", [acc, f"pd{j}"], [f"oa{j}"]))
        acc = f"oa{j}"
    inits += [_i("sp", [p]), _i("ep", [out_len - p]), _i("ax1", [1])]
    nodes += [
        N("Reshape", [acc, "outshp"], ["ola"]),                # [b,out_len]
        N("Div", ["ola", "env"], ["norm"]),                    # /Σw²
        N("Slice", ["norm", "sp", "ep", "ax1"], ["strip"]),    # center strip [b,chunk]
        N("Reshape", ["strip", "stems"], ["out"]),             # [1,n,s,chunk]
    ]
    return _model(nodes, inits, [("stft_repr", [1, fs, t, 2]), ("mask", [1, n, fs, t, 2])],
                  [("out", [1, n, s, out_len - 2 * p])])


def build_forward(n_fft, hop, n_freq, n_frames, channels, window):
    """audio [1,s,chunk] -> stft_repr [1,fs,T,2], mirroring bs_pack / np_stft.stft
    (reflect center-pad, windowed rFFT-as-matmul, freq-leading pack). chunk =
    hop*(T-1); fs = n_freq*s."""
    s, t = channels, n_frames
    fs = n_freq * s
    p = n_fft // 2
    chunk = hop * (t - 1)
    b_cos, b_sin = _forward_basis(n_fft, window)  # [n_fft, n_freq], window folded in
    idx = (np.arange(n_fft)[None, :] + hop * np.arange(t)[:, None]).astype(np.int64)  # [T, n_fft]
    N = helper.make_node
    inits = [
        _f("bcos", b_cos), _f("bsin", b_sin),
        helper.make_tensor("idx", TensorProto.INT64, [t, n_fft], idx.flatten().tolist()),
        _i("sc", [s, chunk]), _i("pad", [0, p, 0, p]),
        helper.make_tensor("g1", TensorProto.INT64, [1], [-1]),  # unsqueeze axis
        _i("p5", [1, s, n_freq, t, 2]), _i("out", [1, fs, t, 2]),
    ]
    nodes = [
        N("Reshape", ["audio", "sc"], ["a2"]),                    # [s, chunk]
        N("Pad", ["a2", "pad"], ["ap"], mode="reflect"),          # [s, chunk+n_fft]
        N("Gather", ["ap", "idx"], ["fr"], axis=1),               # [s, T, n_fft]
        N("MatMul", ["fr", "bcos"], ["re0"]),                     # [s, T, n_freq]
        N("MatMul", ["fr", "bsin"], ["im0"]),
        N("Transpose", ["re0"], ["re"], perm=[0, 2, 1]),          # [s, n_freq, T]
        N("Transpose", ["im0"], ["im"], perm=[0, 2, 1]),
        N("Unsqueeze", ["re", "g1"], ["reu"]),                    # [s, n_freq, T, 1]
        N("Unsqueeze", ["im", "g1"], ["imu"]),
        N("Concat", ["reu", "imu"], ["ri"], axis=-1),             # [s, n_freq, T, 2]
        N("Reshape", ["ri", "p5"], ["r5"]),                       # [1, s, n_freq, T, 2]
        N("Transpose", ["r5"], ["r5t"], perm=[0, 2, 1, 3, 4]),    # [1, n_freq, s, T, 2]
        N("Reshape", ["r5t", "out"], ["stft_repr"]),              # [1, fs, T, 2]
    ]
    return _model(nodes, inits, [("audio", [1, s, chunk])], [("stft_repr", [1, fs, t, 2])])


def build_inverse_frames(n_fft, n_freq, n_frames, n_stems, channels, window):
    """(stft_repr [1,fs,T,2], mask [1,n,fs,T,2]) -> windowed time-frames
    [n*s, T, n_fft] (complex mask multiply + iRFFT-as-matmul). The overlap-add is
    left to numpy (np_stft.overlap_add): this is the Mac fold, where the ANE runs
    the matmuls but not the index-heavy overlap-add. Uses Slice (not Gather) for
    the re/im split so nothing forces it off the ANE. fs = n_freq*s."""
    s, n, t = channels, n_stems, n_frames
    fs = n_freq * s
    b = n * s
    ib_re, ib_im = _inverse_basis(n_fft, window)
    N = helper.make_node
    inits = [
        _f("ib_re", ib_re), _f("ib_im", ib_im),
        _i("s0", [0]), _i("s1", [1]), _i("s2", [2]), _i("ax3", [3]), _i("ax4", [4]),
        _i("un", [1, 1, fs, t]), _i("mkn", [1, n, fs, t]),
        _i("split5", [1, n, n_freq, s, t]), _i("mrs", [b, n_freq, t]),
    ]
    nodes = [
        N("Slice", ["stft_repr", "s0", "s1", "ax3"], ["sr_re4"]),   # [1,fs,T,1]
        N("Slice", ["stft_repr", "s1", "s2", "ax3"], ["sr_im4"]),
        N("Slice", ["mask", "s0", "s1", "ax4"], ["mk_re5"]),        # [1,n,fs,T,1]
        N("Slice", ["mask", "s1", "s2", "ax4"], ["mk_im5"]),
        N("Reshape", ["sr_re4", "un"], ["sre"]),                    # [1,1,fs,T]
        N("Reshape", ["sr_im4", "un"], ["sim"]),
        N("Reshape", ["mk_re5", "mkn"], ["mkre"]),                  # [1,n,fs,T]
        N("Reshape", ["mk_im5", "mkn"], ["mkim"]),
        N("Mul", ["sre", "mkre"], ["a"]), N("Mul", ["sim", "mkim"], ["b_"]),
        N("Sub", ["a", "b_"], ["m_re"]),                            # [1,n,fs,T]
        N("Mul", ["sre", "mkim"], ["c"]), N("Mul", ["sim", "mkre"], ["d"]),
        N("Add", ["c", "d"], ["m_im"]),
    ]
    for tag in ("re", "im"):
        nodes += [
            N("Reshape", [f"m_{tag}", "split5"], [f"r5_{tag}"]),            # [1,n,n_freq,s,T]
            N("Transpose", [f"r5_{tag}"], [f"rt_{tag}"], perm=[0, 1, 3, 2, 4]),  # [1,n,s,n_freq,T]
            N("Reshape", [f"rt_{tag}", "mrs"], [f"mm_{tag}"]),              # [b,n_freq,T]
            N("Transpose", [f"mm_{tag}"], [f"mtt_{tag}"], perm=[0, 2, 1]),  # [b,T,n_freq]
        ]
    nodes += [
        N("MatMul", ["mtt_re", "ib_re"], ["f_re"]),
        N("MatMul", ["mtt_im", "ib_im"], ["f_im"]),
        N("Add", ["f_re", "f_im"], ["frames"]),                     # [b,T,n_fft] windowed
    ]
    return _model(nodes, inits, [("stft_repr", [1, fs, t, 2]), ("mask", [1, n, fs, t, 2])],
                  [("frames", [b, t, n_fft])])
