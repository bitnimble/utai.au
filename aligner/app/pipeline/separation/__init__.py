"""Torch separation wrapper for the vocals separator (Mel-Band Roformer),
a drop-in for `audio-separator`.

Runtime inference is torch-free (`np_inference.NumpySeparator`); this torch path
exists only for the BUILD side: `loader.load_model` builds a vendored `nn.Module`
from a (ckpt, yaml) pair, `export.export_body` cuts it at `forward_mask` to the
ONNX body the runtime runs, and `runner.SeparationRunner.separate` is the fp32
reference the offline parity test checks the export against. Import from
`.loader` / `.runner` directly; this package intentionally exposes no re-export
barrel.
"""
