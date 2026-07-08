# utai.au dev backend image (the aligner service in docker-compose.dev.yml).
#
# The SHIPPED runtime is torch-free (onnxruntime only), so this image installs the
# aligner's torch-free runtime capability groups and NOTHING torch -- unlike
# sandbox/Dockerfile, which deliberately carries the full torch stack for the
# export toolchain + parity tests. The two used to share one image; they diverged
# once the runtime dropped its torch A-B fallback.
#
# Consequences of being torch-free: the backend runs ONLY provisioned/pre-exported
# `.onnx` bodies -- it cannot export a model locally (that needs torch). The compose
# file mounts a `/models` dir holding the exported fp16 onnx + the separator yaml
# (see docker-compose.dev.yml); a missing model is a hard error, not a runtime
# torch export.
#
# Deps go into a uv-managed venv at /opt/venv (on PATH), matching the path the
# compose `backend` command runs (`/opt/venv/bin/python -m uvicorn ...`). The app
# source is NOT copied in: compose bind-mounts the repo and runs uvicorn from
# /repo/aligner with PYTHONPATH, so the image only needs the installed deps.
#
# Build (from the repo root -- the context needs aligner/pyproject.toml and the
# override file under docker/):
#
#   docker build -f docker/backend.Dockerfile -t utai-backend .
#
# Base: CUDA runtime on Ubuntu 22.04 so onnxruntime-gpu's CUDA/TensorRT EPs find
# libcudart; the cudnn/cublas/tensorrt wheels ride in via the `separation` group.
# Works on any host with NVIDIA driver 555+ and the NVIDIA Container Toolkit; falls
# back to the CPU EP if no GPU is exposed.

ARG UV_VERSION=latest
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps: libsndfile + ffmpeg for librosa/soundfile; build-essential for the
# ctc-forced-aligner C++ extension; git for the git+ dependencies
# (ctc-forced-aligner, librespot); curl/ca-certificates + tzdata as in the sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        build-essential \
        ffmpeg libsndfile1 \
        git curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Python 3.11 from deadsnakes (Ubuntu 22.04 ships 3.10; the aligner needs >=3.11).
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv \
    && rm -rf /var/lib/apt/lists/*

COPY --from=uv /uv /uvx /usr/local/bin/

ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=300
RUN uv venv /opt/venv --python python3.11

# numpy bedrock first so the layer seeds the dep cache.
RUN uv pip install 'numpy>=1.26'

# The torch-free aligner dependency set. Drop in pyproject.toml + the override
# file and `uv pip install -e .` with no package source present -- setuptools finds
# nothing to build, but uv resolves + installs every declared dependency, keeping
# the backend's deps in lockstep with the real service. `--override` drops torch
# (see docker/overrides-torch-free.txt): the `lyrics` group's ctc-forced-aligner
# declares torch, which we don't want. `lyrics` includes `separation` (onnxruntime
# + CUDA/TensorRT wheels) which includes `runtime`; `pitch` composes separation;
# `music` (librespot) resolves off PyPI. NO `dev`/`torch` group.
WORKDIR /opt/deps
COPY aligner/pyproject.toml ./
COPY docker/overrides-torch-free.txt ./overrides-torch-free.txt
RUN uv pip install --overrides ./overrides-torch-free.txt \
        --group lyrics --group lyrics-ja --group pitch --group music -e .

# Models / weights caches, mirroring the aligner's cache layout so a bind-mounted
# host cache is reused (the compose file mounts the exported onnx at /models).
ENV AUDIO_SEPARATOR_MODEL_FILE_DIR=/models \
    HF_HOME=/models/huggingface \
    TRANSFORMERS_CACHE=/models/huggingface

# Idle-friendly working dir; the compose `command` sets cwd to /repo/aligner.
WORKDIR /repo
CMD ["python", "-c", "print('utai-backend image; run via docker-compose.dev.yml')"]
