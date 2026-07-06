"""`_to_mixed_int8` compresses MatMul/Gemm weights to int8-on-disk (DequantizeLinear ->
Cast(fp16)) while leaving non-weight fp16 constants (e.g. rotary tables feeding Mul) alone,
and stays numerically faithful. Pure onnx graph surgery -- no GPU, no model run."""

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

from app.pipeline.separation.export import _to_mixed_int8

K, N = 128, 64  # weight sizes >= the 4096-element quantization floor


def _fp16(name, arr):
    return numpy_helper.from_array(arr.astype(np.float16), name)


def _build(path):
    rng = np.random.default_rng(0)
    w = {
        "w_mm": (rng.standard_normal((K, N)) * 0.1),    # MatMul weight
        "w_gemm": (rng.standard_normal((N, K)) * 0.1),  # Gemm B weight
        "w_mul": (rng.standard_normal((K, N)) * 0.1),   # rotary-like constant: must stay fp16
    }
    nodes = [
        helper.make_node("MatMul", ["x", "w_mm"], ["h"]),
        helper.make_node("Mul", ["h", "w_mul"], ["hm"]),
        helper.make_node("Gemm", ["hm", "w_gemm"], ["y"], transB=0),
    ]
    g = helper.make_graph(
        nodes, "g",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT16, [K, K])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT16, [K, K])],
        initializer=[_fp16(n, a) for n, a in w.items()],
    )
    m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)])
    onnx.save(m, str(path))
    return w


def test_int8_quantizes_matmul_and_gemm_weights_not_constants(tmp_path):
    path = tmp_path / "m.onnx"
    orig = _build(path)
    _to_mixed_int8(path)

    m = onnx.load(str(path))
    onnx.checker.check_model(m)
    inits = {i.name: i for i in m.graph.initializer}
    ops = [n.op_type for n in m.graph.node]

    # both linear weights -> int8 + DequantizeLinear -> Cast(fp16); the Mul constant untouched
    assert inits["w_mm_i8"].data_type == TensorProto.INT8
    assert inits["w_gemm_i8"].data_type == TensorProto.INT8
    assert "w_mul_i8" not in inits and inits["w_mul"].data_type == TensorProto.FLOAT16
    assert ops.count("DequantizeLinear") == 2
    assert ops.count("Cast") == 2

    # the DQ output feeds the matmul as fp16 (opset-17 DQ emits fp32 -> Cast to fp16)
    cast = next(n for n in m.graph.node if n.op_type == "Cast")
    assert cast.attribute[0].i == TensorProto.FLOAT16

    # per-tensor symmetric int8 round-trips the fp16 weight within its coarse error
    for base in ("w_mm", "w_gemm"):
        q = numpy_helper.to_array(inits[base + "_i8"]).astype(np.float32)
        sc = float(numpy_helper.to_array(inits[base + "_sc"]))
        assert numpy_helper.to_array(inits[base + "_zp"]) == 0  # symmetric: TRT needs zero_point 0
        deq = q * sc
        rel = np.abs(deq - orig[base]).max() / np.abs(orig[base]).max()
        assert rel < 0.02, f"{base} dequant rel err {rel}"


def test_int8_skips_small_weights(tmp_path):
    """Sub-4096-element weights stay fp16 (int8 overhead not worth it)."""
    path = tmp_path / "s.onnx"
    small = (np.random.default_rng(0).standard_normal((16, 16)) * 0.1)  # 256 elems
    g = helper.make_graph(
        [helper.make_node("MatMul", ["x", "w"], ["y"])], "g",
        [helper.make_tensor_value_info("x", TensorProto.FLOAT16, [16, 16])],
        [helper.make_tensor_value_info("y", TensorProto.FLOAT16, [16, 16])],
        initializer=[_fp16("w", small)],
    )
    onnx.save(helper.make_model(g, opset_imports=[helper.make_opsetid("", 17)]), str(path))
    _to_mixed_int8(path)
    inits = {i.name for i in onnx.load(str(path)).graph.initializer}
    assert "w" in inits and "w_i8" not in inits
