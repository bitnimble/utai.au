"""Extract the vocal pitch contour from a vocals stem, independent of lyrics.

`extract_pitch_contour` runs the offline f0 extractor (RMVPE -- octave-robust on
separated stems) once over the whole stem, cleans the contour, scans it for
vibrato, and returns a JSON-serializable per-frame contour. Pitch is a property
of the vocal stem, so this runs once per stem (the `extractPitch` job /
`/music/pitch`); the frontend then maps the contour onto aligned words (median /
melisma / vibrato per word) locally, and alignment never re-runs the f0 model.

Best-effort: if the f0 model isn't provisioned (a `separation`-only install
without the `pitch` capability), it logs and returns None. SwiftF0 (fast,
low-latency) is reserved for the live-mic path, not this offline pass.
"""
from __future__ import annotations

import logging
from pathlib import Path

import numpy as np

from app.config import settings
from app.lazy import Lazy
from app.pipeline.pitch import features
from app.pipeline.pitch.rmvpe import Rmvpe

log = logging.getLogger(__name__)

# Gate frames below this peak-salience for a clean scoring reference. Low enough
# to keep genuine (breathy, lower-salience) falsetto, above RMVPE's 0.03 floor.
_CONF_THRESH = 0.1


def extract_pitch_contour(vocals_path: str | Path) -> dict | None:
    """The vocals stem's pitch contour: cleaned per-frame MIDI + track-wide
    vibrato, as a JSON-serializable dict (`fps` + `midi`/`vibRate`/`vibExtent`
    arrays, `null` on unvoiced / no-vibrato frames; frame `i`'s time is `i/fps`).

    Returns None when the f0 model isn't provisioned or the stem is too short to
    yield any frames."""
    rmvpe = extractor.get()
    if rmvpe is None:
        log.info("pitch: f0 model not provisioned; no contour")
        return None
    from app.pipeline.lyrics_onnx import load_audio_np

    audio = load_audio_np(vocals_path)
    contour = rmvpe.extract(audio, release_memory=True)
    if contour.ts.shape[0] == 0:
        log.info("pitch: stem too short; no f0 frames")
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
    midi_out = _nan_to_none(midi)
    voiced = sum(1 for v in midi_out if v is not None)
    log.info("pitch: extracted %d f0 frames (%d voiced)", len(midi_out), voiced)
    return {
        "fps": float(contour.fps),
        "midi": midi_out,
        "vibRate": _nan_to_none(vib_rate),
        "vibExtent": _nan_to_none(vib_extent),
    }


def _nan_to_none(arr: np.ndarray) -> list[float | None]:
    """Per-frame floats with NaN -> null, rounded (0.001 semitone / Hz is well
    below anything audible) to keep the JSON contour compact on the wire."""
    return [None if np.isnan(v) else round(float(v), 3) for v in arr]


def _build_extractor() -> Rmvpe | None:
    from app.pipeline.provision import provisioned_file

    path = provisioned_file(settings.pitch_model_offline)
    # CPU: keeps the weights + a whole-song activation peak off the GPU.
    return Rmvpe(path, providers=["CPUExecutionProvider"]) if path is not None else None


extractor: Lazy[Rmvpe | None] = Lazy(_build_extractor)
