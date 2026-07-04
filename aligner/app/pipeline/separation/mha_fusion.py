"""Fuse the naive SDPA decomposition into `com.microsoft.MultiHeadAttention`.

`torch.onnx.export(dynamo=False)` lowers `F.scaled_dot_product_attention` to a
naive `MatMul -> Softmax -> MatMul`, which materializes the full
`(batch, heads, seq, seq)` score matrix -- O(seq^2) memory. At seq~1101 that is
the multi-GB fp16 activation peak that blows a memory-constrained CUDA GPU's
VRAM (WDDM then pages -> ~15s/chunk). `com.microsoft.MultiHeadAttention`'s CUDA
kernel uses flash / CUTLASS memory-efficient attention (online softmax, O(seq)
memory), so replacing the naive block with one MHA node removes that peak.

CUDA / CPU-EP ONLY. The CoreML EP has no MHA kernel, so this must NOT be applied
to the macOS model (it would fall to the CPU EP, which can't run fp16). It's a
sibling of `coreml_optimize` for the CUDA/DirectML path.

Matches the exact subgraph the legacy exporter emits for the mask-less,
default-scale SDPA the separators use:

    Mul(q, s) --------\
                       MatMul -> Softmax(axis=-1) -> MatMul(.,v) -> out
    Mul(Transpose(k), s) /

where `s = sqrt(1/sqrt(head_size))` multiplies BOTH q and k^T, so the scores
carry the `1/sqrt(head_size)` SDPA default -- identical to MHA's default scale.
So the scale Muls are dropped and raw q/k feed MHA. Numerically exact (verified
on the CPU EP, which also has an MHA kernel).
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

import onnx
from onnx import TensorProto, helper


def _topological_sort(nodes: list) -> list:
    """Order `nodes` so every producer precedes its consumers (Kahn's). Needed
    because the fusion appends replacement nodes at the end, which onnxruntime
    tolerates (it re-sorts) but onnx-simplifier / onnx.checker reject."""
    producer = {o: n for n in nodes for o in n.output}
    preds: dict[int, set[int]] = {id(n): set() for n in nodes}
    succs: dict[int, list] = {id(n): [] for n in nodes}
    for n in nodes:
        for inp in n.input:
            p = producer.get(inp)
            if p is not None and id(p) != id(n) and id(p) not in preds[id(n)]:
                preds[id(n)].add(id(p))
                succs[id(p)].append(n)
    indeg = {id(n): len(preds[id(n)]) for n in nodes}
    q = deque(n for n in nodes if indeg[id(n)] == 0)
    out = []
    while q:
        n = q.popleft()
        out.append(n)
        for c in succs[id(n)]:
            indeg[id(c)] -= 1
            if indeg[id(c)] == 0:
                q.append(c)
    if len(out) != len(nodes):  # cycle (shouldn't happen) -> stable fallback
        seen = {id(n) for n in out}
        out.extend(n for n in nodes if id(n) not in seen)
    return out


def _wrap(graph: onnx.GraphProto) -> onnx.ModelProto:
    return onnx.helper.make_model(graph, opset_imports=[onnx.helper.make_opsetid("", 17)])


def _int64_init(name: str, vals: list[int]) -> onnx.TensorProto:
    return helper.make_tensor(name, TensorProto.INT64, [len(vals)], vals)


def _shapes(graph: onnx.GraphProto) -> dict[str, list[int]]:
    inferred = onnx.shape_inference.infer_shapes(_wrap(graph))
    out: dict[str, list[int]] = {}
    for vi in list(inferred.graph.value_info) + list(inferred.graph.input) + list(inferred.graph.output):
        out[vi.name] = [d.dim_value if d.HasField("dim_value") else -1 for d in vi.type.tensor_type.shape.dim]
    return out


def _other(node: onnx.NodeProto, name: str) -> str:
    """The input of a 2-input node that isn't `name`."""
    return node.input[1] if node.input[0] == name else node.input[0]


def fuse_attention_to_mha(graph: onnx.GraphProto) -> int:
    """Rewrite every naive-SDPA block into a MultiHeadAttention node. Returns the
    number fused. Skips (leaves naive) any block that doesn't match exactly, so a
    mismatch is never silently miscompiled -- the numeric check catches errors."""
    shapes = _shapes(graph)
    producer = {o: n for n in graph.node for o in n.output}
    consumers: dict[str, list[onnx.NodeProto]] = {}
    for n in graph.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)

    def unscaled(mul: onnx.NodeProto) -> str | None:
        """The non-Sqrt input of a scale Mul (the raw q or the transposed k)."""
        if mul is None or mul.op_type != "Mul":
            return None
        cands = [i for i in mul.input if not (producer.get(i) and producer[i].op_type == "Sqrt")]
        return cands[0] if len(cands) == 1 else None

    remove: set[int] = set()
    add: list[onnx.NodeProto] = []
    fused = 0
    for sm in graph.node:
        if sm.op_type != "Softmax":
            continue
        if next((a.i for a in sm.attribute if a.name == "axis"), -1) not in (-1, 3):
            continue
        m1 = producer.get(sm.input[0])
        if not m1 or m1.op_type != "MatMul":
            continue
        mulq, mulk = producer.get(m1.input[0]), producer.get(m1.input[1])
        q, kt = unscaled(mulq), unscaled(mulk)
        if q is None or kt is None:
            continue
        tk = producer.get(kt)
        if not tk or tk.op_type != "Transpose":
            continue
        perm = next((list(a.ints) for a in tk.attribute if a.name == "perm"), None)
        if not perm or len(perm) != 4 or perm[-2:] != [3, 2]:
            continue
        k = tk.input[0]
        m2 = next((c for c in consumers.get(sm.output[0], []) if c.op_type == "MatMul"), None)
        if not m2:
            continue
        v = _other(m2, sm.output[0])
        out = m2.output[0]
        qsh = shapes.get(q)
        if not qsh or len(qsh) != 4 or qsh[1] <= 0 or qsh[3] <= 0:
            continue
        heads, head_size = qsh[1], qsh[3]

        base = (sm.name or f"attn{fused}").replace("/", "_").strip("_")
        b3: dict[str, str] = {}
        for src, tag in [(q, "q"), (k, "k"), (v, "v")]:
            t, sh, dst = f"{base}/{tag}t", f"{base}/{tag}sh", f"{base}/{tag}3"
            add.append(helper.make_node("Transpose", [src], [t], name=f"{base}/{tag}T", perm=[0, 2, 1, 3]))
            graph.initializer.append(_int64_init(sh, [0, 0, -1]))
            add.append(helper.make_node("Reshape", [t, sh], [dst], name=f"{base}/{tag}R"))
            b3[tag] = dst
        mha = f"{base}/mha"
        add.append(helper.make_node(
            "MultiHeadAttention", [b3["q"], b3["k"], b3["v"], "", "", "", "", ""], [mha],
            name=f"{base}/MHA", domain="com.microsoft", num_heads=heads))
        graph.initializer.append(_int64_init(f"{base}/osh", [0, 0, heads, head_size]))
        add.append(helper.make_node("Reshape", [mha, f"{base}/osh"], [f"{base}/o4"], name=f"{base}/oR"))
        add.append(helper.make_node("Transpose", [f"{base}/o4"], [out], name=f"{base}/oT", perm=[0, 2, 1, 3]))
        for n in (mulq, mulk, tk, m1, sm, m2):
            remove.add(id(n))
        fused += 1

    if fused:
        kept = [n for n in graph.node if id(n) not in remove]
        ordered = _topological_sort(kept + add)
        del graph.node[:]
        graph.node.extend(ordered)
    return fused


def mha_optimize(onnx_path: str | Path, input_shapes: dict[str, list[int]]) -> int:
    """Rewrite the ONNX at `onnx_path` in place, fusing naive attention into
    `com.microsoft.MultiHeadAttention` for O(seq)-memory attention on the CUDA /
    DirectML EP. Returns the number of blocks fused. Mirrors `coreml_optimize`
    (the macOS sibling); `input_shapes` pins each input for onnx-simplifier's
    shape folding. CUDA / CPU-EP ONLY -- must NOT be applied to the macOS model
    (MHA has no CoreML kernel). Pair with `session.enable_mem_pattern = False`,
    or ORT's memory planner pre-reserves the eliminated score matrices anyway."""
    import onnxsim

    onnx_path = str(onnx_path)
    model = onnx.load(onnx_path)
    fused = fuse_attention_to_mha(model.graph)
    if fused and not any(o.domain == "com.microsoft" for o in model.opset_import):
        model.opset_import.append(helper.make_opsetid("com.microsoft", 1))
    model, ok = onnxsim.simplify(model, overwrite_input_shapes=input_shapes)
    if not ok:
        raise RuntimeError(f"mha_optimize: onnx-simplifier validation failed for {onnx_path}")
    onnx.save(model, onnx_path)
    return fused
