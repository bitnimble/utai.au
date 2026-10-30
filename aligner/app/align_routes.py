"""POST /music/align: word-level lyrics alignment (CTC forced alignment), and
the two caches behind it, in the song's folder (see `song_cache`):

  - `vocals/<sha256>__sep-<vocals_model_id>.opus`: the mix flow's separated
    vocals stem, so a repeat alignment of the same mix skips the separation pass.
  - `alignment/<sha256>__align-<version>-<lyrics_hash>.json`: the result, keyed on
    the audio, the aligner version and the caller's lyrics + language, so
    same-audio-but-different-lyrics correctly misses.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from app.config import settings
from app.job_stream import (
    Envelope,
    JobAudio,
    hash_bytes,
    ndjson_job,
    read_job_audio,
    require_models,
    require_pipeline_role,
)
from app.pipeline.lyrics_align import InputLine, aligner, lines_to_json
from app.pipeline.separate import separator
from app.request_context import new_request_id, run_cancellable, set_request_id
from app.song_cache import read_json, store_file, touch_song_dir, write_json

log = logging.getLogger(__name__)

router = APIRouter()

_KEY_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")

# Bump when the aligner models or alignment logic change so stale
# entries miss instead of serving a result the current code wouldn't
# produce (the analogue of `_vocals_model_id()` for the result cache).
_ALIGN_CACHE_VERSION = "wav2vec2robust+mms300m+swiftf0-v3"


@router.post("/music/align")
async def lyrics_align(
    request: Request,
    vocals: UploadFile | None = File(default=None),
    mix: UploadFile | None = File(default=None),
    vocalsPath: str = Form(default=""),
    mixPath: str = Form(default=""),
    lyrics: str = Form(default=""),
    language: str = Form(default=""),
) -> StreamingResponse:
    """Word-level lyrics alignment via CTC forced alignment (MMS-300m), as a job
    stream (see `job_stream`) ending `{"type": "result", "data": {"lines": [...]}}`.

    Exactly one audio source must be supplied, each as an upload or, for a
    file this backend wrote or shares, its `...Path` (see `backend_file`):

      - `vocals` / `vocalsPath`: an already-isolated vocals stem. The aligner
        runs straight on it.
      - `mix` / `mixPath`: a full mix. The vocals separator
        (see `Separator.run_vocals`) runs first to extract a vocals stem,
        then the aligner.

    `lyrics` is **required**: a JSON array of `{startSec, text}` lines
    (typically the parsed LRCLIB result). The endpoint is forced-
    alignment only; it never transcribes from audio. wav2vec2 aligns
    the caller's text against the audio to produce per-word timings.

    `language` is an optional ISO-639-1 hint that forces a specific
    wav2vec2 aligner. Empty string falls back to text-based heuristic
    detection.
    """
    require_pipeline_role()
    require_models("lyrics")
    request_id = new_request_id()
    set_request_id(request_id)

    has_vocals = vocals is not None or bool(vocalsPath)
    if has_vocals == (mix is not None or bool(mixPath)):
        raise HTTPException(status_code=400, detail="Exactly one of vocals / mix must be supplied.")
    if not lyrics:
        raise HTTPException(status_code=400, detail="`lyrics` is required (JSON array of {startSec, text}).")
    input_lines = _parse_lyrics_input(lyrics)
    language_hint = language or None
    if has_vocals:
        audio = await read_job_audio(vocals, vocalsPath, "vocals", "utai_lyrics_")
    else:
        audio = await read_job_audio(mix, mixPath, "mix", "utai_lyrics_")
    align_key = _alignment_cache_key(input_lines, language_hint, audio.hash)
    align_path = touch_song_dir(audio.song_id) / "alignment" / align_key

    def cached() -> Envelope | None:
        lines = read_json(align_path)
        if lines is None:
            return None
        log.info("lyrics_align: alignment cache HIT (%s)", align_path.name)
        return _lines_result(lines)

    async def align() -> Envelope:
        vocals_path = audio.path if has_vocals else await _vocals_for(audio)
        if vocals_path is None:
            return {"type": "error", "status_code": 500, "message": "Separator ran but produced no vocals stem."}
        lines = await run_cancellable(aligner.get().realign_text, vocals_path, input_lines, language_hint)
        lines_json = lines_to_json(lines)
        write_json(align_path, lines_json)
        log.info("lyrics_align: alignment cache MISS, populated (%s)", align_path.name)
        return _lines_result(lines_json)

    return ndjson_job(request, request_id, "lyrics_align", audio, align, gpu=True, cached=cached)


def _lines_result(lines: Any) -> Envelope:
    return {"type": "result", "data": {"lines": lines}}


async def _vocals_for(mix: JobAudio) -> Path | None:
    """The mix's vocals stem: cached, else separated now (and cached), or None
    when the separator emitted none."""
    path = touch_song_dir(mix.song_id) / "vocals" / _vocals_cache_key(mix.hash)
    if path.is_file():
        log.info("lyrics_align: vocals cache HIT (%s)", path.name)
        return path
    raw_vocals = await run_cancellable(separator.get().run_vocals, mix.path, mix.scratch_dir)
    if raw_vocals is None:
        return None
    # The aligner reads opus through ffmpeg, so the cached file IS what it aligns.
    opus_tmp = mix.scratch_dir / "vocals.opus"
    try:
        await run_cancellable(_encode_vocals_to_opus, raw_vocals, opus_tmp)
        await asyncio.to_thread(store_file, path, opus_tmp)
    except (subprocess.CalledProcessError, OSError, RuntimeError) as exc:
        log.warning("lyrics_align: vocals cache write failed (%s); falling back to raw separator output", exc)
        return raw_vocals
    log.info("lyrics_align: vocals cache MISS, populated (%s)", path.name)
    return path


def _parse_lyrics_input(raw: str) -> list[InputLine]:
    """Decode the `lyrics` form field into {@link InputLine}s.

    The frontend sends a JSON array of `{startSec, text}` matching its
    in-memory `LyricLine` shape (minus `words`, which we recompute).
    Validates shape eagerly so the caller gets a 400 with a specific
    message instead of a 500 from inside the worker thread later.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"`lyrics` is not valid JSON: {exc}",
        ) from exc
    if not isinstance(parsed, list):
        raise HTTPException(
            status_code=400,
            detail="`lyrics` must be a JSON array of {startSec, text} objects.",
        )
    out: list[InputLine] = []
    for i, entry in enumerate(parsed):
        if not isinstance(entry, dict):
            raise HTTPException(
                status_code=400,
                detail=f"`lyrics[{i}]` must be an object with startSec + text.",
            )
        start = entry.get("startSec")
        text = entry.get("text")
        if not isinstance(start, (int, float)) or not isinstance(text, str):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"`lyrics[{i}]` requires numeric startSec and string text."
                ),
            )
        out.append(InputLine(start_sec=float(start), text=text))
    return out


def _sanitize_id(s: str) -> str:
    """Strip filename-unsafe characters from a model id so it can ride
    in a cache filename. Anything outside `[A-Za-z0-9._-]` becomes `_`."""
    return _KEY_SAFE_CHARS.sub("_", s)


def _vocals_model_id() -> str:
    """Identifier for the vocals separator output. Burnt into the cache key so
    a model swap auto-invalidates every cached vocals stem. Vocals comes from
    the Stage-1 Mel-Band Roformer model, so it tracks that ckpt."""
    return _sanitize_id(settings.demucs_model)


def _vocals_cache_key(audio_hash: str) -> str:
    return f"{audio_hash}__sep-{_vocals_model_id()}.opus"


def _lyrics_input_hash(input_lines: list[InputLine], language: str | None) -> str:
    """SHA-256 of the caller's alignment input: the line text + start
    times (in order) plus the language hint. Two requests collide in the
    cache only when this hash matches, so editing any line, reordering,
    nudging a timestamp, or changing the language forces a re-align.

    Start times round to the millisecond so float-repr noise from the
    JSON round-trip doesn't fragment the key; that's finer than any real
    LRC timestamp."""
    canonical = json.dumps(
        {
            "language": language or "",
            "lines": [
                {"s": round(line.start_sec, 3), "t": line.text}
                for line in input_lines
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hash_bytes(canonical.encode("utf-8"))


def _alignment_cache_key(
    input_lines: list[InputLine], language: str | None, audio_hash: str
) -> str:
    """Cache filename for an alignment result. Encodes the input audio
    hash, the aligner version, and the lyrics+language hash so a hit is
    only possible when all three match (see `_ALIGN_CACHE_VERSION` and
    `_lyrics_input_hash`)."""
    version = _sanitize_id(_ALIGN_CACHE_VERSION)
    lyrics_hash = _lyrics_input_hash(input_lines, language)
    return f"{audio_hash}__align-{version}-{lyrics_hash}.json"


def _encode_vocals_to_opus(src: Path, dest: Path) -> None:
    """ffmpeg-encode `src` to 16 kHz mono Opus at 24 kbps into `dest`.

    16 kHz mono matches what the CTC aligner's `load_audio` resamples to
    anyway, so doing the downmix + downsample at cache-write time shrinks the
    on-disk artifact ~50x vs FLAC with zero impact on alignment quality.
    `-application voip` biases libopus toward speech intelligibility at
    low bitrate. Raises CalledProcessError on encoder failure so the
    caller can decide whether to fall back to running uncached."""
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        raise RuntimeError(
            "ffmpeg not found on PATH; required to populate the vocals cache."
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        ffmpeg, "-y", "-loglevel", "error", "-nostdin",
        "-i", str(src),
        "-ac", "1", "-ar", "16000",
        "-c:a", "libopus", "-b:a", "24k",
        "-application", "voip",
        str(dest),
    ]
    subprocess.run(cmd, check=True)
