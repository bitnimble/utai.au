"""Utai aligner HTTP API (FastAPI): the one API the web and desktop builds talk to.

Routes live with their feature: /music/align (`align_routes`), /music/separate +
/music/beats + /music/pitch (`analysis_routes`), /lyrics/japanese
(`japanese_routes`), /video (`video_routes`), /provision (`provisioning`), the
music source (`music.routes`) and /sessions.
In the pipeline role a background task checks + loads the models at startup;
uvicorn accepts connections immediately. /health is a liveness probe (process +
GPU); /provision/status is the readiness signal.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.align_routes import router as align_router
from app.analysis_routes import router as analysis_router
from app.config import settings
from app.japanese_routes import router as japanese_router
from app.models import HealthResponse
from app.music.routes import aclose_facade as aclose_music_facade
from app.music.routes import router as music_router
from app.provisioning import Provisioner
from app.provisioning import router as provisioning_router
from app.request_context import RequestIdLogFilter
from app.sessions import router as sessions_router
from app.video_routes import router as video_router

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
    provisioner = Provisioner() if settings.worker_role == "pipeline" else None
    app.state.provisioner = provisioner
    if provisioner is None:
        log.info("Starting up in '%s' role: skipping model provisioning + load.", settings.worker_role)
    else:
        provisioner.start()
        log.info("Starting up: checking + loading models in the background...")
    yield
    if provisioner is not None:
        await provisioner.stop()
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
for router in (
    provisioning_router,
    align_router,
    analysis_router,
    japanese_router,
    video_router,
    music_router,
    sessions_router,
):
    app.include_router(router)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    gpu_name: str | None = None
    gpu_available = False
    try:
        import onnxruntime as ort

        # Torch-free probe: the runtime runs on onnxruntime, so "GPU" means an
        # accelerated execution provider is available. Report the first one as the
        # name (e.g. CUDA/Tensorrt/CoreML/DirectML EP) rather than a device string.
        gpu_eps = [
            ep for ep in ort.get_available_providers()
            if ep != "CPUExecutionProvider"
        ]
        gpu_available = bool(gpu_eps)
        if gpu_available:
            gpu_name = gpu_eps[0]
    except Exception as exc:  # pragma: no cover - onnxruntime probe is best-effort
        log.debug("onnxruntime GPU probe failed: %s", exc)
    return HealthResponse(
        status="ok",
        gpu_available=gpu_available,
        gpu_name=gpu_name,
    )
