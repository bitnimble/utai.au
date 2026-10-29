// Builds the native audio crate's effects (src-tauri/crates/audio, `wasm.rs`)
// to WASM for the web build's AudioWorklet, and writes it next to the worklet.
// The .wasm is committed so web builds need no Rust toolchain; rerun after
// changing the effect. Needs `rustup target add wasm32-unknown-unknown`.
import { copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const targetDir = join(root, 'tmp', 'wasm-target');
const dest = join(root, 'frontend', 'src', 'editing', 'playback', 'surround_reverb.wasm');

const build = Bun.spawnSync(
  [
    'cargo',
    'rustc',
    '--manifest-path',
    join(root, 'src-tauri', 'crates', 'audio', 'Cargo.toml'),
    '--release',
    '--lib',
    '--crate-type',
    'cdylib',
    '--target',
    'wasm32-unknown-unknown',
    '--target-dir',
    targetDir,
    '--config',
    'profile.release.lto=true',
    '--config',
    'profile.release.codegen-units=1',
    '--config',
    'profile.release.strip=true',
    '--config',
    'profile.release.panic="abort"',
  ],
  { stdio: ['inherit', 'inherit', 'inherit'] },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);

await copyFile(join(targetDir, 'wasm32-unknown-unknown', 'release', 'utai_audio.wasm'), dest);
console.log(`[effect-wasm] wrote ${dest}`);
