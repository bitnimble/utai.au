"""CoreML sessions keep MatMul+Add unfused: the CoreML EP writes a fused Gemm's weights
into model.mil as text. onnxruntime ignores an unknown optimizer name, so a rename upstream
would silently bring the 2.7 GB model.mil back."""

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper

from app.pipeline.separation import np_inference


def _matmul_add_model(path) -> None:
    graph = helper.make_graph(
        [helper.make_node("MatMul", ["x", "w"], ["m"]), helper.make_node("Add", ["m", "b"], ["y"])],
        "linear",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT, [2, 3])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT, [2, 4])],
        [
            numpy_helper.from_array(np.ones((3, 4), np.float32), "w"),
            numpy_helper.from_array(np.ones(4, np.float32), "b"),
        ],
    )
    onnx.save(helper.make_model(graph, opset_imports=[helper.make_opsetid("", 17)]), path)


def _optimized_ops(model, tmp_path, disabled_optimizers) -> set[str]:
    optimized = tmp_path / "optimized.onnx"
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
    options.optimized_model_filepath = str(optimized)
    ort.InferenceSession(
        str(model), options, providers=["CPUExecutionProvider"], disabled_optimizers=disabled_optimizers
    )
    return {node.op_type for node in onnx.load(optimized).graph.node}


def test_the_disabled_optimizer_is_the_one_that_makes_gemms(tmp_path):
    model = tmp_path / "model.onnx"
    _matmul_add_model(model)

    assert "Gemm" in _optimized_ops(model, tmp_path, None)
    assert _optimized_ops(model, tmp_path, ["MatMulAddFusion"]) == {"MatMul", "Add"}


def test_only_coreml_sessions_disable_it(tmp_path, monkeypatch):
    model = tmp_path / "model.onnx"
    _matmul_add_model(model)
    disabled = []
    real_session = ort.InferenceSession

    def spy(path, **kwargs):
        disabled.append(kwargs["disabled_optimizers"])
        return real_session(path, sess_options=kwargs["sess_options"], providers=["CPUExecutionProvider"])

    monkeypatch.setattr(ort, "InferenceSession", spy)

    np_inference._ort_session(model, [("CoreMLExecutionProvider", {}), "CPUExecutionProvider"])
    np_inference._ort_session(model, ["CPUExecutionProvider"])

    assert disabled == [["MatMulAddFusion"], None]
