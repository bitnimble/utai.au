"""Gating logic for the TensorRT EP prepend (`_with_tensorrt`). Pure provider-list
plumbing -- no GPU, no session: the EP is opt-out (UTAI_SEP_TRT), only prepends when
CUDA is present and the TRT runtime is both registered in ORT and loadable, and never
double-adds. Guards the ~100x separation path from silently reverting to CUDA."""

import onnxruntime as ort
import pytest

from app.pipeline.separation import np_inference

CUDA = "CUDAExecutionProvider"
TRT = "TensorrtExecutionProvider"
CPU = "CPUExecutionProvider"


@pytest.fixture
def trt_ready(monkeypatch):
    """TRT registered in ORT + runtime libs load + a (no-op) cache dir."""
    monkeypatch.delenv("UTAI_SEP_TRT", raising=False)
    monkeypatch.setattr(ort, "get_available_providers", lambda: [TRT, CUDA, CPU])
    monkeypatch.setattr("app.pipeline.onnx_cuda.preload_tensorrt_libs", lambda: True)
    monkeypatch.setattr(np_inference, "_trt_cache_dir", lambda: None)


def _heads(providers):
    return [p if isinstance(p, str) else p[0] for p in providers]


def test_prepends_trt_before_cuda(trt_ready):
    out = np_inference._with_tensorrt([CUDA, CPU])
    assert _heads(out) == [TRT, CUDA, CPU]
    assert out[0][1]["trt_engine_cache_enable"] is True


def test_optout_env_disables(trt_ready, monkeypatch):
    monkeypatch.setenv("UTAI_SEP_TRT", "0")
    providers = [CUDA, CPU]
    assert np_inference._with_tensorrt(providers) == providers


def test_noop_without_cuda(trt_ready):
    providers = [CPU]
    assert np_inference._with_tensorrt(providers) == providers


def test_noop_when_already_present(trt_ready):
    providers = [TRT, CUDA]
    assert np_inference._with_tensorrt(providers) == providers


def test_noop_when_trt_not_registered(monkeypatch):
    monkeypatch.delenv("UTAI_SEP_TRT", raising=False)
    monkeypatch.setattr(ort, "get_available_providers", lambda: [CUDA, CPU])
    assert np_inference._with_tensorrt([CUDA, CPU]) == [CUDA, CPU]


def test_noop_when_libs_absent(trt_ready, monkeypatch):
    monkeypatch.setattr("app.pipeline.onnx_cuda.preload_tensorrt_libs", lambda: False)
    assert np_inference._with_tensorrt([CUDA, CPU]) == [CUDA, CPU]
