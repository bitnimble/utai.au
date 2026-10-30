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
    # The vocals separator's local filename in `models_dir`: Mel-Band Roformer
    # (MIT; the /music path consumes its `vocals` stem). The field name
    # `demucs_model` is historical (it's a Roformer, not Demucs).
    demucs_model: str = "model_mel_band_roformer.ckpt"

    # --- Model asset sources (build/packaging) ---
    # Every model URL / HF id / repo that the packaged app has baked in lives
    # here so it can be repointed per build (fork, private mirror, staging)
    # without touching code. Defaults are the canonical Utai repos.
    #   - `onnx_repo`: all shipped runtime assets (the fp16 `.onnx` set + the
    #     separation architecture yamls).
    #   - `lyrics_align_model_*`: the /music CTC aligner HF ids (also the
    #     tokenizer source and the shipped `.onnx` filename stem).
    onnx_repo: str = "https://huggingface.co/bitnimble/utai-onnx/resolve/main"
    lyrics_align_model_english: str = "facebook/wav2vec2-large-robust-ft-libri-960h"
    lyrics_align_model_default: str = "MahmoudAshraf/mms-300m-1130-forced-aligner"

    # --- Pitch (f0) analysis ---
    # Two f0 models place lyric words vertically by pitch, both resolved off
    # `onnx_repo` and shipped as-is (fp32):
    #   - `pitch_model_offline`: RMVPE (RVC-community rmvpe.onnx, MIT, ~360 MB) --
    #     octave-robust on separated stems (breath/bleed/falsetto); the offline
    #     stem contour pass (extract_pitch_contour) uses it.
    #   - `pitch_model_live`: SwiftF0 (lars76/swift-f0, MIT, ~400 kB) -- fast /
    #     low-latency, reserved for the live-mic path.
    pitch_model_offline: str = "rmvpe.onnx"
    pitch_model_live: str = "f0_swiftf0.onnx"

    # --- Sung-language ID ---
    # VoxLingua107 ECAPA (SpeechBrain, Apache-2.0, ~80 MB fp32) off `onnx_repo`,
    # run on the vocals stem so the lyrics search prefers native-script lyrics.
    language_id_model: str = "lang_id_voxlingua107_ecapa.onnx"

    # --- Startup provisioning ---
    # Comma-separated capabilities whose models are checked at startup (present,
    # outdated against the remote ETag, or missing) and offered to the user to
    # download (`POST /provision/download`). A capability list (not a flat asset
    # list) keeps provisioning capability-scoped; `lyrics` + `pitch` + `language`
    # each compose `separation`, so the default covers every model. Jobs never
    # download: a model the user hasn't downloaded is simply skipped. A plain string
    # (not `list[str]`) so `STARTUP_CAPABILITIES=lyrics,pitch,beat,language` needs no
    # JSON quoting; parsed by `startup_capability_list`. Empty opts out.
    startup_capabilities: str = "lyrics,pitch,beat,language"
    # Compare each present asset's stored ETag against the remote (HF sets it to the
    # LFS content hash), offering the changed ones as updates. Off => presence-only
    # (prod with baked, immutable models: no per-startup network round-trips).
    provision_update_check: bool = True

    @property
    def startup_capability_list(self) -> list[str]:
        """`startup_capabilities` parsed into individual capability names."""
        return [c.strip() for c in self.startup_capabilities.split(",") if c.strip()]

    # --- Paths (Docker volumes mount these) ---
    models_dir: Path = Path("/models")

    cache_dir: Path = Path("/cache")
    cache_songs_cap_bytes: int = 20 * 1024 * 1024 * 1024  # 20 GB

    # --- Backing video ---
    # yt-dlp format selector + sort for the karaoke backing video: the highest
    # resolution / fps YouTube has, video-only (the audio is the separated stems
    # and the player is muted). `vcodec:vp9` ranks ahead of `res` so SDR VP9
    # beats a higher-res AV1 or HDR (vp9.2/AV1) rung: AV1 lacks hardware decode
    # on older GPUs and in some webviews, and HDR plays washed out in webviews.
    video_format: str = "bv*"
    video_format_sort: list[str] = ["vcodec:vp9", "res", "fps"]

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

    # Origin advertised in the join QR, e.g. `https://karaoke.lan:5175`;
    # empty = the host's page origin. `{lan_ip}` is replaced per request with the
    # machine's current LAN address (the desktop app's session gateway).
    public_url: str = ""

    # Which role this process is playing inside a multi-process deployment:
    # - `pipeline` (default) = eager-loads the separation model and serves
    #                          `/music/align`. Single-process local runs
    #                          leave it here.
    # - `api`                = no model load; serves the lightweight control
    #                          endpoints (`/health`) so they stay responsive
    #                          while the pipeline worker's GIL is pinned.
    worker_role: Literal["pipeline", "api"] = "pipeline"

    # --- GPU ---
    # `auto` = detect CUDA / MPS / CPU; `cuda`, `cpu`, `mps` for explicit.
    device: str = "auto"

    # --- Lyrics alignment ---
    # ISO-639-1 language hint for the /music/align endpoint. Empty
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
    # Facade-owned, NON-secret prefs (service priority order). Credentials
    # themselves live only in OnTheSpot's own config, never here.
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
    # Where OnTheSpot writes its downloads, as this process sees that directory
    # (the same volume, mounted at the same path). Set, a finished track moves
    # into its song's folder and jobs read it there instead of taking it
    # re-uploaded. OnTheSpot's own files in here get moved, so this must be a
    # directory only OnTheSpot writes to.
    music_download_dir: Path | None = None


settings = Settings()
