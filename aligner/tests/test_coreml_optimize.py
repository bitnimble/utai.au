"""The CoreML graph rewrites (coreml_optimize) must be exact identities. Each
builds a tiny graph with the unsupported op, applies the rewrite, and asserts
the rewritten graph produces identical output on the CPU EP -- and that the
target op is gone. onnxsim (the folding orchestration) isn't exercised here; the
end-to-end fold+rewrite is validated against the real model at export time."""

import numpy as np
import onnx
import onnxruntime as ort
import pytest
from onnx import TensorProto, helper

from app.pipeline.separation.coreml_optimize import (
    prune_empty_concat_inputs,
    rewrite_einsum,
    rewrite_expand_drop,
    rewrite_neg,
    rewrite_reducel2,
)


def _run(model: onnx.ModelProto, feeds: dict) -> np.ndarray:
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    sess = ort.InferenceSession(model.SerializeToString(), so, providers=["CPUExecutionProvider"])
    return sess.run(None, feeds)[0]


def _model(nodes, inputs, outputs, inits=None) -> onnx.ModelProto:
    g = helper.make_graph(nodes, "g", inputs, outputs, initializer=inits or [])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    onnx.checker.check_model(m)
    return m


def _vi(name, shape):
    return helper.make_tensor_value_info(name, TensorProto.FLOAT, shape)


def _assert_equivalent(model, rewrite, feeds, gone_op):
    y0 = _run(model, feeds)
    n = rewrite(model.graph)
    assert n > 0
    onnx.checker.check_model(model)
    assert all(node.op_type != gone_op for node in model.graph.node)
    y1 = _run(model, feeds)
    assert np.allclose(y0, y1, atol=1e-5), f"{gone_op}: max|Δ|={np.max(np.abs(y0 - y1))}"


def test_reducel2_rewrite_is_exact():
    node = helper.make_node("ReduceL2", ["x"], ["y"], axes=[-1], keepdims=1)
    model = _model([node], [_vi("x", [2, 3, 4])], [_vi("y", [2, 3, 1])])
    x = np.random.default_rng(0).standard_normal((2, 3, 4)).astype(np.float32)
    _assert_equivalent(model, rewrite_reducel2, {"x": x}, "ReduceL2")


def test_einsum_outer_product_rewrite_is_exact():
    node = helper.make_node("Einsum", ["a", "b"], ["y"], equation="...,f->...f")
    model = _model([node], [_vi("a", [2, 3]), _vi("b", [4])], [_vi("y", [2, 3, 4])])
    rng = np.random.default_rng(1)
    feeds = {"a": rng.standard_normal((2, 3)).astype(np.float32), "b": rng.standard_normal(4).astype(np.float32)}
    _assert_equivalent(model, rewrite_einsum, feeds, "Einsum")


def test_einsum_unhandled_equation_raises():
    node = helper.make_node("Einsum", ["a", "b"], ["y"], equation="ij,jk->ik")
    model = _model([node], [_vi("a", [2, 3]), _vi("b", [3, 4])], [_vi("y", [2, 4])])
    with pytest.raises(ValueError, match="unhandled Einsum"):
        rewrite_einsum(model.graph)


def test_neg_rewrite_is_exact():
    node = helper.make_node("Neg", ["x"], ["y"])
    model = _model([node], [_vi("x", [2, 3])], [_vi("y", [2, 3])])
    x = np.random.default_rng(2).standard_normal((2, 3)).astype(np.float32)
    _assert_equivalent(model, rewrite_neg, {"x": x}, "Neg")


def test_expand_drop_is_exact_when_consumer_broadcasts():
    # Expand(x, [2,3]) then Add(expanded, y): dropping Expand leaves Add(x, y),
    # which broadcasts x[2,1] against y[2,3] to the same result.
    shape = helper.make_tensor("shp", TensorProto.INT64, [2], [2, 3])
    expand = helper.make_node("Expand", ["x", "shp"], ["e"])
    add = helper.make_node("Add", ["e", "y"], ["out"])
    model = _model([expand, add], [_vi("x", [2, 1]), _vi("y", [2, 3])], [_vi("out", [2, 3])], inits=[shape])
    rng = np.random.default_rng(3)
    feeds = {"x": rng.standard_normal((2, 1)).astype(np.float32), "y": rng.standard_normal((2, 3)).astype(np.float32)}
    _assert_equivalent(model, rewrite_expand_drop, feeds, "Expand")


def test_expand_feeding_graph_output_is_kept():
    shape = helper.make_tensor("shp", TensorProto.INT64, [2], [2, 3])
    expand = helper.make_node("Expand", ["x", "shp"], ["out"])
    model = _model([expand], [_vi("x", [2, 1])], [_vi("out", [2, 3])], inits=[shape])
    assert rewrite_expand_drop(model.graph) == 0
    assert any(node.op_type == "Expand" for node in model.graph.node)


def test_prune_empty_concat_input_is_exact():
    # Concat(a[2,3], b[2,0]) == a: the empty input contributes nothing, so
    # dropping it leaves a valid 1-input Concat with identical output.
    concat = helper.make_node("Concat", ["a", "b"], ["out"], axis=1)
    model = _model([concat], [_vi("a", [2, 3]), _vi("b", [2, 0])], [_vi("out", [2, 3])])
    rng = np.random.default_rng(4)
    feeds = {"a": rng.standard_normal((2, 3)).astype(np.float32), "b": np.zeros((2, 0), np.float32)}
    y0 = _run(model, feeds)
    assert prune_empty_concat_inputs(model.graph) == 1
    onnx.checker.check_model(model)
    assert list(next(n for n in model.graph.node if n.op_type == "Concat").input) == ["a"]
    assert np.allclose(y0, _run(model, feeds), atol=1e-5)


def test_prune_empty_noop_without_empty_tensors():
    concat = helper.make_node("Concat", ["a", "b"], ["out"], axis=1)
    model = _model([concat], [_vi("a", [2, 3]), _vi("b", [2, 1])], [_vi("out", [2, 4])])
    assert prune_empty_concat_inputs(model.graph) == 0
