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

    # --- Separation model ---
    # The vocals separator is NOT in audio-separator's registry;
    # `pipeline/provision.py` injects it and downloads its weights on startup.
    # This value is the *local* filename it writes into `models_dir`.
    # `model_mel_band_roformer.ckpt` = Mel-Band Roformer (MIT; the /lyrics path
    # consumes its `vocals` stem). The field name `demucs_model` is historical
    # (it's a Roformer now, not Demucs).
    demucs_model: str = "model_mel_band_roformer.ckpt"

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

    # --- Pitch (f0) analysis ---
    # Two f0 models place lyric words vertically by pitch, both resolved off
    # `onnx_repo` and shipped as-is (fp32):
    #   - `pitch_model_offline`: RMVPE (RVC-community rmvpe.onnx, MIT, ~360 MB) --
    #     octave-robust on separated stems (breath/bleed/falsetto); the offline
    #     stem pass (attach_pitch) uses it.
    #   - `pitch_model_live`: SwiftF0 (lars76/swift-f0, MIT, ~400 kB) -- fast /
    #     low-latency, reserved for the live-mic path.
    pitch_model_offline: str = "rmvpe.onnx"
    pitch_model_live: str = "f0_swiftf0.onnx"

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
    # dev (5174) and preview (5173) frontends and the Tauri mobile/desktop
    # shells, whose webview origin is `http://tauri.localhost`
    # (Android/Linux/Windows) or `tauri://localhost` (iOS/macOS) and is
    # therefore cross-origin to a remote aligner.
    cors_origins: list[str] = [
        "http://localhost:5174",
        "http://127.0.0.1:5174",
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
    align_language: str = ""

    # --- Music source (OnTheSpot) ---
    # Base URL of the OnTheSpot headless web API (its Flask server). The music
    # facade (app/music/) proxies search / download / account ops to it. In the
    # dev compose this is the `onthespot` service; override per deployment.
    onthespot_base_url: str = "http://onthespot:5000"
    # Per-request timeout (seconds) for calls to the OnTheSpot API. A track
    # download can take a while, but the facade polls the queue in short GETs
    # rather than holding one long request, so this stays modest.
    onthespot_timeout_sec: float = 30.0
    # How long the facade polls OnTheSpot's download queue before giving up on a
    # fetch (seconds), and the poll interval. A fetch that outlives this yields a
    # timeout error rather than streaming forever.
    music_fetch_timeout_sec: float = 20 * 60.0
    music_poll_interval_sec: float = 1.0
    # Facade-owned, NON-secret prefs: service priority order, per-service enabled
    # flags, and quality. Credentials themselves live only in OnTheSpot's own
    # config, never here.
    music_config_path: Path = Path("/config/music_config.json")
    # OnTheSpot's own config file (its account pool + credentials), shared with
    # the OnTheSpot container via a volume so the facade can read the account
    # list (service -> active-account index) and seed the anonymous YouTube Music
    # account. This is OnTheSpot's `ONTHESPOTDIR/otsconfig.json`.
    onthespot_config_path: Path = Path("/config/otsconfig.json")
    # Host port the dev harness publishes OnTheSpot's own web UI on. It gets its
    # OWN origin (not a sub-path of the app): OnTheSpot's Flask UI emits
    # root-absolute URLs and a root-relative `/login` redirect that a stripped
    # sub-path would send to the SPA instead. The `/music/accounts` route builds
    # the interactive-login `authUrl` from the request host + this port.
    onthespot_public_port: int = 5176


settings = Settings()
