"""Runtime configuration loaded from environment variables.

Set via `.env` file in the aligner/ directory (gitignored) or by passing
real environment variables when running under Docker / IaaS.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Process-wide settings. 12-factor: everything overridable via env."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Separation models ---
    # Both Stage-1 and Stage-2 models are NOT in audio-separator's
    # registry; `pipeline/provision.py` injects them and downloads their
    # weights on startup. These values are the *local* filenames it writes
    # into `models_dir`. Stage-1 `model_bs_roformer_sw.ckpt` = BS-Roformer
    # SW (6-stem; the /lyrics path consumes its `vocals` stem). Stage-2
    # `drumsep_5stems_mdx23c_jarredou.ckpt` is retained for the `separate`
    # sidecar op (per-instrument split); the field name `demucs_model` is
    # historical (Stage 1 is a Roformer now, not Demucs).
    demucs_model: str = "model_bs_roformer_sw.ckpt"
    drum_pieces_model: str = "drumsep_5stems_mdx23c_jarredou.ckpt"

    # --- Model asset sources (build/packaging) ---
    # Every model URL / HF id / repo that the packaged app has baked in lives
    # here so it can be repointed per build (fork, private mirror, staging)
    # without touching code. Defaults are the canonical Utai repos.
    #   - `onnx_repo`: all shipped runtime assets (the fp16 `.onnx` set + the
    #     separation architecture yamls).
    #   - `lyrics_align_model_*`: the /lyrics CTC aligner HF ids (also the
    #     tokenizer source and the shipped `.onnx` filename stem).
    # TODO(utai): confirm HF repo id once models uploaded
    onnx_repo: str = "https://huggingface.co/bitnimble/utai-onnx/resolve/main"
    lyrics_align_model_english: str = "facebook/wav2vec2-large-robust-ft-libri-960h"
    lyrics_align_model_default: str = "MahmoudAshraf/mms-300m-1130-forced-aligner"

    # --- Paths (Docker volumes mount these) ---
    models_dir: Path = Path("/models")

    # Content-addressed cache for the /lyrics/align pipeline, two subdirs:
    #   - `vocals/`: opus-encoded separated vocals keyed by SHA-256 of the
    #     input mix + the vocals-separator model id, so a repeat alignment
    #     of the same mix skips the separator.
    #   - `alignment/`: the forced-alignment result JSON keyed by SHA-256
    #     of the input audio + the aligner version + a hash of the caller's
    #     lyrics text + language, so an identical repeat request skips the
    #     GPU entirely.
    # Both are bounded by their `*_cap_bytes` with LRU-by-last-access
    # eviction; safe to nuke at any time, entries refill on demand. See
    # `app/cache.py`.
    cache_dir: Path = Path("/cache")
    cache_vocals_cap_bytes: int = 5 * 1024 * 1024 * 1024  # 5 GB
    # Alignment JSON is small (KB per song); a modest cap holds many
    # thousands of results.
    cache_alignment_cap_bytes: int = 256 * 1024 * 1024  # 256 MB

    # --- HTTP ---
    # The hosted web app is same-origin (no CORS needed); these cover the local
    # dev frontend and the Tauri mobile/desktop shells, whose webview origin is
    # `http://tauri.localhost` (Android/Linux/Windows) or `tauri://localhost`
    # (iOS/macOS) and is therefore cross-origin to a remote aligner.
    cors_origins: list[str] = [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ]

    # Which role this process is playing inside a multi-process deployment:
    # - `pipeline` (default) = eager-loads the separation model and serves
    #                          `/lyrics/align`. Single-process local runs
    #                          leave it here.
    # - `api`                = no model load; serves the lightweight control
    #                          endpoints (`/health`) so they stay responsive
    #                          while the pipeline worker's GIL is pinned.
    worker_role: Literal["pipeline", "api"] = "pipeline"

    # --- GPU ---
    # `auto` = detect CUDA / MPS / CPU; `cuda`, `cpu`, `mps` for explicit.
    device: str = "auto"

    # --- Lyrics alignment ---
    # ISO-639-1 language hint for the /lyrics/align endpoint. Empty
    # string = detect from the caller's lyric text
    # (`_detect_language_from_text`); set explicitly to override that
    # (e.g. to force a specific same-script language uroman would
    # otherwise guess).
    whisper_language: str = ""


settings = Settings()
