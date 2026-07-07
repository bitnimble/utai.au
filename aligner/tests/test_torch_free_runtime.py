"""Build guard: the shipped ONNX runtime must import torch-free.

torch is an EXPORT/dev-only dependency (the one-time `.onnx` export + the
`UTAI_*_ONNX=0` A-B fallback); the runtime import graph must NEVER pull it in,
or the torch-free capability install / bundled sidecar breaks. Keep any torch
import lazy, inside the export/fallback branch (see the note in `separate.py`).

Runs in a SUBPROCESS so an unrelated test (or transformers) importing torch in
the main pytest process can't mask a regression here.
"""
from __future__ import annotations

import subprocess
import sys
import textwrap


def test_runtime_import_graph_is_torch_free():
    # Import every runtime entry point on the ONNX path, then assert torch never
    # reached sys.modules. A top-level `import torch` anywhere in that graph
    # (instead of a lazy import inside a fallback/export branch) trips this.
    probe = textwrap.dedent(
        """
        import os, sys
        os.environ["UTAI_SEP_ONNX"] = "1"
        os.environ["UTAI_LYRICS_ONNX"] = "1"
        import app.main                              # HTTP app (routes + pipeline graph)
        import app.sidecar                           # stdio sidecar entry
        import app.pipeline.separation.np_inference  # the ONNX separator
        import app.pipeline.lyrics_onnx              # the ONNX CTC aligner
        import app.pipeline.pitch.analyze            # the ONNX pitch stage (RMVPE)
        import app.pipeline.pitch.f0                 # the SwiftF0 extractor (live path)
        leaked = sorted(m for m in sys.modules if m == "torch" or m.startswith("torch."))
        if leaked:
            print("TORCH LEAKED:", leaked, file=sys.stderr)
            sys.exit(3)  # distinct from 1 (an uncaught import error) so the two don't conflate
        """
    )
    result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    if result.returncode == 3:
        raise AssertionError(
            "the aligner runtime imported torch (it must stay torch-free; keep torch "
            f"imports lazy in the export/fallback branch):\n{result.stderr}"
        )
    assert result.returncode == 0, (
        "the torch-free runtime probe failed to import (an import/setup error, NOT a "
        f"torch leak):\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    )
