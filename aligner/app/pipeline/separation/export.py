"""Export a loaded separation model's STFT-free body to ONNX, keeping the
complex STFT/iSTFT (and, for BS-Roformer, the complex mask multiply) OUT of the
graph so the body runs cleanly on any onnxruntime execution provider.

The graph is fixed-shape at the model's real chunk length: the runner always
feeds exactly one `chunk_size` window per call, so a fixed time axis is correct
and sidesteps the rotary-embedding cache's trace-time specialisation that a
dynamic axis would risk.

BS-Roformer exports `forward_mask` (spectrogram -> real mask); the numpy
inference path applies the complex mask + iSTFT around it
(np_inference.bs_apply_mask / bs_unpack).
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
        else:
            from app.pipeline.separation.mha_fusion import mha_optimize

            mha_optimize(out_path, shapes)
    finally:
        # Restore device AND eval: torch.onnx.export can leave the module in
        # train mode, which would re-enable BS-Roformer's attn/ff dropout on any
        # later torch forward (the separators are always eval / inference).
        model.to(orig_device).eval()
    if fp16:
        _to_fp16(out_path)
    return out_path
