"""ORT memory knobs: the CUDA EP options `default_providers` attaches, and the
arena-release RunOptions every model passes on a job's final run (a malformed
shrink spec makes ORT fail the run, so this drives a real session)."""

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

from app.pipeline import onnx_cuda

CUDA = "CUDAExecutionProvider"
CPU = "CPUExecutionProvider"


def test_cuda_gets_memory_options(monkeypatch):
    monkeypatch.setattr(ort, "get_available_providers", lambda: [CPU, "TensorrtExecutionProvider", CUDA])
    assert onnx_cuda.default_providers() == [
        (CUDA, {"arena_extend_strategy": "kSameAsRequested", "cudnn_conv_use_max_workspace": "0"}),
        CPU,
    ]


def test_cpu_only_stays_plain(monkeypatch):
    monkeypatch.setattr(ort, "get_available_providers", lambda: [CPU])
    assert onnx_cuda.default_providers() == [CPU]


def test_release_options_run_on_cpu_session():
    graph = helper.make_graph(
        [helper.make_node("Relu", ["x"], ["y"])],
        "relu",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, ["n"])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, ["n"])],
    )
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)])
    model.ir_version = 8
    onnx.checker.check_model(model)
    sess = ort.InferenceSession(model.SerializeToString(), providers=[CPU])
    x = np.array([-1.0, 2.0], np.float32)
    out = sess.run(None, {"x": x}, onnx_cuda.release_arena_run_options(sess))[0]
    assert out.tolist() == [0.0, 2.0]
