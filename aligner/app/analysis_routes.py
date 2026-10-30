"""The per-song analysis jobs beside alignment: full-quality stems
(/music/separate), beats (/music/beats), the vocal pitch contour
(/music/pitch) and the sung language (/music/language). Each result lives in its
song's folder (see `song_cache`), so a repeat song reuses it."""
from __future__ import annotations

import asyncio
import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse

from app.job_stream import (
    Envelope,
    ndjson_job,
    read_job_audio,
    require_models,
    require_pipeline_role,
)
from app.pipeline import language_id
from app.pipeline.beats import analyze as beats
from app.pipeline.pitch import analyze as pitch
from app.pipeline.separate import separator
from app.provisioning import Provisioner
from app.request_context import (
    Cancelled,
    cancel_on_disconnect,
    new_request_id,
    run_cancellable,
    set_request_id,
)
from app.song_cache import is_valid_song_id, read_json, store_file, touch_song_dir, write_json

log = logging.getLogger(__name__)

router = APIRouter(prefix="/music")

_STEM_ROLES = ("vocals", "accompaniment")
_STEM_FILES = {f"{role}.flac": role for role in _STEM_ROLES}


@router.post("/separate")
async def lyrics_separate(
    request: Request,
    mix: UploadFile | None = File(default=None),
    mixPath: str = Form(default=""),
) -> StreamingResponse:
    """Full-quality separated stems (vocals + accompaniment residual) of a full
    mix, for the frontend "save song" feature, as a GPU job stream (see
    `job_stream`) ending:

        {"type": "result", "data": {"stems": [
            {"role": "vocals", "path": "music/stems/<id>/vocals.flac",
             "serverPath": "...", "filename": "vocals.flac", "contentType": "audio/flac"},
            {"role": "accompaniment", ...}]}}

    The mix is an upload, or `mixPath` for a file this backend shares. The stems
    are served back over GET /music/stems/{id}/{name}; `<id>` is the song's id."""
    require_pipeline_role()
    require_models("separation")
    request_id = new_request_id()
    set_request_id(request_id)
    audio = await read_job_audio(mix, mixPath, "mix", "utai_stems_")
    stems_dir = _stems_dir(audio.song_id)

    def cached() -> Envelope | None:
        if not all((stems_dir / name).is_file() for name in _STEM_FILES):
            return None
        log.info("lyrics_separate: stems cache HIT (%s)", audio.song_id)
        return _stems_result_envelope(audio.song_id)

    async def separate() -> Envelope:
        paths = await run_cancellable(separator.get().run_stems, audio.path, audio.scratch_dir)
        for name, role in _STEM_FILES.items():
            await asyncio.to_thread(store_file, stems_dir / name, paths[role])
        log.info("lyrics_separate: stems cache MISS, populated (%s)", audio.song_id)
        return _stems_result_envelope(audio.song_id)

    return ndjson_job(request, request_id, "lyrics_separate", audio, separate, gpu=True, cached=cached)


@router.get("/stems/{song_id}/{name}")
async def lyrics_stem(song_id: str, name: str) -> FileResponse:
    """Stream a separated stem FLAC produced by /music/separate.

    `song_id` and `name`, one of the fixed stem filenames, are validated to
    foreclose path traversal (no `../`, no absolute paths, no arbitrary reads
    under the cache dir)."""
    if not is_valid_song_id(song_id) or name not in _STEM_FILES:
        raise HTTPException(status_code=404, detail="No such stem.")
    stem_path = _stems_dir(song_id) / name
    if not stem_path.is_file():
        raise HTTPException(status_code=404, detail="No such stem.")
    return FileResponse(str(stem_path), media_type="audio/flac", filename=name)


def _stems_dir(song_id: str) -> Path:
    return touch_song_dir(song_id) / "stems"


def _stems_result_envelope(song_id: str) -> Envelope:
    """`path` is relative to the api base, lining up with GET
    /music/stems/{id}/{name}; `serverPath` is where the stem is on this machine,
    for a later job to name instead of uploading it back."""
    return {
        "type": "result",
        "data": {
            "stems": [
                {
                    "role": role,
                    "path": f"music/stems/{song_id}/{name}",
                    "serverPath": str(_stems_dir(song_id) / name),
                    "filename": name,
                    "contentType": "audio/flac",
                }
                for name, role in _STEM_FILES.items()
            ]
        },
    }


@router.post("/beats")
async def music_beats(
    request: Request,
    mix: UploadFile | None = File(default=None),
    mixPath: str = Form(default=""),
) -> StreamingResponse:
    """Beat/downbeat analysis (Beat This!) of a full mix, for the beat-line
    overlay, as a job stream (see `job_stream`) ending:

        {"type": "result", "data": {"beats": {
            "beats": [...], "downbeats": [...], "bpm": 128.0, "timeSignature": [4, 4], ...}}}

    Outside the GPU lock: a song's beats run alongside its separation, and the
    model is small. `data.beats` is absent when no beats could be produced."""
    require_pipeline_role()
    request_id = new_request_id()
    set_request_id(request_id)
    audio = await read_job_audio(mix, mixPath, "mix", "utai_beats_")
    cache_path = touch_song_dir(audio.song_id) / "beats.json"

    def cached() -> Envelope | None:
        hit = read_json(cache_path)
        if hit is None or hit.get("beatFallbackUsed"):
            return None
        log.info("music_beats: cache HIT (%s)", audio.hash)
        return _beats_result_envelope(hit)

    async def analyse() -> Envelope:
        analysis = await run_cancellable(beats.analyze_beats, audio.path)
        # Not a fallback grid: Beat This!, once downloaded, should replace it.
        if analysis is not None and not analysis["beatFallbackUsed"]:
            write_json(cache_path, analysis)
        log.info("music_beats: analysed (%s)", audio.hash)
        return _beats_result_envelope(analysis)

    return ndjson_job(request, request_id, "music_beats", audio, analyse, gpu=False, cached=cached)


def _beats_result_envelope(analysis: Any | None) -> Envelope:
    return {"type": "result", "data": {"beats": analysis} if analysis is not None else {}}


@router.post("/pitch")
async def music_pitch(
    request: Request,
    vocals: UploadFile | None = File(default=None),
    vocalsPath: str = Form(default=""),
) -> dict[str, Any]:
    """The vocal pitch contour (RMVPE) of a vocals stem: `{"pitch": {fps, midi,
    vibRate, vibExtent}}`, or `{}` when the f0 model isn't provisioned.

    The stem is an upload, or `vocalsPath` for one this backend separated.
    CPU-only, so it skips the GPU lock and runs alongside the /music/align of the
    same stem."""
    contour = await _cached_stem_analysis(request, vocals, vocalsPath, "pitch", pitch.extract_pitch_contour)
    return {"pitch": contour} if contour is not None else {}


@router.post("/language")
async def music_language(
    request: Request,
    vocals: UploadFile | None = File(default=None),
    vocalsPath: str = Form(default=""),
) -> dict[str, Any]:
    """The sung language of a vocals stem: `{"language": "ja", "confidence": 0.93}`,
    or `{}` when the language ID model isn't provisioned.

    The stem is an upload, or `vocalsPath` for one this backend separated.
    CPU-only, so it skips the GPU lock."""
    detected = await _cached_stem_analysis(request, vocals, vocalsPath, "language", language_id.detect_language)
    return detected if detected is not None else {}


async def _cached_stem_analysis(
    request: Request,
    vocals: UploadFile | None,
    vocals_path: str,
    kind: str,
    analyse: Callable[[Path], Any | None],
) -> Any | None:
    """`analyse` of a vocals stem, once per stem: a None result isn't cached, so
    it runs again once its model is downloaded. None too if the client went away."""
    require_pipeline_role()
    audio = await read_job_audio(vocals, vocals_path, "vocals", f"utai_{kind}_")
    try:
        cache_path = touch_song_dir(audio.song_id) / f"{kind}.json"
        result = read_json(cache_path)
        if result is not None:
            return result
        provisioner: Provisioner = request.app.state.provisioner
        async with cancel_on_disconnect(request):
            await provisioner.status.wait_loaded()
            try:
                result = await run_cancellable(analyse, audio.path)
            except Cancelled:
                log.info("music_%s: cancelled", kind)
                return None
        if result is not None:
            write_json(cache_path, result)
        return result
    finally:
        shutil.rmtree(audio.scratch_dir, ignore_errors=True)
