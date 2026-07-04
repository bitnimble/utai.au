"""End-to-end check that the SHIPPED separation ONNX model actually loads +
produces stems through its real loader.

This validates the download -> load -> run path the desktop app relies on: the
`Separator` prefers the provisioned `{stem}.fp16.onnx` bodies
(`provision.shipped_onnx`). The test is GATED on the BS-Roformer body being
present, so it stays skipped until the fp16 set is uploaded to
`bitnimble/utai-onnx` and provisioned into `models_dir`.

To enable it once the upload is done, provision the model (or point at a dir
that already has it):

    UTAI_MODELS_DIR=/path/with/model_bs_roformer_sw.fp16.onnx pytest
    # or: python -m app.pipeline.provision separation   (downloads into models_dir)
"""

from pathlib import Path

import numpy as np
import pytest

from app.config import settings
from app.pipeline.provision import shipped_onnx

_ROFORMER_STEM = Path(settings.demucs_model).stem

pytestmark = pytest.mark.skipif(
    shipped_onnx(_ROFORMER_STEM) is None,
    reason=(
        f"{_ROFORMER_STEM}.fp16.onnx not provisioned into settings.models_dir "
        "(upload the fp16 set to utai-onnx, then `python -m app.pipeline.provision separation`)"
    ),
)


def _tone_clip(path, dur=6.0, sr=44100):
    """A short stereo tone the separator can run over without erroring."""
    import soundfile as sf

    n = int(sr * dur)
    t = np.arange(n) / sr
    y = 0.2 * np.sin(2 * np.pi * 220 * t) + 0.1 * np.sin(2 * np.pi * 440 * t)
    stereo = np.stack([y, y], axis=1).astype(np.float32)
    sf.write(str(path), stereo, sr)


def test_shipped_separation_onnx_runs(tmp_path):
    """The provisioned BS-Roformer ONNX body loads through the real `Separator`
    and produces a drum stem, proving the model ran (not just that the file
    loads)."""
    from app.pipeline.separate import Separator

    clip = tmp_path / "tone.wav"
    _tone_clip(clip)

    sep = Separator()
    sep.load(stems_all=True, stems_per=False)
    res = sep.run_stems_all(clip, tmp_path, build_no_drums=True)
    assert res.drum_stem.exists(), "no drum stem produced"
    assert res.drum_stem.stat().st_size > 0


def test_shipped_separation_via_sidecar_separate_op(tmp_path):
    """Drive the `separate` op through the real sidecar registry + StdioAdapter --
    the exact path the desktop app's Rust broker feeds over stdio -- and confirm
    it produced stem artifacts. The headless twin of the desktop WebDriver e2e."""
    import asyncio
    import io
    import json

    from app.comms.protocol import RequestMessage
    from app.comms.runners import build_registry
    from app.comms.stdio_adapter import StdioAdapter

    clip = tmp_path / "tone.wav"
    _tone_clip(clip)

    request = RequestMessage(
        type="request",
        id="s1",
        op="separate",
        args={"audio": {"kind": "path", "path": str(clip)}, "params": {"stage": "stems_all"}},
    ).model_dump_json()
    stdout = io.StringIO()
    asyncio.run(StdioAdapter(build_registry(), stdin=io.StringIO(request + "\n"), stdout=stdout).run())
    frames = [json.loads(line) for line in stdout.getvalue().splitlines() if line.strip()]

    result = frames[-1]
    assert result["type"] == "result", frames
    assert result["artifacts"], "separate op returned no artifacts"
