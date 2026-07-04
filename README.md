# utai.au

A browser-based **karaoke** tool built on word-level lyrics alignment.
Load an audio track, import lyrics (from [LRCLIB](https://lrclib.net) or by
pasting), and get a lyrics track whose word chips are time-aligned to the
vocal, each chip's position and width follow when and how long each word
is sung, over the audio waveform. Runs as a website or as a Tauri
desktop/Android app with a local Python ML sidecar.

The lyrics-alignment tech is shared with the sibling **Drumjot** project.

## Develop

```bash
bun install
bun run build     # lint:design + tsc + Vite, the compile check
bun run test      # unit tests
bun run e2e       # Playwright suite
```

`bun run dev` starts the Vite dev server (human use). The Python
backend lives in `aligner/`; the desktop shell in `src-tauri/`.

See [AGENTS.md](AGENTS.md) for the full agent/contributor guide and
[docs/lyrics-alignment.md](docs/lyrics-alignment.md) for the alignment
pipeline (models, stages, ONNX, provisioning).
