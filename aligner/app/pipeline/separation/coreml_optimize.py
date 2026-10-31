"""Rewrite a separation ONNX graph so EVERY op is covered by the CoreML EP
(MLProgram), for fast on-device (ANE) inference on macOS.

The Roformer's exported graph uses ops the CoreML EP has no builder for --
`ReduceL2` (RMSNorm), `Einsum` (band-feature outer product), `Neg` (rotary
rotate-half), `Expand` (broadcast) -- plus rotary `Cos`/`Sin` and dynamic-shape
machinery. Each unsupported op is a partition cut, so the model would shred into
hundreds of tiny CoreML islands bridged by CPU nodes -- often slower than pure
CPU. This pass eliminates all of them:

  1. onnx-simplifier (with the input shape pinned) folds the static-shape-derived
     ops -- rotary tables, `Where`/`Equal`/`ConstantOfShape`, most `Cos`/`Sin` --
     into constants.
  2. Structural rewrites replace the remaining unsupported ops with CoreML-native
     equivalents (all exact identities):
       ReduceL2(x, axes) -> Sqrt(ReduceSum(Mul(x, x), axes))
       Einsum('...,f->...f', A, B) -> Mul(Unsqueeze(A, -1), B)
       Neg(x) -> Mul(x, -1)
       Expand(x, shape) -> dropped (consumers broadcast x themselves)
       ScatterElements(0, idx, upd, add) -> MatMul(upd, one-hot(idx)) (mel-band merge)
       Flatten(x, axis) -> Reshape(x, static 2-D shape) (no MLProgram builder)
       Pow(x, 2) -> Mul(x, x) (Pow is CoreML-native only at fp32)
  3. A second onnx-simplifier pass cleans up now-dead Shape nodes.

Verified numerically identical to the original on CPU (max|Δ| ~2e-6). The `coreml_optimize`
pass is build-time only (needs onnx-simplifier, a dev dep). The module's other runtime
users: DirectML and TensorRT-RTX sessions apply `rewrite_scatter_add_as_gather` at load,
and TensorRT-RTX `decode_weights_once`.
"""

from __future__ import annotations

import math
from collections import Counter
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def _axes_init(name: str, axes: list[int]) -> onnx.TensorProto:
    return helper.make_tensor(name, TensorProto.INT64, [len(axes)], axes)


def rewrite_reducel2(graph: onnx.GraphProto) -> int:
    """ReduceL2(x, axes, keepdims) -> Sqrt(ReduceSum(Mul(x, x), axes, keepdims))."""
    out, n = [], 0
    for node in graph.node:
        if node.op_type != "ReduceL2":
            out.append(node)
            continue
        x, y = node.input[0], node.output[0]
        axes = next((list(a.ints) for a in node.attribute if a.name == "axes"), [-1])
        keepdims = next((a.i for a in node.attribute if a.name == "keepdims"), 1)
        b = node.name or f"reducel2_{n}"
        graph.initializer.append(_axes_init(f"{b}/axes", axes))
        out.append(helper.make_node("Mul", [x, x], [f"{b}/sq"], name=f"{b}/Mul"))
        out.append(helper.make_node("ReduceSum", [f"{b}/sq", f"{b}/axes"], [f"{b}/sum"], name=f"{b}/ReduceSum", keepdims=keepdims))
        out.append(helper.make_node("Sqrt", [f"{b}/sum"], [y], name=f"{b}/Sqrt"))
        n += 1
    del graph.node[:]
    graph.node.extend(out)
    return n


def rewrite_einsum(graph: onnx.GraphProto) -> int:
    """Einsum('...,f->...f', A, B) -> Mul(Unsqueeze(A, -1), B) (outer product)."""
    out, n = [], 0
    for node in graph.node:
        if node.op_type != "Einsum":
            out.append(node)
            continue
        eq = next((a.s.decode().replace(" ", "") for a in node.attribute if a.name == "equation"), "")
        if eq != "...,f->...f":
            raise ValueError(f"coreml_optimize: unhandled Einsum equation {eq!r} in {node.name!r}")
        a_in, b_in, y = node.input[0], node.input[1], node.output[0]
        b = node.name or f"einsum_{n}"
        graph.initializer.append(_axes_init(f"{b}/axes", [-1]))
        out.append(helper.make_node("Unsqueeze", [a_in, f"{b}/axes"], [f"{b}/exp"], name=f"{b}/Unsqueeze"))
        out.append(helper.make_node("Mul", [f"{b}/exp", b_in], [y], name=f"{b}/Mul"))
        n += 1
    del graph.node[:]
    graph.node.extend(out)
    return n


def rewrite_neg(graph: onnx.GraphProto) -> int:
    """Neg(x) -> Mul(x, -1)."""
    negs = [node for node in graph.node if node.op_type == "Neg"]
    if not negs:
        return 0
    negone = "coreml_neg_one"
    graph.initializer.append(helper.make_tensor(negone, TensorProto.FLOAT, [], [-1.0]))
    out = []
    for node in graph.node:
        if node.op_type != "Neg":
            out.append(node)
            continue
        out.append(helper.make_node("Mul", [node.input[0], negone], [node.output[0]], name=(node.name or "neg") + "/Mul"))
    del graph.node[:]
    graph.node.extend(out)
    return len(negs)


def rewrite_expand_drop(graph: onnx.GraphProto) -> int:
    """Expand(x, shape) -> drop, rewiring consumers to x. Sound when the
    consumers broadcast x themselves (elementwise ops), which is how these
    Expands are used (broadcasting a norm before a Div, etc.). An Expand feeding
    a graph output is kept (dropping it would change the output shape)."""
    graph_outputs = {o.name for o in graph.output}
    rename = {
        node.output[0]: node.input[0]
        for node in graph.node
        if node.op_type == "Expand" and node.output[0] not in graph_outputs
    }
    if not rename:
        return 0

    def resolve(t: str) -> str:
        seen: set[str] = set()
        while t in rename and t not in seen:
            seen.add(t)
            t = rename[t]
        return t

    keep = [node for node in graph.node if not (node.op_type == "Expand" and node.output[0] in rename)]
    for node in keep:
        for i, inp in enumerate(node.input):
            if inp in rename:
                node.input[i] = resolve(inp)
    del graph.node[:]
    graph.node.extend(keep)
    return len(rename)


def rewrite_pow_square(graph: onnx.GraphProto) -> int:
    """Pow(x, 2) -> Mul(x, x). The CoreML EP takes Pow only with fp32 inputs, so in the
    fp16 body every norm's square would otherwise fall to the CPU."""
    inits = {i.name: i for i in graph.initializer}
    n = 0
    for node in graph.node:
        if node.op_type != "Pow" or node.input[1] not in inits:
            continue
        exponent = numpy_helper.to_array(inits[node.input[1]])
        if exponent.size != 1 or float(exponent) != 2.0:
            continue
        node.op_type = "Mul"
        node.input[1] = node.input[0]
        n += 1
    return n


def rewrite_flatten(graph: onnx.GraphProto) -> int:
    """Flatten(x, axis) -> Reshape(x, [prod(dims[:axis]), prod(dims[axis:])]), from x's
    static shape. The CoreML EP builds Flatten only for the NeuralNetwork format."""
    flattens = [node for node in graph.node if node.op_type == "Flatten"]
    if not flattens:
        return 0
    inferred = onnx.shape_inference.infer_shapes(_wrap(graph)).graph
    static: dict[str, list[int]] = {
        vi.name: [d.dim_value for d in vi.type.tensor_type.shape.dim]
        for vi in list(inferred.value_info) + list(inferred.input)
        if all(d.HasField("dim_value") for d in vi.type.tensor_type.shape.dim)
    }
    for i, node in enumerate(flattens):
        shape = static.get(node.input[0])
        if not shape:
            raise ValueError(f"coreml_optimize: Flatten {node.name!r} input has no static shape")
        axis = next((a.i for a in node.attribute if a.name == "axis"), 1) % len(shape)
        b = node.name or f"flatten_{i}"
        target = [math.prod(shape[:axis]), math.prod(shape[axis:])]
        graph.initializer.append(helper.make_tensor(f"{b}/shape", TensorProto.INT64, [2], target))
        node.op_type = "Reshape"
        node.input.append(f"{b}/shape")
        del node.attribute[:]
    return len(flattens)


def decode_weights_once(graph: onnx.GraphProto) -> int:
    """DequantizeLinear -> Cast(fp16) on constant per-tensor int8 weights -> a plain fp16
    initializer, so they decode here rather than on every run."""
    inits = {i.name: i for i in graph.initializer}
    casts = {n.input[0]: n for n in graph.node if n.op_type == "Cast"}
    consumers = Counter(i for n in graph.node for i in n.input)
    dropped: set[str] = set()
    for node in graph.node:
        cast = casts.get(node.output[0])
        if node.op_type != "DequantizeLinear" or cast is None or not all(i in inits for i in node.input):
            continue
        if consumers[node.output[0]] != 1:
            continue
        if next(a.i for a in cast.attribute if a.name == "to") != TensorProto.FLOAT16:
            continue
        weights, scale, zero = (numpy_helper.to_array(inits[i]) for i in node.input)
        decoded = (weights.astype(np.float32) - float(zero)) * float(scale)
        graph.initializer.append(numpy_helper.from_array(decoded.astype(np.float16), cast.output[0]))
        dropped.update((node.output[0], cast.output[0]))
    kept = [n for n in graph.node if n.output[0] not in dropped]
    del graph.node[:]
    graph.node.extend(kept)
    return len(dropped) // 2


def drop_unused_initializers(graph: onnx.GraphProto) -> int:
    used = {i for n in graph.node for i in n.input} | {o.name for o in graph.output}
    kept = [i for i in graph.initializer if i.name in used]
    dropped = len(graph.initializer) - len(kept)
    del graph.initializer[:]
    graph.initializer.extend(kept)
    return dropped


def _constant_add_scatter(node: onnx.NodeProto, inits: dict) -> tuple[np.ndarray, int, np.ndarray]:
    """(zeros, axis, each source's target along axis) of an add-scatter into zeros whose
    constant indices vary only along that axis."""
    data_name, idx_name, _ = node.input
    attrs = {a.name: helper.get_attribute_value(a) for a in node.attribute}
    if attrs.get("reduction") != b"add" or data_name not in inits or idx_name not in inits:
        raise ValueError(f"coreml_optimize: unhandled ScatterElements {node.name!r} (needs constant add-scatter)")
    data = numpy_helper.to_array(inits[data_name])
    idx = numpy_helper.to_array(inits[idx_name])
    axis = attrs.get("axis", 0) % idx.ndim
    rows = np.moveaxis(idx, axis, -1).reshape(-1, idx.shape[axis])
    same_off_axis = np.delete(idx.shape, axis).tolist() == np.delete(data.shape, axis).tolist()
    if np.any(data) or not same_off_axis or np.any(rows != rows[0]):
        raise ValueError(f"coreml_optimize: unhandled ScatterElements {node.name!r} (indices must vary only along axis {axis} into zeros)")
    return data, axis, rows[0] % data.shape[axis]


def rewrite_scatter_add_as_gather(graph: onnx.GraphProto) -> int:
    """ScatterElements(zeros, idx, upd, axis=a, reduction='add') (the mel-band overlap merge)
    -> pad `upd` with one zero source along `a`, then Gather + Add each target's sources."""
    inits = {i.name: i for i in graph.initializer}
    out, n = [], 0
    for node in graph.node:
        if node.op_type != "ScatterElements":
            out.append(node)
            continue
        data, axis, targets = _constant_add_scatter(node, inits)
        sources: list[list[int]] = [[] for _ in range(data.shape[axis])]
        for source, target in enumerate(targets.tolist()):
            sources[target].append(source)
        b = node.name or f"scatter_add_{n}"
        pad_shape = [1 if d == axis else s for d, s in enumerate(data.shape)]
        graph.initializer.append(numpy_helper.from_array(np.zeros(pad_shape, data.dtype), f"{b}/zero"))
        out.append(helper.make_node("Concat", [node.input[2], f"{b}/zero"], [f"{b}/padded"], name=f"{b}/Pad", axis=axis))
        total = None
        for k in range(max(len(s) for s in sources)):
            picks = np.array([s[k] if k < len(s) else len(targets) for s in sources], np.int64)
            graph.initializer.append(numpy_helper.from_array(picks, f"{b}/picks{k}"))
            out.append(helper.make_node("Gather", [f"{b}/padded", f"{b}/picks{k}"], [f"{b}/g{k}"], name=f"{b}/Gather{k}", axis=axis))
            if total is None:
                total = f"{b}/g{k}"
            else:
                out.append(helper.make_node("Add", [total, f"{b}/g{k}"], [f"{b}/s{k}"], name=f"{b}/Add{k}"))
                total = f"{b}/s{k}"
        out.append(helper.make_node("Identity", [total], [node.output[0]], name=f"{b}/Out"))
        n += 1
    del graph.node[:]
    graph.node.extend(out)
    return n


def rewrite_scatter_add(graph: onnx.GraphProto) -> int:
    """ScatterElements(zeros, idx, upd, axis=a, reduction='add') with constant indices
    that vary only along `a` (the mel-band overlap merge) -> Transpose `a` last, MatMul
    with the constant one-hot [J, F] matrix, Transpose back."""
    inits = {i.name: i for i in graph.initializer}
    out, n = [], 0
    for node in graph.node:
        if node.op_type != "ScatterElements":
            out.append(node)
            continue
        upd_name = node.input[2]
        data, axis, targets = _constant_add_scatter(node, inits)
        width = data.shape[axis]
        onehot = np.zeros((len(targets), width), np.float32)
        onehot[np.arange(len(targets)), targets] = 1.0
        fwd = [d for d in range(data.ndim) if d != axis] + [axis]
        b = node.name or f"scatter_add_{n}"
        graph.initializer.append(numpy_helper.from_array(onehot, f"{b}/onehot"))
        out.append(helper.make_node("Transpose", [upd_name], [f"{b}/t"], name=f"{b}/Transpose", perm=fwd))
        out.append(helper.make_node("MatMul", [f"{b}/t", f"{b}/onehot"], [f"{b}/sum"], name=f"{b}/MatMul"))
        out.append(helper.make_node("Transpose", [f"{b}/sum"], [node.output[0]], name=f"{b}/TransposeBack", perm=np.argsort(fwd).tolist()))
        n += 1
    del graph.node[:]
    graph.node.extend(out)
    return n


def _empty_tensors(model: onnx.ModelProto) -> set[str]:
    """Names of tensors with a statically-0 dimension (empty), from shape
    inference. CoreML rejects 0-dim shapes outright -- they come from the Roformer's
    rotary embedding, whose 'unrotated remainder' slice is empty when rot_dim == dim."""
    inferred = onnx.shape_inference.infer_shapes(model)
    empty = set()
    for vi in list(inferred.graph.value_info) + list(inferred.graph.input) + list(inferred.graph.output):
        dims = vi.type.tensor_type.shape.dim
        if any(d.HasField("dim_value") and d.dim_value == 0 for d in dims):
            empty.add(vi.name)
    return empty


def prune_empty_concat_inputs(graph: onnx.GraphProto) -> int:
    """Drop statically-empty (0-size) inputs from Concat nodes -- concatenating
    an empty tensor contributes nothing, so this is exact, and it removes the
    0-dim tensors that CoreML rejects. Any Concat left with a single input is a
    valid no-op the following onnx-
    simplifier pass folds away, along with the now-dead Slices that produced the
    empty tensors. (Exact -- verified by the numeric check.)"""
    empty = _empty_tensors(_wrap(graph))  # shape inference needs a full model
    if not empty:
        return 0
    dropped = 0
    for node in graph.node:
        if node.op_type != "Concat":
            continue
        kept = [i for i in node.input if i not in empty]
        if kept and len(kept) != len(node.input):
            dropped += len(node.input) - len(kept)
            del node.input[:]
            node.input.extend(kept)
    return dropped


def _wrap(graph: onnx.GraphProto) -> onnx.ModelProto:
    """Wrap a graph in a minimal opset-17 model for shape inference."""
    return onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)])


def coreml_optimize(onnx_path: str | Path, input_shapes: dict[str, list[int]]) -> None:
    """Rewrite the ONNX at `onnx_path` in place so every op is CoreML-native.
    `input_shapes` pins each input to its fixed shape for onnx-simplifier's
    shape folding (the separation bodies are fixed-shape)."""
    import onnxsim

    onnx_path = str(onnx_path)
    model = onnx.load(onnx_path)
    model, ok = onnxsim.simplify(model, overwrite_input_shapes=input_shapes)
    if not ok:
        raise RuntimeError(f"coreml_optimize: onnx-simplifier validation failed for {onnx_path}")
    rewrite_reducel2(model.graph)
    rewrite_einsum(model.graph)
    rewrite_neg(model.graph)
    rewrite_expand_drop(model.graph)
    rewrite_scatter_add(model.graph)
    rewrite_flatten(model.graph)
    rewrite_pow_square(model.graph)
    # Second pass: prune the now-dead Shape nodes the dropped Expands fed, and
    # concretise shapes so the empty-tensor pass below can see the 0-dim slices.
    model, ok = onnxsim.simplify(model, overwrite_input_shapes=input_shapes)
    if not ok:
        raise RuntimeError(f"coreml_optimize: onnx-simplifier cleanup failed for {onnx_path}")
    prune_empty_concat_inputs(model.graph)
    # Final pass: drop the Slices that produced the now-orphaned empty tensors.
    model, ok = onnxsim.simplify(model, overwrite_input_shapes=input_shapes)
    if not ok:
        raise RuntimeError(f"coreml_optimize: onnx-simplifier final pass failed for {onnx_path}")
    model = onnx.shape_inference.infer_shapes(model)
    onnx.checker.check_model(model)
    onnx.save(model, onnx_path)
