"""End-to-end check that the SHIPPED separation ONNX model actually loads +
produces stems through its real loader.

This validates the download -> load -> run path the desktop app relies on: the
`Separator` prefers the provisioned `{stem}.fp16.onnx` bodies
(`provision.shipped_onnx`). The test is GATED on the Roformer body being
present, so it stays skipped until the fp16 set is uploaded to
`bitnimble/utai-onnx` and provisioned into `models_dir`.

To enable it once the upload is done, provision the model (or point at a dir
that already has it):

    UTAI_MODELS_DIR=/path/with/model_mel_band_roformer.fp16.onnx pytest
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
    """The provisioned Roformer ONNX body loads through the real `Separator`
    and produces a vocals stem, proving the model ran (not just that the file
    loads)."""
    from app.pipeline.separate import Separator

    clip = tmp_path / "tone.wav"
    _tone_clip(clip)

    sep = Separator()
    sep.load()
    vocals = sep.run_vocals(clip, tmp_path)
    assert vocals is not None, "no vocals stem produced"
    assert vocals.exists()
    assert vocals.stat().st_size > 0
