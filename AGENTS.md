# utai.au, agent guide

Browser-based **karaoke** tool built on word-level lyrics alignment: load
an audio track, import lyrics (LRCLIB or pasted), and get a lyrics track
whose word chips are time-aligned to the vocal, each chip's position and
width track when and how long each word is sung, over the audio waveform.
Runs as a website or as a Tauri desktop/Android app (desktop runs the
Python ML backend locally).

It reuses the lyrics-alignment tech from the sibling **Drumjot** project;
the domain knowledge lives in [docs/lyrics-alignment.md](docs/lyrics-alignment.md), read it before touching the alignment pipeline.

> `CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`.
>
> Cross-project conventions (close-the-loop, naming, run-the-checks,
> LSP-first, built-in-tools-over-bash, one-statement-per-Bash-call, the
> store/presenter/component pattern + the DOM-layout-read ban, …) live in
> the user-level `~/.claude/CLAUDE.md` and are **not** repeated here.

## Repo layout

Three components at the repo root: **`frontend/`** (the web UI, all web
*code*: `frontend/src/`, `frontend/index.html`),
**`src-tauri/`** (the Rust desktop/Android shell), and **`aligner/`** (the
Python backend/ML, vocal separation + CTC forced alignment). The web
**build configs stay at the repo root** (`vite.config.ts`, `tsconfig.json`,
`bunfig.toml`, `playwright.config.ts`, `.stylelintrc.json`, `.storybook/`),
Vite's `root` points at `frontend/`. So **all `bun run …` commands run from
the repo root**, and the **`src/…` import alias maps to `frontend/src/…`**
(a path written `src/foo` is imported as `src/foo` and lives on disk at
`frontend/src/foo`).

**Per-song cache.** Everything the backend keeps for a song (fetched track,
stems, backing video, vocals, alignment, beats, pitch, language) lives in
`cache_dir/songs/<song_id>/` and is evicted LRU as a whole song once over
`cache_songs_cap_bytes` (`aligner/app/song_cache.py`).

**One HTTP API on every platform.** The frontend talks to the backend
(`aligner/app/main.py`) only over HTTP, through `backendFetch`; nothing branches
on web vs desktop. The desktop app is standalone: `src-tauri/src/local_backend.rs`
syncs the venv (`capability::prepare_venv`) and runs the same backend, plus
OnTheSpot (`aligner/app/music/onthespot_server.py`, downloading into the
backend's `music_download_dir`), as loopback processes, and the frontend's
`apiBase` points at them (a capability install/uninstall restarts them).
Jobs pass audio the backend already holds by path instead of uploading it
(`frontend/src/net/job_audio.ts`). The venv also carries ffmpeg
(imageio-ffmpeg, which startup links to `<data>/bin/ffmpeg`, put first on PATH)
and deno (yt-dlp's JS runtime for YouTube). The **Android** app reuses
the same shell + frontend but has **no local backend** (no on-device Python/ML):
it uses a hosted one, whose address the launch setup screen asks for
(`frontend/src/server_setup/`, changeable in Settings > Server); `scripts/android-tv.ts`
allows cleartext in every Android build so that server can be plain http on the LAN. Desktop-only Rust
(local backend, capability install, live-mic pitch, portable paths, session
gateway) is `#[cfg(desktop)]`-gated.

### Sessions

The website's `/` offers Create a session or Join one as a remote. `/session/<ID>`
is the playback host (the full player); `/session/<ID>/remote` is a phone
remote (queue, search, history, transport, volume, vocals on/off + level). The desktop and Android apps skip
the landing page and host their own session at launch. The host owns the queue
and playback and does all backend work (search included; remotes may only add
tracks the host's own search returned or it already played); the session server
(`aligner/app/sessions.py`, in-memory, 1h idle expiry) is a dumb relay
between host and remotes. Creating a session returns a host token, kept in
localStorage, that a host socket must present; a host whose session the relay
lost creates a new one and keeps its queue. On desktop the relay is the local
backend's; phones reach it through the Rust LAN gateway
(`src-tauri/src/session_gateway.rs`, `0.0.0.0:7337`, `UTAI_SESSION_PORT`), which
serves the remote page and forwards `/api/sessions*` to the loopback backend;
the rest of `/api` only to this machine's own `localhost:7337` page (Host,
Origin and Sec-Fetch-Site checked), so the full app also works in a browser
there. Until its backend first comes up, the desktop host shows a blocking
starting screen (Settings stays reachable), then attaches its session.
Advertised join URLs come from the backend's `PUBLIC_URL`
(`{lan_ip}` is filled in per request; desktop sets
`http://{lan_ip}:<gateway port>`), overridable per host in the join dialog. The backend's GPU lock serves
waiting jobs round-robin across sessions, keyed by the `X-Utai-Session`
header `backendFetch` attaches.

### Releases, updates, logs, TV

- **Version** lives in `package.json` alone (`tauri.conf.json` reads it).
  `bun run release [version]` (on `main`, clean tree) bumps it, has `claude -p`
  write the user-facing changelog of the commits since the last `v*` tag
  (`scripts/changelog.ts`) into `changelog.json`, commits, and tags `v<version>`.
  `git push --follow-tags` starts `.github/workflows/release.yml`, on `main` so its
  caches carry over between releases: the tag must be pushed with its commit, as the tip.
- **CI** (`release.yml`) builds the backend + OnTheSpot images
  (`ghcr.io/bitnimble/utai.au-{backend,onthespot}`), macOS arm64 (`.dmg`),
  Windows (NSIS + portable zip) and a debug-key-signed Android APK, then
  uploads one GitHub release whose body is the changelog plus a `latest.json`
  (`scripts/write-update-manifest.ts`), as a draft that is published only once
  every build succeeded and both desktop bundles are signed. No Linux, no Play.
  A manual run builds without publishing or pushing images (`only` narrows it). Secrets:
  `TAURI_SIGNING_PRIVATE_KEY` signs updater bundles (`_PASSWORD` stays unset:
  the key has none, and a missing secret reaches the build as empty); the
  public key is in `tauri.conf.json`; `ANDROID_DEBUG_KEYSTORE_BASE64` keeps one
  debug key so APKs install over each other. No Apple Developer ID: the macOS
  app builds ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), then the
  `sign-macos` job re-signs it with a self-signed certificate (CN `utai.au`,
  `MACOS_CERTIFICATE_BASE64` + `MACOS_CERTIFICATE_PASSWORD` in the
  `macos-signing` environment) so microphone grants survive updates. Either
  way a downloaded copy opens via System Settings > Privacy & Security > Open
  Anyway.
- **Updates** (`frontend/src/updates/`): the app checks the GitHub releases API
  at launch and hourly; Settings > Updates lists newer releases' notes. Desktop
  installs via `tauri-plugin-updater` (`src-tauri/src/updates.rs`); the portable
  Windows build and Android open the download instead.
- **Logs**: the page keeps its last 2000 console lines (`log_viewer/page_log.ts`);
  the desktop shell's Rust + backend output goes to the log file
  `read_log_tail` reads. Settings > Logs shows either.
- **Android TV**: `scripts/android-tv.ts` patches the regenerated `gen/android`
  (banner, touchscreen optional, a `MainActivity` adding `UtaiTV` to the user
  agent, routing Back to `window.utaiBack` and media buttons to `window.utaiKey`)
  on every `tauri-build.ts android …` run. On a TV the page's `followRemote()`
  (`frontend/src/tv_remote/`) moves focus geometrically with the D-pad; Back sends
  Escape, so anything closable on Escape closes on Back; media buttons arrive as
  their standard `Media*` keydowns, which the player maps to transport (as it does
  a keyboard's media keys).

## Critical rules (apply to every request)

- **Use `bun`, never npm/yarn. Use `bunx`, never npx.**
- **After any code change, run the post-change checks.**
  - **TypeScript** (`bun run …`, repo root): `typecheck` (tsrs `--noEmit`,
    the Rust port of tsc; `bun run tsc …` runs it with any tsc flags),
    `test` (bun unit tests; trailing args → single-file), `lint:design`
    (stylelint `--fix`). `bun run build` runs lint:design + tsrs + Vite in
    one shot, the agent compile-check.
  - **Python**: `scripts/check-py [pytest args]` (ruff `--fix` + pytest in
    `aligner/`, from `aligner/.venv`); `scripts/test-py` (pytest only). Never
    invoke pytest/ruff directly (denied in `.claude/settings.json`).
- **In a paseo worktree, `aligner/.venv` is a symlink to the main checkout's
  venv, shared by every worktree.** Never `uv sync`/`uv add`/`pip install`
  into it: that changes it for all of them. If your branch needs different
  deps, delete the symlink and build a fresh venv in the worktree
  (`cd aligner && uv sync`). Its editable `utai-aligner` install points at
  the main checkout's `aligner/`: `scripts/check-py` still tests the
  worktree's code (pytest puts the worktree's `aligner/` first on
  `sys.path`), but importing `app` from outside `aligner/` gets main's copy.
- **Don't run `bun run dev`** (human-only watch). For a compile smoke test
  use **`bun run build`**.
- **Any front-end change reruns the e2e suite.** After touching `src/**` or
  `tests/**`, run **`bun run e2e`** (Playwright, Chromium). E2E specs live
  at `src/<feature>/test/*.e2e.ts`. Two projects (`playwright.config.ts`):
  `functional` (parallel) and `perf` (runs after functional). Needs the
  one-time `bunx playwright install chromium` + `sudo bunx playwright
  install-deps chromium`.
- **No naked color literals in CSS modules**, `bun run lint:design` fails
  on hex/`rgb()`/`hsl()` outside `src/design_tokens.css`. Typography goes
  through `composes:` from `src/typography.module.css`; shared UI primitives
  live under `src/ui/<component>/`. See [docs/design-system.md](docs/design-system.md).
- **Frame budget is 120 fps / 8.3 ms** (165 Hz monitor).
- **Browsers: evergreen, last 2 years** (`package.json` `browserslist`).
  Modern web APIs, no polyfills.
- **The aligner is pure Python**, no bun/TS in its runtime. It runs vocal
  separation + CTC forced alignment and returns word-timed lyric lines.
- **Model inference is ONNX ONLY; the runtime NEVER imports torch.** Every
  ML model runs torch-free on onnxruntime, on a CUDA box separation
  auto-rides the **TensorRT** EP (engine cached under `cache_dir/tensorrt`),
  CUDA/CoreML otherwise. torch exists SOLELY for the BUILD side: the one-time
  `.onnx` export (`separation/export.py`, `lyrics_onnx.export_ctc_model`) and the
  offline torch<->ONNX parity checks (`tests/test_separation_parity.py` via
  `separation/loader.py` + `runner.py`). There is NO runtime torch path anymore;
  keep any torch import lazy (inside the export branch, not module top).
  `tests/test_torch_free_runtime.py` fails `scripts/check-py` if the runtime
  import graph pulls torch in. Downloads are CAPABILITY-SCOPED
  (`provision.provision(*capabilities)` + `_capability_assets`): a
  separation-only install must never pull the aligner weights. Model URLs / HF
  ids are `settings.*` build fields (config.py), not hardcoded. fp16 is
  GPU-only. Shipped weights live on HF (`settings.onnx_repo`,
  `bitnimble/utai-onnx`). At startup the backend **checks**
  `settings.startup_capabilities` (default `lyrics,pitch,beat,language` = every model),
  **update-checking** each present asset via its ETag, and loads what's on disk;
  the frontend downloads missing/outdated models (`POST /provision/download`)
  when the user accepts the toast's prompt, on web and desktop alike. **A job
  never downloads a model**: without its models it's refused (424) and the song
  plays its full mix; see
  [docs/lyrics-alignment.md](docs/lyrics-alignment.md).
- **The timeline is linear time**, "beat" collapses onto "second"; there
  is no musical bar/tempo grid (that was Drumjot-specific). The lyrics
  layout maps `word.startSec/endSec → pixels` linearly.
- **Referenced thing missing? Check worktree divergence from local `main`
  first.** If the user points at something specific that's nowhere in the
  tree, we may be on a worktree branched off an earlier `main` that predates
  it, `git log --oneline main..HEAD` / `HEAD..main` before concluding it
  doesn't exist.

### Frontend store / presenter / component architecture

Strict three-layer split: per-domain data **stores** (MobX observables +
computeds only), **presenters** (all mutations, reactions, orchestration),
and **components** (read stores, call presenters). Grouped by feature
folder under `src/`. Shared UI primitives in `src/ui/<component>/`. See the
cross-project rules in `~/.claude/CLAUDE.md` for the full contract.

## Build / test / run

Frontend (`bun`, repo root):

| Command | What it does |
|---|---|
| `bun install` | Install deps. |
| `bun run typecheck` | tsrs `--noEmit`. |
| `bun run tsc …` | tsrs with any tsc flags. |
| `bun run test` | bun unit tests. |
| `bun run lint:design` | stylelint `--fix` over `src/**/*.css`. |
| `bun run build` | lint:design + tsrs + Vite build. Agent compile-check. |
| `bun run e2e` | Playwright suite. |
| `bun run tauri` | Tauri desktop build (via `scripts/tauri-build.ts`). |
| `bun run wasm:build` | Rebuild the committed `track_effects.wasm` from `src-tauri/crates/audio` (run after changing a track effect; the web AudioWorklet runs the same Rust effect chain as the desktop mixer). |
| `bun run android:init` | Generate `src-tauri/gen/android` (gitignored), TV-patched. |
| `bun run android:build` | Android APK. |
| `bun run release [version]` | Bump, write the changelog, commit + tag `v<version>`. |
| `bun run win:build` | **Cross-build** the Windows app (binary + NSIS installer) from Linux via cargo-xwin, no Wine. |
| `bun run mac:build` | **Cross-build** the macOS `.app` (dev testing only) from Linux via osxcross. Unsigned, no DMG. |

**Build-output location (`UTAI_BUILD_DIR`).** Set in `.env` to move the
heavy Rust/Tauri artifacts off the repo disk (maps to `CARGO_TARGET_DIR`).

**Windows cross-build (`win:build`).** Emits `Utai.exe` + the NSIS `*-setup.exe`
to `UTAI_WIN_DIST_DIR` (set in `.env`, e.g. a `/codebox-workspace` path reachable
over SMB from Windows). Drops the Python backend resources (can't cross-stage a
Windows Python), so **alignment, music search and downloads are unavailable in
this build**; audio + UI work.
One-time host prereqs: `rustup target add x86_64-pc-windows-msvc`, `cargo install
--locked cargo-xwin`, `apt install clang llvm lld nsis`, and
`ln -sf "$(which makensis)" /usr/local/bin/makensis.exe` (Tauri runs `makensis.exe`).

**macOS cross-build (`mac:build`), dev only.** Emits an unsigned `utai.au.app`
(no DMG, no notarization) to `UTAI_MAC_DIST_DIR` (`.env`) if set, else the target
dir. Unlike `win:build` it DOES ship the backend, but as a **dev bundle**: the
pure-Python aligner source + a downloaded macOS `uv`, and NO vendored
wheels/models. A `devbuild` marker resource makes the runtime `uv sync` the deps
from git (`paths.rs::is_dev_build`) on launch, before the backend starts
(`capability::prepare_venv`); the models then download when accepted from the toast.
So the **test Mac needs Xcode Command Line Tools** (git + a compiler) and a
network on first run. `prepare-desktop-resources.ts` produces this variant
when `UTAI_RESOURCE_DEV=1` (skips wheel vendoring, keeps the torch-null override,
bundles `UTAI_RESOURCE_UV`). One-time host prereqs: `rustup target add
aarch64-apple-darwin`, an osxcross toolchain with the **Xcode-extracted macOS SDK**
(Apple's SDK isn't redistributable), and cargo pointed at its clang/linker (set
`OSXCROSS_ROOT` for the script to wire PATH + `SDKROOT`). The osxcross setup +
whether `tauri build` will emit the `.app` on Linux is the **untested** part.

**Sandbox** (`sandbox/Dockerfile`): a throwaway CUDA + Python container
carrying the aligner dep stack plus `bun`. Container name `utai-sandbox`.
- `scripts/sandbox-py '<code>' [argv…]`, `python3 -c` in the container.
- `scripts/sandbox-bun '<code>' [argv…]`, `bun -e`.
- `scripts/sandbox-run <cmd…>`, exec any command.
Pass non-trivial code as a file under the gitignored `tmp/` folder (random
name), not inline. Do NOT use a `tmp_*`-prefixed path (denied).

## Detailed docs (pull in when relevant)

- [docs/lyrics-alignment.md](docs/lyrics-alignment.md), the alignment
  domain: models (BS-Roformer, wav2vec2/MMS CTC), pipeline stages, JP
  romaji/furigana, ONNX/accel, capability provisioning, LRCLIB.
  **Read before touching the pipeline.**
- [docs/design-system.md](docs/design-system.md), design tokens,
  typography classes, shared UI primitives, stylelint rules.
