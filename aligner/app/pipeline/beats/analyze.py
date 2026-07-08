"""Beat + downbeat analysis over a full mix, independent of lyrics.

`analyze_beats` runs Beat This! (ISMIR 2024; DBN-free, meter-agnostic) once over
the mix, recovers odd-meter downbeats + smooths one-off mis-detections, and
returns a JSON-serializable summary (`beats`/`downbeats` times, `bpm`,
`timeSignature`). The frontend draws subtle beat lines on the audio + lyrics
tracks from it. Runs on the full mix (Beat This!'s training distribution), so it
sits alongside separation on song load.

Best-effort: if the model isn't provisioned it logs and falls back to a plain
librosa 4/4 tracker (`beatFallbackUsed: true`) so the app still gets a grid.
Ported from Drumjot's `beats_detect.py` (the detect + orchestration layer).
"""
from __future__ import annotations

import logging
import threading
from pathlib import Path
from typing import Any

import numpy as np

from app.config import settings
from app.pipeline.beats.meter import beats_downbeats_to_raw, recover_bar_length_if_incoherent
from app.pipeline.beats.structure import BeatAnalysis, build_analysis

log = logging.getLogger(__name__)

_model: Any | None = None
_model_lock = threading.Lock()


def analyze_beats(audio_path: str | Path) -> dict | None:
    """The mix's beat/downbeat summary as a JSON-serializable dict, or None if
    no beats could be produced at all. Falls back to librosa (4/4, no downbeat
    classification) when Beat This! isn't provisioned or fails."""
    audio_path = Path(audio_path)
    model = _get_model()
    if model is None:
        analysis = _librosa_fallback(audio_path)
    else:
        try:
            analysis = _beat_this_analysis(model, audio_path)
        except Exception:
            log.warning("beats: Beat This! failed; falling back to librosa", exc_info=True)
            analysis = _librosa_fallback(audio_path)
    if analysis is None or not analysis.beats:
        return None
    return analysis.to_json()


def _beat_this_analysis(model: Any, audio_path: Path) -> BeatAnalysis:
    beats, downbeats = model(str(audio_path))
    downbeats = recover_bar_length_if_incoherent(beats, downbeats, audio_path)
    raw = beats_downbeats_to_raw(beats, downbeats)
    if raw.size == 0:
        return BeatAnalysis()
    return build_analysis(raw)


def _get_model() -> Any | None:
    global _model
    with _model_lock:
        if _model is None:
            _model = _load_model()
        return _model


def _load_model() -> Any | None:
    from app.pipeline.beats.beat_onnx import load_beat_session
    from app.pipeline.provision import provision, shipped_onnx

    if shipped_onnx("beat_this") is None:
        # provision("beat") fetches the beat model; best-effort so a fetch
        # failure just drops to the librosa fallback.
        try:
            provision("beat")
        except Exception:
            log.warning("beats: could not provision the beat model; using librosa fallback",
                        exc_info=True)
    try:
        return load_beat_session(settings.models_dir, providers=_providers())
    except Exception:
        log.warning("beats: Beat This! model unavailable; using librosa fallback", exc_info=True)
        return None


def _providers() -> list[str] | None:
    """CPU-pinned only when the device is forced to CPU, else the available set
    (CUDA-first via `default_providers`), mirroring the pitch/separation loaders."""
    return ["CPUExecutionProvider"] if (settings.device or "auto").lower() == "cpu" else None


def _librosa_fallback(audio_path: Path) -> BeatAnalysis | None:
    """Plain librosa beat tracking, grouped 4/4 with no downbeat classification.
    Used only when Beat This! is unavailable, so the app still renders a grid."""
    import librosa

    log.info("beats: librosa fallback on %s", audio_path.name)
    try:
        y, sr = librosa.load(str(audio_path), sr=22050, mono=True)
    except Exception:
        log.warning("beats: librosa could not load %s", audio_path, exc_info=True)
        return None
    _, beat_times = librosa.beat.beat_track(y=y, sr=sr, units="time", trim=False)
    if not isinstance(beat_times, np.ndarray) or beat_times.size == 0:
        return None
    # Group every 4 beats into a 4/4 bar: beat_pos 1..4.
    rows = np.array([[float(t), (i % 4) + 1] for i, t in enumerate(beat_times)], dtype=np.float64)
    analysis = build_analysis(rows, beat_fallback_used=True)
    return analysis
