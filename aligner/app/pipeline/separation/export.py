"""Export a loaded separation model's STFT-free body to ONNX, keeping the
complex STFT/iSTFT (and the complex mask multiply) OUT of the graph so the body
runs cleanly on any onnxruntime execution provider.

The graph is fixed-shape at the model's real chunk length: the runner always
feeds exactly one `chunk_size` window per call, so a fixed time axis is correct
and sidesteps the rotary-embedding cache's trace-time specialisation that a
dynamic axis would risk.

Mel-Band Roformer exports `forward_mask` (spectrogram -> real averaged mask); the
numpy inference path applies the complex mask + iSTFT around it
(np_inference.bs_apply_mask / bs_unpack). The CUDA/TensorRT body is mixed
fp16/fp32 (RMSNorm reductions fp32 for quality); see `_to_mixed_fp16`.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import torch

from .loader import LoadedModel


def _target_variant() -> str:
    """Which platform body to export: `coreml` (macOS, the coreml_optimize'd plain
    fp16 graph) or `cuda` (the mixed fp16/fp32 body for the CUDA/TensorRT/DirectML
    EPs, the default off macOS). A release build that ships both sets
    `UTAI_SEP_VARIANT` to force one regardless of the build host's platform."""
    override = os.environ.get("UTAI_SEP_VARIANT", "").strip().lower()
    if override in ("coreml", "cuda"):
        return override
    return "coreml" if sys.platform == "darwin" else "cuda"


class _RoformerBody(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x):
        return self.model.forward_mask(x)


def _roformer_example(loaded: LoadedModel) -> torch.Tensor:
    model = loaded.model
    chunk = model.stft_kwargs["hop_length"] * (loaded.config.inference.dim_t - 1)
    dummy = torch.randn(1, model.audio_channels, chunk)
    with torch.no_grad():
        stft_repr, _ = model._stft_prep(dummy)
    return stft_repr


def _to_fp16(out_path: Path) -> None:
    """Convert the fp32 ONNX body to fp16 in place (shared onnx_fp16.to_fp16);
    the STFT/iSTFT stay fp32 in numpy outside this graph."""
    from app.pipeline.onnx_fp16 import to_fp16

    to_fp16(out_path)


def _to_mixed_fp16(out_path: Path) -> None:
    """Convert the fp32 body to a MIXED fp16 body in place: fp16 everywhere EXCEPT the RMSNorm
    reductions (`Pow`, `ReduceMean`), which stay fp32. Those are the only fp16-lossy op in the model
    -- the norm operates on the raw STFT's wide dynamic range, so a pure-fp16 sum-of-squares drops
    ~30 dB on loud/dense content (a two-song ear/SDR check caught this); fp32 there recovers it at
    ~1% speed cost. TensorRT (and the CUDA EP) obey the explicit per-op dtypes. A prior ORT
    constant-fold turns the rotary cos/sin into fp16 constants so no fp16xfp32 Mul remains."""
    import onnx
    import onnxruntime as ort
    from onnxconverter_common import float16

    folded = str(out_path.with_suffix(".folded.onnx"))
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC  # fold cos/sin; ALL adds FusedMatMul (TRT-incompatible)
    so.optimized_model_filepath = folded
    ort.InferenceSession(str(out_path), so, providers=["CPUExecutionProvider"])
    m = onnx.load(folded)
    m16 = float16.convert_float_to_float16(m, keep_io_types=True, op_block_list=["Pow", "ReduceMean"])
    del m16.graph.value_info[:]  # stale type annotations conflict with strongly-typed TensorRT-RTX
    onnx.save(m16, str(out_path))
    os.remove(folded)


def _int8_enabled() -> bool:
    """Weight-only int8 on disk is the primary CUDA/TensorRT format (~half the download).
    Opt out with UTAI_SEP_INT8=0 to ship the plain mixed fp16 body instead."""
    return os.environ.get("UTAI_SEP_INT8", "1").strip().lower() not in ("0", "false", "no", "off")


def _to_mixed_int8(out_path: Path) -> None:
    """Compress the mixed fp16 body's linear-layer weights to per-tensor symmetric int8 ON DISK, in
    place: each fp16 weight `W` (a `MatMul`/`Gemm` `B` input) becomes an int8 initializer +
    `DequantizeLinear` -> `Cast(fp16)` feeding the op. Halves the download (~515 -> ~290 MB) with
    EXECUTION unchanged -- the weights dequantize to fp16, so the matmuls still run fp16 (no int8
    tensor-core path, no activation calibration). Only matrices used purely as a MatMul/Gemm weight are
    touched -- NOT the rotary cos/sin or scale constants (they feed `Mul`, not a matmul, so int8 would
    hurt) -- and the fp32 RMSNorm reductions stay as `_to_mixed_fp16` left them. Per-tensor symmetric
    (zero_point 0) is the TRT-consumable QDQ form the bench validated -- TRT folds the weight DQ at
    engine-build time. DequantizeLinear at opset 17 emits fp32, so a Cast returns it to fp16."""
    import numpy as np
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    m = onnx.load(str(out_path))
    g = m.graph
    uses: dict[str, list] = {}
    for node in g.node:
        for idx, inp in enumerate(node.input):
            uses.setdefault(inp, []).append((node, idx))
    min_elems = 4096  # skip tiny weights; the transformer linears are the payload
    weight_ops = {"MatMul", "Gemm"}
    new_nodes = []
    for init in list(g.initializer):
        if init.data_type != TensorProto.FLOAT16:
            continue
        w = numpy_helper.to_array(init)
        if w.ndim != 2 or w.size < min_elems:
            continue
        cons = uses.get(init.name, [])
        if not cons or any(not (n.op_type in weight_ops and i == 1) for n, i in cons):
            continue  # used somewhere other than a MatMul/Gemm weight input -> leave it fp16
        wf = w.astype(np.float32)
        scale = float(np.abs(wf).max()) / 127.0
        if scale <= 0:
            continue
        wq = np.clip(np.round(wf / scale), -127, 127).astype(np.int8)
        q, sc, zp, dq, dqh = (f"{init.name}_i8", f"{init.name}_sc", f"{init.name}_zp",
                              f"{init.name}_dq", f"{init.name}_dqh")
        g.initializer.remove(init)
        g.initializer.extend([
            numpy_helper.from_array(wq, q),
            numpy_helper.from_array(np.array(scale, np.float32), sc),
            numpy_helper.from_array(np.array(0, np.int8), zp),
        ])
        new_nodes.append(helper.make_node("DequantizeLinear", [q, sc, zp], [dq], name=f"{init.name}/DQ"))
        new_nodes.append(helper.make_node("Cast", [dq], [dqh], to=TensorProto.FLOAT16, name=f"{init.name}/DQCast"))
        for n, i in cons:
            n.input[i] = dqh
    all_nodes = new_nodes + list(g.node)  # DQ/Cast consume only initializers -> safe to prepend
    del g.node[:]
    g.node.extend(all_nodes)
    onnx.checker.check_model(m, full_check=False)
    onnx.save(m, str(out_path))


def export_body(
    loaded: LoadedModel, out_path: str | Path, *, opset: int = 17, fp16: bool = False
) -> Path:
    """Export `loaded`'s body to `out_path` (.onnx). Returns the path.

    Exports on CPU (the example tensors are built on CPU and the exported graph
    is device-agnostic), restoring the model's original device afterwards, so it
    works whether the model was loaded on CPU or CUDA. `fp16=True` converts the
    graph to fp16 weights (fp32 I/O preserved)."""
    out_path = Path(out_path)
    model = loaded.model
    orig_device = next(model.parameters()).device
    model.cpu().eval()
    try:
        body, example, in_name, out_name = _RoformerBody(model), _roformer_example(loaded), "stft_repr", "mask"

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with torch.no_grad():
            torch.onnx.export(
                body,
                example,
                str(out_path),
                input_names=[in_name],
                output_names=[out_name],
                opset_version=opset,
                dynamo=False,
            )
        # macOS (CoreML EP) needs a numerically-exact rewrite of the attention-heavy
        # graph: the exported ReduceL2/Einsum/Neg/Expand/rotary ops have no CoreML
        # builder -- each a partition cut that shreds the model into CPU-bridged
        # islands. `coreml_optimize` rewrites them CoreML-native, on the fp32 graph
        # before the fp16 conversion below. MHA has no CoreML kernel, so this and the
        # CUDA body are mutually exclusive.
        shapes = {in_name: list(example.shape)}
        if _target_variant() == "coreml":
            from app.pipeline.separation.coreml_optimize import coreml_optimize

            coreml_optimize(out_path, shapes)
        # CUDA / TensorRT: no graph rewrite. TensorRT fuses attention itself (and its
        # `com.microsoft.MultiHeadAttention` contrib op can't be consumed by the TRT EP anyway), and
        # Mel-Band's attention (seq 801 / 60) is small enough that the naive SDPA score matrix isn't a
        # memory blow-up. The fp16/fp32-norm precision is set by _to_mixed_fp16.
    finally:
        # Restore device AND eval: torch.onnx.export can leave the module in
        # train mode, which would re-enable the model's attn/ff dropout on any
        # later torch forward (the separators are always eval / inference).
        model.to(orig_device).eval()
    if fp16:
        # coreml keeps its plain fp16 (the ANE handles precision); CUDA/TRT gets the mixed body,
        # then weight-only int8 on disk (the primary format) unless UTAI_SEP_INT8=0.
        if _target_variant() == "coreml":
            _to_fp16(out_path)
        else:
            _to_mixed_fp16(out_path)
            if _int8_enabled():
                _to_mixed_int8(out_path)
    return out_path
