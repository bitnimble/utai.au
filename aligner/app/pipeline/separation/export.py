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
    """Which bs_roformer optimization to bake into the exported body: `coreml`
    (macOS) or `mha` (CUDA/DirectML, the default off macOS). A release build that
    ships both sets `UTAI_SEP_VARIANT` to force one regardless of the build
    host's platform."""
    override = os.environ.get("UTAI_SEP_VARIANT", "").strip().lower()
    if override in ("coreml", "mha"):
        return override
    return "coreml" if sys.platform == "darwin" else "mha"


class _BsBody(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x):
        return self.model.forward_mask(x)


def _bs_example(loaded: LoadedModel) -> torch.Tensor:
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
        body, example, in_name, out_name = _BsBody(model), _bs_example(loaded), "stft_repr", "mask"

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
        # BS-Roformer needs a platform-specific rewrite of its attention-heavy
        # graph. Both rewrites are numerically exact and run on the fp32 graph,
        # before the fp16 conversion below.
        #   - macOS (CoreML EP): the exported ReduceL2/Einsum/Neg/Expand/rotary ops
        #     have no CoreML builder -- each a partition cut that shreds the model
        #     into CPU-bridged islands. `coreml_optimize` rewrites them CoreML-native.
        #   - CUDA / DirectML: the naive SDPA decomposition materializes the
        #     O(seq^2) score matrix (multi-GB fp16 peak -> WDDM paging). `mha_optimize`
        #     fuses it into `MultiHeadAttention` (flash/CUTLASS, O(seq) memory). MHA
        #     has no CoreML kernel, so the two variants are mutually exclusive.
        shapes = {in_name: list(example.shape)}
        if _target_variant() == "coreml":
            from app.pipeline.separation.coreml_optimize import coreml_optimize

            coreml_optimize(out_path, shapes)
        # CUDA / TensorRT: deliberately NO mha_optimize. TensorRT fuses attention itself, and its
        # `com.microsoft.MultiHeadAttention` contrib op can't be consumed by the TRT EP; Mel-Band's
        # attention (seq 801 / 60) is also small enough that the naive SDPA score matrix isn't the
        # multi-GB blow-up it is for BS-Roformer. The fp16/fp32-norm precision is set by _to_mixed_fp16.
    finally:
        # Restore device AND eval: torch.onnx.export can leave the module in
        # train mode, which would re-enable BS-Roformer's attn/ff dropout on any
        # later torch forward (the separators are always eval / inference).
        model.to(orig_device).eval()
    if fp16:
        # coreml keeps its plain fp16 (the ANE handles precision); CUDA/TRT gets the mixed body.
        _to_fp16(out_path) if _target_variant() == "coreml" else _to_mixed_fp16(out_path)
    return out_path
