"""The fp16 separation body can't run on the CPU EP: a GPU EP that failed to load has to fail
at session creation. On Windows it runs on TensorRT-RTX where that loads, else on DirectML,
both with its add-scatter rewritten."""

import sys
import tomllib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import TensorProto, helper, numpy_helper

from app.config import settings
from app.pipeline import lyrics_onnx, onnx_cuda
from app.pipeline.beats import beat_onnx
from app.pipeline.pitch import rmvpe
from app.pipeline.separation import np_inference
from app.pipeline.separation.coreml_optimize import decode_weights_once, drop_unused_initializers

CPU = "CPUExecutionProvider"
DML = "DmlExecutionProvider"
TRT_RTX = onnx_cuda.TRT_RTX_EP
SHRINK = "memory.enable_memory_arena_shrinkage"


def _scatter_model(path) -> None:
    """The mel-band merge's shape: zeros[2, 4] += x[2, 4], bins 0, 2, 2, 1 along axis 1 (3 unused)."""
    graph = helper.make_graph(
        [helper.make_node("ScatterElements", ["zeros", "idx", "x"], ["y"], axis=1, reduction="add")],
        "scatter",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT16, [2, 4])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT16, [2, 4])],
        [
            numpy_helper.from_array(np.zeros((2, 4), np.float16), "zeros"),
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
    assert out.tolist() == [[1, 4, 5, 0], [5, 8, 13, 0]]


@pytest.mark.parametrize("load", ["separation", "aligner", "beats", "rmvpe"])
def test_gpu_sessions_turn_dml_graph_fusion_off(load, tmp_path, monkeypatch):
    options = []

    def spy(path, **kwargs):
        options.append(kwargs.get("sess_options"))
        return SimpleNamespace(get_providers=lambda: [DML, CPU], get_inputs=lambda: [SimpleNamespace(name="x")])

    monkeypatch.setattr(ort, "InferenceSession", spy)
    model = tmp_path / "model.onnx"
    _scatter_model(model)
    if load == "separation":
        np_inference._ort_session(model, [CPU])
    elif load == "aligner":
        lyrics_onnx._ort_session(model, [CPU])
    elif load == "beats":
        beat_onnx.OnnxBeatThis(model, [CPU])
    else:
        rmvpe.Rmvpe(model, [CPU])

    assert options[0].get_session_config_entry("ep.dml.disable_graph_fusion") == "1"


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


def _quantized_model(path) -> None:
    """y = x @ w, with w int8 on disk, decoded to fp16 per run the way the shipped body does."""
    graph = helper.make_graph(
        [
            helper.make_node("DequantizeLinear", ["w_i8", "w_sc", "w_zp"], ["w_dq"], name="dq"),
            helper.make_node("Cast", ["w_dq"], ["w"], name="cast", to=TensorProto.FLOAT16),
            helper.make_node("MatMul", ["x", "w"], ["y"], name="mul"),
        ],
        "quantized",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT16, [1, 2])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT16, [1, 2])],
        [
            numpy_helper.from_array(np.array([[4, -8], [12, 16]], np.int8), "w_i8"),
            numpy_helper.from_array(np.array(0.25, np.float32), "w_sc"),
            numpy_helper.from_array(np.array(0, np.int8), "w_zp"),
        ],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 10
    onnx.save(model, path)


def test_decode_weights_once_drops_the_per_run_decode(tmp_path):
    path = tmp_path / "quantized.onnx"
    _quantized_model(path)
    model = onnx.load(str(path))

    assert decode_weights_once(model.graph) == 1
    assert drop_unused_initializers(model.graph) == 3

    assert [n.op_type for n in model.graph.node] == ["MatMul"]
    assert [i.name for i in model.graph.initializer] == ["w"]
    weights = numpy_helper.to_array(model.graph.initializer[0])
    assert weights.tolist() == [[1, -2], [3, 4]]
    assert weights.dtype == np.float16


def test_decode_weights_once_keeps_a_decode_with_other_consumers(tmp_path):
    path = tmp_path / "quantized.onnx"
    _quantized_model(path)
    model = onnx.load(str(path))
    model.graph.node.append(helper.make_node("Identity", ["w_dq"], ["also_uses_dq"], name="other"))

    assert decode_weights_once(model.graph) == 0
    assert [n.op_type for n in model.graph.node] == ["DequantizeLinear", "Cast", "MatMul", "Identity"]


class _FakeTrtRtx:
    """Records what the EP's session gets, since the real EP needs an RTX GPU and CUDA 13 driver."""

    def __init__(self, monkeypatch, *, bound=(TRT_RTX, CPU), error=None):
        self.loaded = []
        self.provider_options = []
        monkeypatch.delenv("UTAI_SEP_TRT", raising=False)
        monkeypatch.setattr(onnx_cuda, "trt_rtx_devices", lambda: ["rtx-device"])
        monkeypatch.setattr(ort.SessionOptions, "add_provider_for_devices", self._add_provider, raising=False)

        def session(model, **kwargs):
            if error is not None:
                raise error
            self.loaded.append(model)
            return SimpleNamespace(get_providers=lambda: list(bound))

        monkeypatch.setattr(ort, "InferenceSession", session)

    def _add_provider(self, devices, options):
        self.provider_options.append((devices, options))


@pytest.fixture
def rtx_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "cache_dir", tmp_path / "cache")
    model = tmp_path / "scatter.fp16.onnx"
    _scatter_model(model)
    return model


def test_trt_rtx_session_loads_the_rewritten_body_once(rtx_cache, monkeypatch):
    fake = _FakeTrtRtx(monkeypatch)

    assert np_inference._trt_rtx_session(rtx_cache) is not None
    body = Path(fake.loaded[0])
    written = body.stat().st_mtime_ns
    assert np_inference._trt_rtx_session(rtx_cache) is not None

    assert body.stat().st_mtime_ns == written
    assert "ScatterElements" not in {n.op_type for n in onnx.load(str(body)).graph.node}
    devices, options = fake.provider_options[0]
    assert devices == ["rtx-device"]
    assert Path(options["nv_runtime_cache_path"]).is_dir()


def test_trt_rtx_session_is_none_without_a_device(rtx_cache, monkeypatch):
    monkeypatch.delenv("UTAI_SEP_TRT", raising=False)
    monkeypatch.setattr(onnx_cuda, "trt_rtx_devices", lambda: [])
    assert np_inference._trt_rtx_session(rtx_cache) is None


def test_trt_rtx_session_leaves_no_cache_without_a_device(rtx_cache, monkeypatch):
    monkeypatch.delenv("UTAI_SEP_TRT", raising=False)
    monkeypatch.setattr(onnx_cuda, "trt_rtx_devices", lambda: [])
    np_inference._trt_rtx_session(rtx_cache)
    assert not (settings.cache_dir / "tensorrt_rtx").exists()


def test_trt_rtx_session_is_none_when_the_build_fails_and_rebuilds_its_body(rtx_cache, monkeypatch):
    _FakeTrtRtx(monkeypatch, error=RuntimeError("engine build failed"))
    assert np_inference._trt_rtx_session(rtx_cache) is None
    assert not list((settings.cache_dir / "tensorrt_rtx").rglob("body.onnx"))


def _separator_yaml(path) -> None:
    path.write_text("model: {num_bands: 60}\ntraining: {instruments: [vocals]}\n", encoding="utf-8")


def _fake_session(*providers):
    return SimpleNamespace(get_providers=lambda: list(providers), get_inputs=lambda: [SimpleNamespace(name="x")])


@pytest.mark.parametrize(
    ("trt_rtx", "explicit", "bound"),
    [
        (_fake_session(TRT_RTX, CPU), None, TRT_RTX),
        (None, None, DML),
        (_fake_session(TRT_RTX, CPU), [DML, CPU], DML),
    ],
)
def test_separator_prefers_trt_rtx_unless_providers_are_pinned(trt_rtx, explicit, bound, tmp_path, monkeypatch):
    config = tmp_path / "config.yaml"
    _separator_yaml(config)
    monkeypatch.setattr(np_inference, "_separation_providers", lambda _path: [DML, CPU])
    monkeypatch.setattr(np_inference, "_trt_rtx_session", lambda _path: trt_rtx)
    monkeypatch.setattr(np_inference, "_ort_session", lambda _path, _providers: _fake_session(DML, CPU))

    sep = np_inference.NumpySeparator(tmp_path / "model.onnx", config, providers=explicit)

    assert sep.session.get_providers()[0] == bound


def test_trt_rtx_bound_separator_stays_on_numpy_stft(monkeypatch):
    sep = np_inference.NumpySeparator.__new__(np_inference.NumpySeparator)
    sep.session = _fake_session(TRT_RTX, CPU)
    sep._providers = [CPU]
    sep._in = "stft_repr"
    monkeypatch.setenv("UTAI_SEP_FOLD_STFT", "1")
    assert sep._build_fold(64, 16, 8, 1, 2, np.hanning(64).astype(np.float32)) is None


def test_trt_rtx_session_is_none_when_nothing_landed_on_the_ep(rtx_cache, monkeypatch):
    _FakeTrtRtx(monkeypatch, bound=(CPU,))
    assert np_inference._trt_rtx_session(rtx_cache) is None


def test_trt_rtx_respects_the_tensorrt_opt_out(rtx_cache, monkeypatch):
    fake = _FakeTrtRtx(monkeypatch)
    monkeypatch.setenv("UTAI_SEP_TRT", "0")
    assert np_inference._trt_rtx_session(rtx_cache) is None
    assert fake.loaded == []


def test_trt_rtx_devices_is_empty_without_the_plugin(monkeypatch):
    monkeypatch.setattr(onnx_cuda, "_trt_rtx_loaded", None)
    monkeypatch.setitem(sys.modules, "onnxruntime_ep_nv_tensorrt_rtx", None)
    assert onnx_cuda.trt_rtx_devices() == []


def test_trt_rtx_devices_never_raises_for_a_backend_start_without_onnxruntime(monkeypatch):
    monkeypatch.setattr(onnx_cuda, "_trt_rtx_loaded", None)
    monkeypatch.setitem(sys.modules, "onnxruntime", None)
    assert onnx_cuda.trt_rtx_devices() == []


def test_trt_rtx_devices_never_raises_when_enumeration_fails(monkeypatch):
    def broken():
        raise RuntimeError("driver oddity")

    monkeypatch.setattr(onnx_cuda, "_trt_rtx_loaded", True)
    monkeypatch.setattr(ort, "get_ep_devices", broken, raising=False)
    assert onnx_cuda.trt_rtx_devices() == []


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


@pytest.mark.parametrize("ep", [DML, TRT_RTX])
def test_dml_and_trt_rtx_sessions_skip_arena_shrinking(ep):
    skipped = onnx_cuda.release_arena_run_options(SimpleNamespace(get_providers=lambda: [ep, CPU]))
    with pytest.raises(RuntimeError, match="does not have configuration"):
        skipped.get_run_config_entry(SHRINK)
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
    assert markers["onnxruntime-ep-nv-tensorrt-rtx-cu13"] == "sys_platform == 'win32'"
    for package in ("onnxruntime-gpu", "nvidia-cublas-cu12", "nvidia-cudnn-cu12", "tensorrt-cu12"):
        assert markers[package] == "sys_platform == 'linux'"
