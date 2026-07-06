"""Thin torch-only separation wrapper, a drop-in for `audio-separator` for the
vocals separator (Mel-Band Roformer).

`loader.load_model` builds a vendored `nn.Module` from a (ckpt, yaml) pair and
`runner.SeparationRunner.separate` runs the chunked overlap-add inference,
returning stems in memory. The torch path feeds `NumpySeparator` / ONNX export
via the model's `forward_mask` cut point. Import from `.loader` / `.runner`
directly; this package intentionally exposes no re-export barrel.
"""
