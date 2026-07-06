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
  2. Four structural rewrites replace the activation-dependent unsupported ops
     with CoreML-native equivalents (all exact identities):
       ReduceL2(x, axes) -> Sqrt(ReduceSum(Mul(x, x), axes))
       Einsum('...,f->...f', A, B) -> Mul(Unsqueeze(A, -1), B)
       Neg(x) -> Mul(x, -1)
       Expand(x, shape) -> dropped (consumers broadcast x themselves)
  3. A second onnx-simplifier pass cleans up now-dead Shape nodes.

Verified numerically identical to the original on CPU (max|Δ| ~2e-6). Build-time
only (needs onnx-simplifier, a dev dep); the shipped runtime never imports this.
"""

from __future__ import annotations

from pathlib import Path

import onnx
from onnx import TensorProto, helper


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
