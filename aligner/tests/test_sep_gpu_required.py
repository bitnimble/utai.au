"""The fp16 separation body can't run on the CPU EP: a GPU EP that failed to load has to fail
at session creation. On Windows it runs on DirectML, which needs its add-scatter rewritten."""

import tomllib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import TensorProto, helper, numpy_helper

from app.pipeline import onnx_cuda
from app.pipeline.separation import np_inference

CPU = "CPUExecutionProvider"
DML = "DmlExecutionProvider"
SHRINK = "memory.enable_memory_arena_shrinkage"


def _scatter_model(path) -> None:
    """The mel-band merge's shape: zeros[2, 3] += x[2, 4], bins 0, 2, 2, 1 along axis 1."""
    graph = helper.make_graph(
        [helper.make_node("ScatterElements", ["zeros", "idx", "x"], ["y"], axis=1, reduction="add")],
        "scatter",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT16, [2, 4])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT16, [2, 3])],
        [
            numpy_helper.from_array(np.zeros((2, 3), np.float16), "zeros"),
            numpy_helper.from_array(np.array([[0, 2, 2, 1]] * 2, np.int64), "idx"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 10
    onnx.save(model, path)


def test_the_cpu_ep_cannot_run_the_scatter(tmp_path):
    model = tmp_path / "scatter.onnx"
    _scatter_model(model)
    sess = ort.InferenceSession(str(model), providers=[CPU])
    with pytest.raises(Exception, match="MLFloat16 data type is not supported with ScatterElements"):
        sess.run(None, {"x": np.ones((2, 4), np.float16)})


def test_dml_body_sums_like_the_scatter_without_one(tmp_path):
    model = tmp_path / "scatter.fp16.onnx"
    _scatter_model(model)
    body = np_inference._dml_body(model)

    assert "ScatterElements" not in {n.op_type for n in onnx.load_from_string(body).graph.node}
    x = np.array([[1, 2, 3, 4], [5, 6, 7, 8]], np.float16)
    out = ort.InferenceSession(body, providers=[CPU]).run(None, {"x": x})[0]
    assert out.dtype == np.float16
    assert out.tolist() == [[1, 4, 5], [5, 8, 13]]


def test_only_dml_sessions_load_the_rewritten_body(tmp_path, monkeypatch):
    model = tmp_path / "scatter.onnx"
    _scatter_model(model)
    loaded = []
    real_session = ort.InferenceSession

    def spy(body, **kwargs):
        loaded.append(body)
        return real_session(body, sess_options=kwargs["sess_options"], providers=[CPU])

    monkeypatch.setattr(ort, "InferenceSession", spy)
    monkeypatch.setattr(np_inference, "_dml_body", lambda path: onnx.load(str(path)).SerializeToString())

    np_inference._ort_session(model, [DML, CPU])
    np_inference._ort_session(model, [CPU])

    assert isinstance(loaded[0], bytes)
    assert loaded[1] == str(model)


def test_fp16_body_refuses_a_cpu_only_session(tmp_path):
    model = tmp_path / "scatter.fp16.onnx"
    _scatter_model(model)
    with pytest.raises(RuntimeError, match="no GPU execution provider loaded"):
        np_inference._ort_session(model, [CPU])


def test_cpu_only_refusal_keys_on_the_fp16_filename(tmp_path):
    model = tmp_path / "scatter.onnx"
    _scatter_model(model)
    assert np_inference._ort_session(model, [CPU]).get_providers() == [CPU]


def test_dml_stays_on_numpy_unless_the_fold_is_opted_into(monkeypatch):
    sep = np_inference.NumpySeparator.__new__(np_inference.NumpySeparator)
    sep.session = SimpleNamespace(get_providers=lambda: [DML, CPU])
    sep._providers = [CPU]
    sep._in = "stft_repr"
    window = np.hanning(64).astype(np.float32)

    monkeypatch.delenv("UTAI_SEP_FOLD_STFT", raising=False)
    assert sep._build_fold(64, 16, 8, 1, 2, window) is None
    monkeypatch.setenv("UTAI_SEP_FOLD_STFT", "1")
    assert isinstance(sep._build_fold(64, 16, 8, 1, 2, window), np_inference._RoformerFoldInverse)


def test_dml_sessions_skip_arena_shrinking():
    dml = onnx_cuda.release_arena_run_options(SimpleNamespace(get_providers=lambda: [DML, CPU]))
    with pytest.raises(RuntimeError, match="does not have configuration"):
        dml.get_run_config_entry(SHRINK)
    cpu = onnx_cuda.release_arena_run_options(SimpleNamespace(get_providers=lambda: [CPU]))
    assert cpu.get_run_config_entry(SHRINK) == "cpu:0"


def test_windows_installs_directml_and_no_cuda():
    lock = tomllib.loads((Path(__file__).parents[1] / "uv.lock").read_text(encoding="utf-8"))
    directml = next(p for p in lock["package"] if p["name"] == "onnxruntime-directml")
    assert any("cp311-win_amd64" in w["url"] for w in directml["wheels"])
    project = next(p for p in lock["package"] if p["name"] == "utai-aligner")
    separation = project["metadata"]["requires-dev"]["separation"]
    markers = {d["name"]: d.get("marker") for d in separation}
    assert markers["onnxruntime-directml"] == "sys_platform == 'win32'"
    for package in ("onnxruntime-gpu", "nvidia-cublas-cu12", "nvidia-cudnn-cu12", "tensorrt-cu12"):
        assert markers[package] == "sys_platform == 'linux'"
