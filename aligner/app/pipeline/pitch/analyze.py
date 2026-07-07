"""Attach per-word pitch to aligned lyric lines, over the vocals stem.

`attach_pitch` runs the offline f0 extractor (RMVPE -- octave-robust on separated
stems) once over the whole stem, cleans the contour, then fills each
`LyricWord`'s `midi` + `pitch_segments` in place. Best-effort: if the f0 model
isn't provisioned (a `lyrics`-only install without the `pitch` capability), it
logs and no-ops, leaving alignment untouched. SwiftF0 (fast, low-latency) is
reserved for the live-mic path, not this offline pass.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from app.config import settings
from app.pipeline.pitch import features
from app.pipeline.pitch.rmvpe import Rmvpe

if TYPE_CHECKING:
    from app.pipeline.lyrics_align import LyricLine

log = logging.getLogger(__name__)

# Gate frames below this peak-salience for a clean scoring reference. Low enough
# to keep genuine (breathy, lower-salience) falsetto, above RMVPE's 0.03 floor.
_CONF_THRESH = 0.1

_extractor: Rmvpe | None = None
_extractor_lock = threading.Lock()


def attach_pitch(vocals_path: str | Path, lines: list[LyricLine]) -> None:
    """Fill `midi` + `pitch_segments` on every word in `lines`, in place."""
    extractor = _get_extractor()
    if extractor is None:
        return
    from app.pipeline.lyrics_onnx import load_audio_np

    audio = load_audio_np(vocals_path)
    contour = extractor.extract(audio)
    if contour.ts.shape[0] == 0:
        return
    # RMVPE is octave-robust, so skip the octave-outlier drop (it would only risk
    # trimming a real falsetto leap); the min-island pass still removes noise.
    midi = features.clean_contour(
        features.voiced_midi(contour.hz, contour.confidence, conf_thresh=_CONF_THRESH),
        fps=contour.fps,
        drop_octave_outliers=False,
    )
    for line in lines:
        if not line.words:
            continue
        for word in line.words:
            wp = features.word_pitch(
                midi, contour.ts, word.start_sec, word.end_sec, fps=contour.fps
            )
            word.midi = wp.midi
            word.pitch_segments = wp.segments or None


def _get_extractor() -> Rmvpe | None:
    global _extractor
    with _extractor_lock:
        if _extractor is None:
            path = _pitch_model_path()
            if path is None:
                return None
            _extractor = Rmvpe(path)
        return _extractor


def _pitch_model_path() -> Path | None:
    from app.pipeline.provision import provision, provisioned_file

    path = provisioned_file(settings.pitch_model_offline)
    if path is not None:
        return path
    # provision("pitch") dedupes against already-present separation assets and
    # fetches the f0 model(s). Best-effort so a fetch failure just skips pitch.
    try:
        provision("pitch")
    except Exception:
        log.warning("pitch: could not provision the f0 model; skipping pitch", exc_info=True)
        return None
    path = provisioned_file(settings.pitch_model_offline)
    if path is None:
        log.info("pitch: f0 model still absent after provisioning; skipping pitch")
    return path
