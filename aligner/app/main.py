"""Utai aligner HTTP API (FastAPI).

Endpoints:
    GET  /health         - readiness + GPU info
    POST /lyrics/align   - word-level lyrics alignment (CTC forced alignment)

The service is intentionally stateless. All temp files live in per-request
tempdirs. The separation model is loaded eagerly at startup (FastAPI
lifespan) so the first /lyrics/align call (mix flow) doesn't pay
model-load latency and so orchestrators can use /health as a true
readiness probe.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.cache import BlobCache
from app.config import settings
from app.models import HealthResponse
from app.music.routes import aclose_facade as aclose_music_facade
from app.music.routes import router as music_router
from app.pipeline import gpu_park
from app.pipeline.lyrics_align import InputLine, get_aligner, lines_to_json
from app.pipeline.separate import Separator
from app.request_context import (
    RequestIdLogFilter,
    new_request_id,
    set_request_id,
)

# How long the streaming endpoint will sit silent (no real progress event)
# before emitting a `{"type": "heartbeat"}` NDJSON line. The heavy stages
# (vocals separation, CTC alignment) produce no downstream bytes for tens of
# seconds; without a keepalive an intermediary proxy with an idle timeout
# drops the connection and the client sees a broken pipe. The frontend
# ignores unknown event types, so heartbeats are inert there. 10 s is
# comfortably under typical proxy idle timeouts (commonly 30-60 s) while
# staying low-chatter.
HEARTBEAT_INTERVAL_SECONDS = 10.0


# Process-wide GPU lock. The heavy endpoint (/lyrics/align) takes this before
# doing any model work so a second request can't move a model to CPU while
# the first is mid-forward through it. A queued second request waits; the GPU
# is a single resource, so concurrency wouldn't make either request faster
# anyway.
_gpu_lock = asyncio.Lock()


def _require_pipeline_role() -> None:
    """Defense-in-depth: refuse the heavy endpoint on the `api` worker.

    A front proxy is the source of truth for routing; this guard only fires
    if someone bypasses it and hits the api worker directly.
    """
    if settings.worker_role != "pipeline":
        raise HTTPException(
            status_code=503,
            detail=(
                f"This worker is running in '{settings.worker_role}' role "
                "and does not host the alignment pipeline."
            ),
        )


# Build the single root StreamHandler by hand so we can attach the
# request-id filter to it. The format string references %(request_id)s,
# which would raise during formatting on any record lacking that
# attribute, RequestIdLogFilter always sets it, so the filter MUST live
# on this exact handler. basicConfig(handlers=[...]) installs it on the
# root logger; app.* loggers propagate up to it, so every pipeline log
# line picks up the id without per-logger wiring.
_root_handler = logging.StreamHandler()
_root_handler.addFilter(RequestIdLogFilter())
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s [%(request_id)s]: %(message)s",
    handlers=[_root_handler],
)
log = logging.getLogger(__name__)


class _DropHealthAccessLog(logging.Filter):
    """Drop uvicorn access-log lines for `GET /health`. A load balancer hits
    the health endpoint on a tight liveness interval; logging every probe
    drowns out everything else in the container logs."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3:
            method, path = args[1], args[2]
            if method == "GET" and isinstance(path, str) and path.startswith("/health"):
                return False
        return True


logging.getLogger("uvicorn.access").addFilter(_DropHealthAccessLog())


@asynccontextmanager
async def lifespan(app: FastAPI):
    # The `api` role serves the lightweight control endpoints while an
    # alignment occupies the pipeline worker. Only the pipeline role touches
    # the GPU; the api role skips the eager model load entirely.
    if settings.worker_role != "pipeline":
        log.info(
            "Starting up in '%s' role: skipping separation-model load.",
            settings.worker_role,
        )
        app.state.separator = None
        yield
        await aclose_music_facade()
        log.info("Shutting down.")
        return

    # Eagerly warm the separation model so the first mix-flow /lyrics/align
    # call doesn't pay model-load latency. The model load is blocking I/O +
    # GPU memory allocation, so we run it on a worker thread to avoid
    # blocking the event loop while uvicorn negotiates startup.
    log.info("Starting up: warming separation model...")
    started = time.perf_counter()
    separator = Separator()
    await asyncio.to_thread(separator.load)
    app.state.separator = separator
    log.info(
        "Startup complete in %.2fs - service is ready to accept requests.",
        time.perf_counter() - started,
    )
    yield
    await aclose_music_facade()
    log.info("Shutting down.")


app = FastAPI(
    title="Utai Aligner",
    version="0.1.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)
app.include_router(music_router)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    gpu_name: str | None = None
    gpu_available = False
    try:
        import torch

        gpu_available = bool(torch.cuda.is_available())
        if gpu_available:
            gpu_name = torch.cuda.get_device_name(0)
    except Exception as exc:  # pragma: no cover - torch optional at runtime
        log.debug("torch GPU probe failed: %s", exc)
    return HealthResponse(
        status="ok",
        gpu_available=gpu_available,
        gpu_name=gpu_name,
    )


@app.post("/lyrics/align")
async def lyrics_align(
    request: Request,
    vocals: UploadFile | None = File(default=None),
    mix: UploadFile | None = File(default=None),
    lyrics: str = Form(default=""),
    language: str = Form(default=""),
) -> StreamingResponse:
    """Word-level lyrics alignment via CTC forced alignment (MMS-300m).

    Streaming NDJSON response (one JSON object per line):

        {"type": "queued"}                       # only when the GPU is busy
        {"type": "running"}                       # GPU acquired, work started
        {"type": "result", "data": {"lines": [...]}}   # terminal success
        {"type": "error", "status_code": 500, "message": "..."}  # terminal

    The `queued` envelope lets a client that arrives while another align
    holds the GPU show a wait state instead of a silent hang; see
    `_serialized_gpu_stream`. Input-validation failures still return a real
    4xx with a JSON body, we only switch to NDJSON once the GPU phase can
    actually start.

    Exactly one audio source must be supplied:

      - `vocals`: an already-isolated vocals stem. The aligner runs straight
        on it.
      - `mix`: a full mix. The dedicated vocals separator
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
    _require_pipeline_role()
    # Bind the request id before the first log line and again at the top of
    # `_stream_lyrics_align` (Starlette consumes the streamed body generator
    # in a separate context).
    request_id = new_request_id()
    set_request_id(request_id)
    aligner = get_aligner()

    sources_set = sum(1 for s in (vocals, mix) if s)
    if sources_set != 1:
        raise HTTPException(
            status_code=400,
            detail="Exactly one of vocals / mix must be supplied.",
        )
    if not lyrics:
        raise HTTPException(
            status_code=400,
            detail="`lyrics` is required (JSON array of {startSec, text}).",
        )
    input_lines = _parse_lyrics_input(lyrics)

    # `_require_pipeline_role()` above ensures we're on the worker
    # that loaded the separator at startup; the None branch is purely
    # defensive (e.g. eager load failed and we somehow still got here).
    separator: Separator = request.app.state.separator
    if separator is None:
        raise HTTPException(
            status_code=503,
            detail="Separator is not loaded on this worker.",
        )

    # File I/O and the disk-cache lookup don't touch the GPU, so we do
    # them here, up front: reading the upload needs `await`, and a
    # StreamingResponse is consumed once returned, so we drain it before
    # handing the temp dir to the generator. The GPU steps (vocals separator
    # + CTC aligner) run inside the streamed generator under the
    # process-wide lock.
    cleanup_dir = Path(tempfile.mkdtemp(prefix="utai_lyrics_"))
    cached_align_bytes: bytes | None = None
    try:
        needs_separator = False
        vocals_key: str | None = None
        mix_path: Path | None = None
        vocals_path: Path | None = None
        if vocals is not None:
            vocals_path = cleanup_dir / f"vocals{Path(vocals.filename or '').suffix}"
            vocals_bytes = await vocals.read()
            vocals_path.write_bytes(vocals_bytes)
            audio_hash = _hash_bytes(vocals_bytes)
        else:
            assert mix is not None
            mix_path = cleanup_dir / f"input{Path(mix.filename or '').suffix}"
            mix_bytes = await mix.read()
            mix_path.write_bytes(mix_bytes)
            audio_hash = _hash_bytes(mix_bytes)

        # Alignment-result cache check, before any GPU work. A hit serves
        # the stored JSON straight back, skipping the separator AND the CTC
        # aligner. The key folds in the lyrics + language, so a repeat call
        # for the same audio with edited lyrics correctly misses.
        align_key = _alignment_cache_key(input_lines, language or None, audio_hash)
        cached_align = _alignment_cache_instance().get(align_key)
        if cached_align is not None:
            try:
                cached_align_bytes = cached_align.read_bytes()
                log.info("lyrics_align: alignment cache HIT (%s)", align_key)
            except OSError as exc:
                # The file vanished between the index lookup and the read
                # (operator pruned it, or a concurrent eviction won the
                # race). Treat it as a miss and fall through to the fresh
                # pathway rather than 500ing the request.
                log.info(
                    "lyrics_align: alignment cache file vanished (%s): %s; "
                    "recomputing",
                    align_key,
                    exc,
                )
        if cached_align_bytes is None and mix_path is not None:
            # Vocals-cache check (mix flow only): hit means we skip the
            # separator and feed the already-isolated opus straight to the
            # CTC aligner (which decodes it through its own ffmpeg pipeline,
            # so no manual decode here).
            vocals_key = _vocals_cache_key(audio_hash)
            cached_vocals = _vocals_cache_instance().get(vocals_key)
            if cached_vocals is not None:
                log.info("lyrics_align: vocals cache HIT (%s)", vocals_key)
                vocals_path = cached_vocals
            else:
                needs_separator = True
    except Exception:
        # The generator's `finally` only runs once it starts streaming;
        # a failure during the up-front drain has to clean up itself.
        shutil.rmtree(cleanup_dir, ignore_errors=True)
        raise

    if cached_align_bytes is not None:
        # No GPU work needed: drop the temp dir now and emit the cached
        # result directly (no queued/running/GPU-lock detour).
        shutil.rmtree(cleanup_dir, ignore_errors=True)
        return StreamingResponse(
            _emit_cached_alignment(request_id, cached_align_bytes),
            media_type="application/x-ndjson",
        )

    return StreamingResponse(
        _stream_lyrics_align(
            request_id=request_id,
            separator=separator,
            aligner=aligner,
            input_lines=input_lines,
            language=language or None,
            needs_separator=needs_separator,
            vocals_key=vocals_key,
            align_key=align_key,
            mix_path=mix_path,
            vocals_path=vocals_path,
            cleanup_dir=cleanup_dir,
        ),
        media_type="application/x-ndjson",
    )


async def _emit_cached_alignment(
    request_id: str, lines_json_bytes: bytes
) -> AsyncIterator[bytes]:
    """Emit a cached /lyrics/align result as a single NDJSON `result`
    envelope. No GPU runs, so there are no `queued`/`running` envelopes;
    the frontend treats those as optional status and acts on `result`."""
    set_request_id(request_id)
    lines = json.loads(lines_json_bytes)
    yield (
        json.dumps({"type": "result", "data": {"lines": lines}}) + "\n"
    ).encode("utf-8")


async def _stream_lyrics_align(
    *,
    request_id: str,
    separator: Separator,
    aligner: Any,
    input_lines: list[InputLine],
    language: str | None,
    needs_separator: bool,
    vocals_key: str | None,
    align_key: str,
    mix_path: Path | None,
    vocals_path: Path | None,
    cleanup_dir: Path,
) -> AsyncIterator[bytes]:
    """Stream the GPU phase of /lyrics/align as NDJSON bytes.

    The upload drain + vocals-cache lookup already ran in the endpoint
    handler; this owns the GPU-serialised work: park the separation model,
    (optionally) run the vocals separator, park it before the CTC aligner
    loads, then run forced alignment and emit the terminal `result`.

    Wrapped in `_serialized_gpu_stream` so a request that arrives while
    another GPU request is in flight emits a `queued` envelope first and
    then waits its turn (the GPU is a single resource; serialising also
    keeps a park from moving a model host-side under an in-flight
    forward pass). Failures surface as `error` envelopes rather than
    raising into the ASGI layer. The temp dir is always cleaned up.

    A `{"type": "heartbeat"}` line is interleaved every
    HEARTBEAT_INTERVAL_SECONDS while we're waiting between envelopes (the
    vocals separator + CTC aligner are long silent GPU stages) so an
    idle-timeout proxy between us and the client doesn't drop the
    connection. The frontend ignores unknown event types, so heartbeats
    need no client handling.
    """
    # Re-bind the request id: Starlette consumes this generator inside the
    # StreamingResponse task, a different context from the endpoint handler
    # that minted the id. Binding here guarantees the id is set in the
    # context that `asyncio.to_thread(...)` snapshots for the GPU work.
    set_request_id(request_id)

    async def job() -> AsyncIterator[dict[str, Any]]:
        nonlocal vocals_path
        try:
            # park_for_lyrics frees the separation-model VRAM;
            # park_vocals_after_extraction (below) then frees the vocals
            # separator's VRAM before the CTC aligner allocates.
            try:
                gpu_park.park_for_lyrics(separator, aligner)
            except Exception:
                log.exception("lyrics_align: park_for_lyrics failed; continuing")

            if needs_separator:
                assert mix_path is not None
                assert vocals_key is not None
                raw_vocals = await asyncio.to_thread(
                    _extract_vocals_with_separator,
                    separator, mix_path, cleanup_dir,
                )
                if raw_vocals is None:
                    yield {
                        "type": "error",
                        "status_code": 500,
                        "message": "Separator ran but produced no vocals stem.",
                    }
                    return
                # Opus-encode into the cache. Whisperx reads opus through
                # ffmpeg natively, so the cached file IS the file we feed
                # to alignment; no double-encoding, no decode step.
                opus_tmp = cleanup_dir / "vocals.opus"
                try:
                    await asyncio.to_thread(
                        _encode_vocals_to_opus, raw_vocals, opus_tmp,
                    )
                    vocals_path = _vocals_cache_instance().put_path(
                        vocals_key, opus_tmp,
                    )
                    log.info(
                        "lyrics_align: vocals cache MISS, populated (%s)",
                        vocals_key,
                    )
                except (subprocess.CalledProcessError, OSError, RuntimeError) as exc:
                    # Cache-write failure must not break alignment. Fall
                    # back to the raw separator output for this request;
                    # the cache will retry on the next call.
                    log.warning(
                        "lyrics_align: vocals cache write failed (%s); "
                        "falling back to raw separator output",
                        exc,
                    )
                    vocals_path = raw_vocals

            # Park the vocals separator before the CTC aligner loads.
            # No-op when we took the cache hit / pre-supplied vocals
            # path (the separator was never loaded into VRAM this
            # request); important when we just ran it.
            try:
                gpu_park.park_vocals_after_extraction(separator)
            except Exception:
                log.exception(
                    "lyrics_align: park_vocals_after_extraction failed; continuing"
                )

            assert vocals_path is not None
            lines = await asyncio.to_thread(
                aligner.realign_text,
                vocals_path,
                input_lines,
                language,
            )
            lines_json = lines_to_json(lines)
            # Populate the alignment-result cache so an identical repeat
            # request skips this whole GPU path. Best-effort: a write
            # failure must not break the response (mirrors the vocals-cache
            # write fallback above).
            try:
                _alignment_cache_instance().put_bytes(
                    align_key,
                    json.dumps(lines_json, ensure_ascii=False).encode("utf-8"),
                )
                log.info(
                    "lyrics_align: alignment cache MISS, populated (%s)", align_key
                )
            except OSError as exc:
                log.warning(
                    "lyrics_align: alignment cache write failed (%s); "
                    "serving result uncached",
                    exc,
                )
            yield {"type": "result", "data": {"lines": lines_json}}
        except FileNotFoundError as exc:
            yield {"type": "error", "status_code": 404, "message": str(exc)}
        except Exception as exc:
            log.exception("lyrics_align failed")
            yield {"type": "error", "status_code": 500, "message": str(exc)}

    envelopes = _serialized_gpu_stream(_gpu_lock, job).__aiter__()
    try:
        async for chunk in _pump_with_heartbeat(envelopes.__anext__, _encode_envelope):
            yield chunk
    finally:
        # The job's own `finally` releases the GPU lock; here we only own
        # the temp dir.
        shutil.rmtree(cleanup_dir, ignore_errors=True)


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


def _extract_vocals_with_separator(
    separator: Separator, mix_path: Path, work_dir: Path,
) -> Path | None:
    """Run the vocals separator (Stage-1 Mel-Band Roformer) on `mix_path` and
    return the vocals stem path for CTC forced alignment.

    Returns None when the separator finished but no vocals-named output
    landed (model swap that no longer emits a `(Vocals)` token).
    """
    return separator.run_vocals(mix_path, work_dir)


# ---------------------------------------------------------------------------
# /lyrics/align disk caches
# ---------------------------------------------------------------------------
#
# Two content-addressed caches back the alignment pipeline:
#
#   - vocals (`settings.cache_dir/vocals/<sha256>__sep-<vocals_model_id>.
#     opus`): only the `mix` flow populates / reads it. Caching the
#     separated vocals stem lets repeat alignments against the same mix
#     skip the separation pass.
#   - alignment (`settings.cache_dir/alignment/<sha256>__align-<version>-
#     <lyrics_hash>.json`): the forced-alignment result JSON, keyed on the
#     input audio hash + the aligner version + a hash of the caller's
#     lyrics text and language. A hit serves the stored result straight
#     back, skipping the separator AND the GPU aligner. The composite key
#     means same-audio-but-different-lyrics correctly misses and re-aligns.

_KEY_SAFE_CHARS = re.compile(r"[^A-Za-z0-9._-]")

# Bump when the aligner models or alignment logic change so stale
# entries miss instead of serving a result the current code wouldn't
# produce (the analogue of `_vocals_model_id()` for the result cache).
_ALIGN_CACHE_VERSION = "wav2vec2robust+mms300m-v1"

_vocals_cache: BlobCache | None = None
_alignment_cache: BlobCache | None = None
_cache_init_lock = threading.Lock()


def _vocals_cache_instance() -> BlobCache:
    """Lazy singleton for the vocals stem cache. Each worker process
    instantiates its own BlobCache against the shared on-disk directory."""
    global _vocals_cache
    if _vocals_cache is not None:
        return _vocals_cache
    with _cache_init_lock:
        if _vocals_cache is None:
            _vocals_cache = BlobCache(
                settings.cache_dir / "vocals",
                cap_bytes=settings.cache_vocals_cap_bytes,
            )
        return _vocals_cache


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


def _hash_bytes(data: bytes) -> str:
    """SHA-256 hex of `data`, matching `hashlib.sha256(bytes).hexdigest()`."""
    return hashlib.sha256(data).hexdigest()


def _alignment_cache_instance() -> BlobCache:
    """Lazy singleton for the forced-alignment result cache, a sibling of
    the vocals cache under `settings.cache_dir/alignment`."""
    global _alignment_cache
    if _alignment_cache is not None:
        return _alignment_cache
    with _cache_init_lock:
        if _alignment_cache is None:
            _alignment_cache = BlobCache(
                settings.cache_dir / "alignment",
                cap_bytes=settings.cache_alignment_cap_bytes,
            )
        return _alignment_cache


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
    return _hash_bytes(canonical.encode("utf-8"))


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


async def _pump_with_heartbeat(
    next_item: Callable[[], Any],
    encode: Callable[[Any], bytes | None],
) -> AsyncIterator[bytes]:
    """Drive `next_item()` to exhaustion, interleaving `{"type":
    "heartbeat"}` NDJSON lines during silent gaps so an idle-timeout proxy
    between us and the client doesn't drop the connection.

    `next_item()` returns a *fresh* awaitable each call yielding the next
    upstream value; the stream ends when that awaitable raises
    `StopAsyncIteration`. `encode(value)` maps a value to the NDJSON bytes
    to emit, or `None` to consume it silently (internal sentinels).

    Each `next_item()` awaitable is raced against a
    HEARTBEAT_INTERVAL_SECONDS timeout. `wait_for` cancels its inner await
    on timeout, so the awaitable is held (shielded) across iterations to
    avoid dropping a value; on timeout we emit a heartbeat and keep waiting
    on the same pending. A heartbeat is never emitted once the stream ends:
    `StopAsyncIteration` breaks the loop before any further wait. On unwind
    (client disconnect) the in-flight pending is cancelled so it doesn't
    leak; the caller's own `finally` owns lock release / temp cleanup.
    """
    pending: asyncio.Task[Any] | None = None
    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(next_item())
            try:
                value = await asyncio.wait_for(
                    asyncio.shield(pending), timeout=HEARTBEAT_INTERVAL_SECONDS
                )
            except TimeoutError:
                yield (json.dumps({"type": "heartbeat"}) + "\n").encode("utf-8")
                continue
            except StopAsyncIteration:
                break
            pending = None
            chunk = encode(value)
            if chunk is not None:
                yield chunk
    finally:
        if pending is not None and not pending.done():
            pending.cancel()


def _encode_envelope(envelope: dict[str, Any]) -> bytes:
    return (json.dumps(envelope) + "\n").encode("utf-8")


async def _serialized_gpu_stream(
    lock: asyncio.Lock,
    job: Callable[[], AsyncIterator[dict[str, Any]]],
) -> AsyncIterator[dict[str, Any]]:
    """Serialise `job` behind the process-wide GPU `lock`, yielding NDJSON
    envelope dicts.

    Emits ``{"type": "queued"}`` first iff the lock is already held, so a
    client blocked behind another in-flight request can render a wait
    state instead of a silent hang. The queued envelope is yielded
    *before* awaiting acquisition, so it reaches the client immediately
    rather than after the wait. Once this stream owns the lock it emits
    ``{"type": "running"}`` and then forwards every envelope `job()`
    yields (typically a terminal ``result`` / ``error``).

    The lock is always released, even if `job` raises. `job` owns its own
    error handling and cleanup; it should yield a terminal envelope
    rather than raise, but a stray exception still unwinds cleanly here.
    """
    if lock.locked():
        yield {"type": "queued"}
    await lock.acquire()
    try:
        yield {"type": "running"}
        async for envelope in job():
            yield envelope
    finally:
        lock.release()
