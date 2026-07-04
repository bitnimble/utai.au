# utai sandbox container.
#
# A bare CUDA + Python environment that carries the *exact same*
# dependency stack as the aligner runtime (installed from
# aligner/pyproject.toml, below) but runs NOTHING on its own. No uvicorn
# workers, no frontend bundle, no entrypoint - just an idle container an
# agent can exec into to run Python scripts freely, poke at CUDA, and
# read/write at will.
#
# The intended use is exploratory: mount /codebox-workspace (where the
# aligner writes debug artifacts, separated stems, benchmark results,
# etc.) read-only or read-write, inspect the output of previous runs,
# and prototype new pipeline code against the same torch / librosa stack
# the real service uses - without rebuilding anything.
#
# Deps are managed with uv (the aligner's dev loop uses uv, not
# pip), installed into a venv at /opt/venv that's on PATH - so `python`,
# `python3`, and any console scripts resolve to it automatically, and
# `uv pip install <more>` Just Works for the agent.
#
# Base: CUDA runtime on Ubuntu 22.04, matching the aligner's torch cu128
# stack, so anything that runs here runs against the same deps the real
# service resolves. Works on any host with NVIDIA driver 555+ and the
# NVIDIA Container Toolkit. Falls back to CPU if no GPU is exposed to the
# container.
#
# Build (from the repo root, NOT from sandbox/ - the build context needs
# aligner/pyproject.toml):
#
#   docker build -f sandbox/Dockerfile -t utai-sandbox .
#
# Run (detached + idle, then exec a shell in):
#
#   docker run -d --name utai-sandbox \
#       --gpus all --shm-size=2g \
#       -v /codebox-workspace:/codebox-workspace \
#       utai-sandbox
#   docker exec -it utai-sandbox bash
#
# (--shm-size=2g: default 64MB /dev/shm hangs DataLoader num_workers>0.)
#
# Drop `--gpus all` to run CPU-only. Mount /codebox-workspace read-only
# (append `:ro`) if you only want to inspect prior output without risking
# a stray write.

# uv binary source. Aliased as a build stage (rather than referenced
# inline in the COPY below) because an ARG only expands in a stage's
# image reference, not in `COPY --from=<image>`. Both version ARGs must
# precede the first FROM to be usable in a stage's image reference (an ARG
# declared after a FROM is stage-scoped, not global). UV_VERSION defaults
# to `latest` so the image builds out of the box; pin it (e.g. 0.9.0) and
# bump deliberately for reproducibility.
ARG UV_VERSION=latest
ARG BUN_VERSION=1.3.5
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

# bun binary source. The aligner runtime is pure Python (no bun);
# this is a sandbox-only convenience so an agent can run JS/TS one-liners
# (`bun -e`) alongside Python. Pinned to 1.3.5 (see BUN_VERSION above);
# sandbox-only, so it need not track the frontend's packageManager pin.
FROM oven/bun:${BUN_VERSION} AS bun

FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System dependencies, same set as the aligner image: libsndfile +
# ffmpeg for librosa/soundfile; build-essential for any source-built
# deps; curl/ca-certificates for the in-image downloads below. tzdata is
# explicit (not just transitive) because the container inherits the HOST's
# timezone via a TZ env var (injected by sandbox/start.sh at creation and
# scripts/sandbox-run at exec) -- glibc/Python need the zoneinfo files for
# TZ=Area/City to resolve; the image itself stays neutral (no baked zone).
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        build-essential \
        ffmpeg libsndfile1 \
        git curl ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Python 3.11 from deadsnakes (Ubuntu 22.04 ships 3.10; the aligner
# needs >=3.11). Installed as `python3.11` explicitly rather than
# rewriting /usr/bin/python3, to avoid breaking apt hooks. No pip is
# bootstrapped here - uv (below) owns package management and builds the
# venv against this interpreter.
RUN add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.11 python3.11-dev python3.11-venv \
    && rm -rf /var/lib/apt/lists/*

# uv: the project's package manager. Copied as the official static
# binary from the aliased stage above so the install doesn't drag in a
# bootstrap pip.
COPY --from=uv /uv /uvx /usr/local/bin/

# bun: copied as the static binary from the aliased stage above (relies
# on libstdc++6, already present via build-essential). `bunx` is just a
# bun alias, symlinked for parity with a normal bun install.
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# A uv-managed venv at /opt/venv, put on PATH so the interpreter and any
# installed console scripts resolve to it without activation. VIRTUAL_ENV
# lets `uv pip install` target it implicitly. UV_LINK_MODE=copy silences
# the hardlink warning on the image's layered filesystem; the generous
# UV_HTTP_TIMEOUT covers the multi-GB torch wheel fetches.
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    UV_LINK_MODE=copy \
    UV_HTTP_TIMEOUT=300
RUN uv venv /opt/venv --python python3.11

# Runtime user. Matches the typical host UID 1000:1000 so files written
# into the bind-mounted /codebox-workspace end up owned by the host user
# rather than root. Override at build time with
# --build-arg APP_UID=<uid> --build-arg APP_GID=<gid> if your host user
# differs. Need to apt-install from inside the sandbox? Re-exec as root:
# `docker exec -u 0 ... bash`.
ARG APP_UID=1000
ARG APP_GID=1000
RUN groupadd -g ${APP_GID} app \
    && useradd -u ${APP_UID} -g ${APP_GID} -m -s /bin/bash app

# Python deps in three independently-cacheable layers so the heavy torch
# fetch stays cached across edits.

# Layer 1: numpy bedrock. Isolating the layer seeds the dep cache.
RUN uv pip install 'numpy>=1.26'

# Layer 2: torch + torchaudio from the cu128 wheel index (CUDA 12.8 =
# highest most consumer drivers handle). Pinned to the same range as
# pyproject.toml so the editable install below won't try to upgrade it.
RUN uv pip install --index-url https://download.pytorch.org/whl/cu128 \
        'torch>=2.8,<2.12' 'torchaudio>=2.8,<2.12'

# Layer 3: the full aligner dependency set. Drop in ONLY pyproject.toml
# and `uv pip install -e .` with no package source present - setuptools
# finds nothing to build but uv still resolves and installs every declared
# dependency (ctc-forced-aligner, librosa, onnxruntime, ...), keeping the
# sandbox's deps in lockstep with the real service. Installed into
# /opt/deps so the editable .pth points there and /sandbox stays pristine.
# --extra-index-url keeps any transitive torch resolution on the cu128
# wheels. The app source is deliberately NOT copied - this stays an empty
# sandbox; bring your own scripts.
WORKDIR /opt/deps
COPY aligner/pyproject.toml ./
# The heavy deps live in PEP 735 dependency-groups (lean base); install
# every group for full parity (dev adds ruff + pytest so the agent can
# lint/test in-sandbox). Groups track aligner/pyproject.toml.
RUN uv pip install --extra-index-url https://download.pytorch.org/whl/cu128 \
        --group dev --group separation --group lyrics --group lyrics-ja -e .

# Models / weights caches. Pointed at /models (and HF/torch subdirs) so
# audio-separator, HF transformers, and torch.hub reuse the same cache
# layout as the aligner. Bind-mount the host's existing models cache
# here (e.g. -v /codebox-workspace/utai/models-cache:/models) to avoid
# re-downloading multi-GB weights.
ENV AUDIO_SEPARATOR_MODEL_FILE_DIR=/models \
    HF_HOME=/models/huggingface \
    TRANSFORMERS_CACHE=/models/huggingface \
    TORCH_HOME=/models/torch

# Writable scratch + venv + caches + mount point, all owned by the app
# user. /opt/venv and /opt/deps are chowned so the agent can `uv pip
# install` more packages without re-execing as root. /sandbox is the
# working dir for throwaway scripts and output.
RUN mkdir -p /sandbox /models /codebox-workspace \
    && chown -R app:app /sandbox /models /codebox-workspace /opt/venv /opt/deps

WORKDIR /sandbox
USER app:app

# Idle by default so the container stays up for `docker exec`. Nothing
# utai-related is launched. Override the command for a one-shot run,
# e.g. `docker run --rm ... utai-sandbox python my_script.py`.
CMD ["sleep", "infinity"]
