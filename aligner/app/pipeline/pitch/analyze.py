"""Extract the vocal pitch contour from a vocals stem, independent of lyrics.

`extract_pitch_contour` runs the offline f0 extractor (RMVPE -- octave-robust on
separated stems) once over the whole stem, cleans the contour, scans it for
vibrato, and returns a JSON-serializable per-frame contour. Pitch is a property
of the vocal stem, so this runs right after separation; the frontend then maps
the contour onto aligned words (median / melisma / vibrato per word) locally,
and alignment never re-runs the f0 model.

Best-effort: if the f0 model isn't provisioned (a `separation`-only install
without the `pitch` capability), it logs and returns None. SwiftF0 (fast,
low-latency) is reserved for the live-mic path, not this offline pass.
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

from app.config import settings
from app.pipeline.pitch import features
from app.pipeline.pitch.rmvpe import Rmvpe

log = logging.getLogger(__name__)

# Gate frames below this peak-salience for a clean scoring reference. Low enough
# to keep genuine (breathy, lower-salience) falsetto, above RMVPE's 0.03 floor.
_CONF_THRESH = 0.1

_extractor: Rmvpe | None = None
_extractor_lock = threading.Lock()


def extract_pitch_contour(vocals_path: str | Path) -> dict | None:
    """The vocals stem's pitch contour: cleaned per-frame MIDI + track-wide
    vibrato, as a JSON-serializable dict (`fps` + `midi`/`vibRate`/`vibExtent`
    arrays, `null` on unvoiced / no-vibrato frames; frame `i`'s time is `i/fps`).

    Returns None when the f0 model isn't provisioned or the stem is too short to
    yield any frames."""
    extractor = _get_extractor()
    if extractor is None:
        return None
    from app.pipeline.lyrics_onnx import load_audio_np

    audio = load_audio_np(vocals_path)
    contour = extractor.extract(audio)
    if contour.ts.shape[0] == 0:
        return None
    # RMVPE is octave-robust, so skip the octave-outlier drop (it would only risk
    # trimming a real falsetto leap); the min-island pass still removes noise.
    midi = features.clean_contour(
        features.voiced_midi(contour.hz, contour.confidence, conf_thresh=_CONF_THRESH),
        fps=contour.fps,
        drop_octave_outliers=False,
    )
    # Vibrato is scanned track-wide (sliding window) rather than per note, so
    # delayed-onset / boundary-split vibrato is caught. The per-word slice that
    # turns these frames into per-note vibrato tags happens on the frontend.
    vib_rate, vib_extent = features.detect_vibrato_frames(midi, fps=contour.fps)
    return {
        "fps": float(contour.fps),
        "midi": _nan_to_none(midi),
        "vibRate": _nan_to_none(vib_rate),
        "vibExtent": _nan_to_none(vib_extent),
    }


def _nan_to_none(arr: np.ndarray) -> list[float | None]:
    """Per-frame floats with NaN -> null, rounded (0.001 semitone / Hz is well
    below anything audible) to keep the JSON contour compact on the wire."""
    return [None if np.isnan(v) else round(float(v), 3) for v in arr]


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
