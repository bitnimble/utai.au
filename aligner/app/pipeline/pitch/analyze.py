"""Attach per-word pitch to aligned lyric lines, over the vocals stem.

`attach_pitch` runs SwiftF0 once over the whole stem, cleans the contour, then
fills each `LyricWord`'s `midi` + `pitch_segments` in place. Best-effort: if the
f0 model isn't provisioned (a `lyrics`-only install without the `pitch`
capability), it logs and no-ops, leaving alignment untouched.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import TYPE_CHECKING

from app.config import settings
from app.pipeline.pitch import features
from app.pipeline.pitch.f0 import SwiftF0

if TYPE_CHECKING:
    from app.pipeline.lyrics_align import LyricLine

log = logging.getLogger(__name__)

_extractor: SwiftF0 | None = None
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
    midi = features.clean_contour(
        features.voiced_midi(contour.hz, contour.confidence), fps=contour.fps
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


def _get_extractor() -> SwiftF0 | None:
    global _extractor
    with _extractor_lock:
        if _extractor is None:
            path = _pitch_model_path()
            if path is None:
                return None
            _extractor = SwiftF0(path)
        return _extractor


def _pitch_model_path() -> Path | None:
    from app.pipeline.provision import provision, provisioned_file

    path = provisioned_file(settings.pitch_model)
    if path is not None:
        return path
    # The f0 model is ~400 kB, so a lazy best-effort fetch is cheap (unlike the
    # >1 GB separation/lyrics weights, which are provisioned at install time).
    # provision("pitch") dedupes against already-present separation assets.
    try:
        provision("pitch")
    except Exception:
        log.warning("pitch: could not provision the f0 model; skipping pitch", exc_info=True)
        return None
    path = provisioned_file(settings.pitch_model)
    if path is None:
        log.info("pitch: f0 model still absent after provisioning; skipping pitch")
    return path
