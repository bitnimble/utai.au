# utai.au, agent guide

Browser-based **karaoke** tool built on word-level lyrics alignment: load
an audio track, import lyrics (LRCLIB or pasted), and get a lyrics track
whose word chips are time-aligned to the vocal, each chip's position and
width track when and how long each word is sung, over the audio waveform.
Runs as a website (with WebGPU/WebNN local ML on the roadmap) or as a
Tauri desktop/Android app with a local Python ML sidecar.

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
*code*: `frontend/src/`, `frontend/public/`, `frontend/index.html`),
**`src-tauri/`** (the Rust desktop/Android shell), and **`aligner/`** (the
Python backend/ML, vocal separation + CTC forced alignment). The web
**build configs stay at the repo root** (`vite.config.ts`, `tsconfig.json`,
`bunfig.toml`, `playwright.config.ts`, `.stylelintrc.json`, `.storybook/`),
Vite's `root` points at `frontend/`. So **all `bun run …` commands run from
the repo root**, and the **`src/…` import alias maps to `frontend/src/…`**
(a path written `src/foo` is imported as `src/foo` and lives on disk at
`frontend/src/foo`).

The desktop app is Tauri + a Python sidecar broker (`src-tauri/` +
`frontend/src/desktop/` + `aligner/app/comms/`). The **Android** app reuses
the same shell + frontend but has **no sidecar** (no on-device Python/ML):
it aligns over the HTTP backend, same as the web build. Desktop-only Rust
(sidecar, capability install, portable paths) is `#[cfg(desktop)]`-gated.

## Critical rules (apply to every request)

- **Use `bun`, never npm/yarn. Use `bunx`, never npx.**
- **After any code change, run the post-change checks.**
  - **TypeScript** (`bun run …`, repo root): `typecheck` (tsc `--noEmit`),
    `test` (bun unit tests; trailing args → single-file), `lint:design`
    (stylelint `--fix`). `bun run build` runs lint:design + tsc + Vite in
    one shot, the agent compile-check.
  - **Python**: `scripts/check-py [pytest args]` (ruff `--fix` + pytest in
    `aligner/`, from `aligner/.venv`); `scripts/test-py` (pytest only). Never
    invoke pytest/ruff directly (denied in `.claude/settings.json`).
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
- **Model inference is ONNX; downloads are CAPABILITY-SCOPED.** Every ML
  model runs torch-free on onnxruntime; torch is only for the one-time
  `.onnx` export + the `UTAI_*_ONNX=0` opt-outs. Provisioning MUST be
  capability-scoped (`provision.provision(*capabilities)` +
  `_capability_assets`): a separation-only install must never pull the
  aligner weights. Model URLs / HF ids are `settings.*` build fields
  (config.py), not hardcoded. fp16 is GPU-only. **The HF repo id is a
  placeholder until the real models are uploaded**, see
  [docs/lyrics-alignment.md](docs/lyrics-alignment.md).
- **The timeline is linear time**, "beat" collapses onto "second"; there
  is no musical bar/tempo grid (that was Drumjot-specific). The lyrics
  layout maps `word.startSec/endSec → pixels` linearly.

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
| `bun run typecheck` | tsc `--noEmit`. |
| `bun run test` | bun unit tests. |
| `bun run lint:design` | stylelint `--fix` over `src/**/*.css`. |
| `bun run build` | lint:design + tsc + Vite build. Agent compile-check. |
| `bun run e2e` | Playwright suite. |
| `bun run tauri` | Tauri desktop build (via `scripts/tauri-build.ts`). |
| `bun run android:build` | Android APK. |

**Build-output location (`UTAI_BUILD_DIR`).** Set in `.env` to move the
heavy Rust/Tauri artifacts off the repo disk (maps to `CARGO_TARGET_DIR`).

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
  romaji/furigana, ONNX/accel, capability provisioning, LRCLIB, browser-
  side plans. **Read before touching the pipeline.**
- [docs/design-system.md](docs/design-system.md), design tokens,
  typography classes, shared UI primitives, stylelint rules.
- `research/lyrics-alignment-browser.md`, feasibility of fully in-browser
  alignment (WebGPU/WebNN + onnxruntime-web).
