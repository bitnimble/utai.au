"""The CoreML compile cache is per version of the model file: onnxruntime keys its
own cache by the model's path, so a model replaced in place must land in a fresh
directory or it runs the old file's compiled graph."""

import os

from app.config import settings
from app.pipeline.separation import np_inference


def test_replacing_the_model_file_gets_a_fresh_cache_and_drops_the_stale_one(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "cache_dir", tmp_path / "cache")
    model = tmp_path / "model_mel_band_roformer.fp16.onnx"
    model.write_bytes(b"v1")

    first = np_inference._coreml_cache_dir(model)
    assert first is not None
    assert np_inference._coreml_cache_dir(model) == first  # unchanged file -> same cache

    model.write_bytes(b"v2-longer")
    os.utime(model, ns=(1, 1))
    second = np_inference._coreml_cache_dir(model)

    assert second is not None and second != first
    assert not os.path.exists(first)
    assert os.path.isdir(second)
