// Cross-compile the Windows desktop app (runnable binary + NSIS installer) from
// Linux via cargo-xwin, no Wine. Emits both into `UTAI_WIN_DIST_DIR` (set in
// `.env`, e.g. a `/codebox-workspace` path reachable over SMB from Windows) so a
// build here can be launched straight from Windows.
//
// The heavy Rust `target/` still honours `UTAI_BUILD_DIR` (see build_env.ts);
// only the two final artifacts land in `UTAI_WIN_DIST_DIR`.
//
// The ML sidecar resources (`python/`, `bin/`) are dropped: they can't be
// cross-staged for Windows from a Linux host, so *lyrics alignment is
// unavailable* in this build. Audio + the rest of the UI work. Staging a Windows
// Python for a full build is a follow-up.
//
// One-time host prerequisites (not in the repo):
//   rustup target add x86_64-pc-windows-msvc
//   cargo install --locked cargo-xwin
//   sudo apt install clang llvm lld nsis
//   sudo ln -sf "$(which makensis)" /usr/local/bin/makensis.exe   # Tauri runs `makensis.exe`
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildOutputEnv } from './build_env';

const TARGET = 'x86_64-pc-windows-msvc';

const dist = process.env.UTAI_WIN_DIST_DIR?.trim();
if (!dist) {
  console.error('[win-build] UTAI_WIN_DIST_DIR is not set (add it to .env, e.g. /codebox-workspace/utai-windows)');
  process.exit(1);
}

const extra = buildOutputEnv();
const env = { ...process.env, ...extra };
const config = JSON.stringify({
  // Frontend build only: skip desktop:resources (host-Python staging) since the
  // sidecar isn't bundled in the cross build.
  build: { beforeBuildCommand: 'bun run build' },
  bundle: { resources: [] },
});
const args = [
  'build',
  '--runner', 'cargo-xwin',
  '--target', TARGET,
  '--bundles', 'nsis',
  '--config', config,
  ...process.argv.slice(2),
];
if (extra.CARGO_TARGET_DIR) console.error(`[win-build] CARGO_TARGET_DIR=${extra.CARGO_TARGET_DIR}`);
const r = spawnSync('tauri', args, { stdio: 'inherit', env });
if (r.status !== 0) process.exit(r.status ?? 1);

const releaseDir = join(extra.CARGO_TARGET_DIR ?? join('src-tauri', 'target'), TARGET, 'release');
const outDir = resolve(dist);
mkdirSync(outDir, { recursive: true });

const exe = join(releaseDir, 'app.exe');
if (!existsSync(exe)) {
  console.error(`[win-build] build succeeded but ${exe} is missing`);
  process.exit(1);
}
// Runnable directly (embedded UI + WebView2 runtime on the target); no install
// needed. Named friendlier than `app.exe`.
copyFileSync(exe, join(outDir, 'Utai.exe'));

const nsisDir = join(releaseDir, 'bundle', 'nsis');
const installer = existsSync(nsisDir)
  ? readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe'))
  : undefined;
if (installer) copyFileSync(join(nsisDir, installer), join(outDir, installer));

console.error(`[win-build] binary    : ${join(outDir, 'Utai.exe')}`);
console.error(`[win-build] installer : ${installer ? join(outDir, installer) : '(none produced)'}`);
