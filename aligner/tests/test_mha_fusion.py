"""The MHA fusion must be a numerically-exact rewrite of the naive SDPA block.
Builds the exact subgraph the legacy exporter emits (scale via Sqrt applied to
q and k^T), fuses it, and checks the CPU-EP output is unchanged."""

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper

from app.pipeline.separation.mha_fusion import fuse_attention_to_mha

B, H, S, D = 1, 4, 16, 8
SCALE = 1.0 / np.sqrt(D)


def _run(model: onnx.ModelProto, feeds: dict) -> np.ndarray:
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL
    s = ort.InferenceSession(model.SerializeToString(), so, providers=["CPUExecutionProvider"])
    return s.run(None, feeds)[0]


def _vi(name, shape):
    return helper.make_tensor_value_info(name, TensorProto.FLOAT, shape)


def _naive_sdpa_model() -> onnx.ModelProto:
    # Mirrors torch.onnx.export(dynamo=False) of F.scaled_dot_product_attention:
    # s = sqrt(1/sqrt(D)) multiplies BOTH q and transpose(k).
    c = helper.make_tensor("c", TensorProto.FLOAT, [], [SCALE])
    nodes = [
        helper.make_node("Sqrt", ["c"], ["s"]),
        helper.make_node("Mul", ["q", "s"], ["mq"]),
        helper.make_node("Transpose", ["k"], ["kt"], perm=[0, 1, 3, 2]),
        helper.make_node("Mul", ["kt", "s"], ["mk"]),
        helper.make_node("MatMul", ["mq", "mk"], ["qk"]),
        helper.make_node("Softmax", ["qk"], ["attn"], axis=-1),
        helper.make_node("MatMul", ["attn", "v"], ["out"]),
    ]
    g = helper.make_graph(nodes, "g",
                          [_vi("q", [B, H, S, D]), _vi("k", [B, H, S, D]), _vi("v", [B, H, S, D])],
                          [_vi("out", [B, H, S, D])], initializer=[c])
    return helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])


def test_mha_fusion_is_numerically_exact():
    m = _naive_sdpa_model()
    rng = np.random.default_rng(0)
    feeds = {n: rng.standard_normal((B, H, S, D)).astype(np.float32) for n in ("q", "k", "v")}
    y0 = _run(m, feeds)

    assert fuse_attention_to_mha(m.graph) == 1
    assert not any(n.op_type == "Softmax" for n in m.graph.node)
    assert sum(n.op_type == "MultiHeadAttention" for n in m.graph.node) == 1
    m.opset_import.append(helper.make_opsetid("com.microsoft", 1))

    y1 = _run(m, feeds)
    assert np.allclose(y0, y1, atol=1e-4), f"max|Δ|={np.max(np.abs(y0 - y1))}"


def test_fusion_noop_without_attention():
    add = helper.make_node("Add", ["a", "b"], ["out"])
    g = helper.make_graph([add], "g", [_vi("a", [2, 3]), _vi("b", [2, 3])], [_vi("out", [2, 3])])
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    assert fuse_attention_to_mha(m.graph) == 0
