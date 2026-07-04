import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Build-output relocation. `UTAI_BUILD_DIR` (set in `.env`, e.g. to a roomy
 * `/codebox-workspace` path) moves the heavy Rust/Tauri build artifacts off the
 * repo and the local disk. It maps to `CARGO_TARGET_DIR`, which covers the
 * whole `target/` tree (the bulk, ~17 GB across the desktop + Android NDK
 * targets), desktop bundles (`$CARGO_TARGET_DIR/release/bundle`), every Android
 * `.so`, and the wdio build. Unset means the in-repo default
 * (`src-tauri/target`). The gradle-packaged Android APK is handled separately
 * by {@link relocateAndroidArtifacts} (CARGO_TARGET_DIR can't reach it).
 */
export function buildOutputEnv(): Record<string, string> {
  const dir = process.env.UTAI_BUILD_DIR?.trim();
  if (!dir) return {};
  return { CARGO_TARGET_DIR: resolve(dir, 'cargo-target') };
}

const ANDROID_OUTPUTS = 'src-tauri/gen/android/app/build/outputs';

/**
 * Move the gradle-packaged Android artifacts into `$UTAI_BUILD_DIR/{apk,aab}`.
 * `CARGO_TARGET_DIR` can't reach them, they land in the gitignored
 * `gen/android/app/build/outputs`, so this finishes the redirect and gives one
 * stable install location off the repo. No-op when `UTAI_BUILD_DIR` is unset.
 * Copy + unlink rather than rename, since the build dir is usually a different
 * mount than `gen/android`.
 */
export function relocateAndroidArtifacts(): void {
  const dir = process.env.UTAI_BUILD_DIR?.trim();
  if (!dir) return;
  const root = resolve(dir);
  for (const [sub, ext] of [['apk', '.apk'], ['bundle', '.aab']] as const) {
    const dest = join(root, ext.slice(1));
    for (const file of filesByExt(join(ANDROID_OUTPUTS, sub), ext)) {
      mkdirSync(dest, { recursive: true });
      const target = join(dest, basename(file));
      copyFileSync(file, target);
      unlinkSync(file);
      console.error(`[tauri-build] moved ${basename(file)} -> ${target}`);
    }
  }
}

const PORTABLE_APP_NAME = 'Utai';

/**
 * Assemble the portable (no-installer) Windows build and zip it. Lays the app
 * exe + the bundled `python/` and `bin/` resources out exactly as the installed
 * app resolves them (BaseDirectory::Resource -> next to the exe), plus a
 * `portable` marker file that flips the app into keep-all-writable-state-under-
 * `<exe>/data` mode (see src-tauri/src/paths.rs). Windows-only: the macOS .app +
 * the Linux AppImage already run in place. Runs automatically after a successful
 * `tauri build` (see tauri-build.ts), so no separate manual step. Respects
 * CARGO_TARGET_DIR, so it works under UTAI_BUILD_DIR (the old ps1 assumed the
 * in-repo target dir and broke there).
 */
export function assemblePortableWindows(cargoTargetDir?: string): void {
  const releaseDir = cargoTargetDir
    ? join(cargoTargetDir, 'release')
    : join('src-tauri', 'target', 'release');
  const resourcesDir = join('src-tauri', 'resources');
  const portableDir = join(releaseDir, 'portable');
  const zipPath = join(releaseDir, `${PORTABLE_APP_NAME}-portable-windows.zip`);

  const exe = join(releaseDir, 'app.exe');
  if (!existsSync(exe)) {
    throw new Error(`portable: app.exe not found at ${exe}; the desktop build did not produce it`);
  }
  for (const sub of ['python', 'bin']) {
    if (!existsSync(join(resourcesDir, sub))) {
      throw new Error(`portable: resources/${sub} missing; run 'bun run desktop:resources' first`);
    }
  }

  rmSync(portableDir, { recursive: true, force: true });
  mkdirSync(portableDir, { recursive: true });
  // Rename app.exe -> product name for a friendlier drop; resources resolve by
  // directory, not exe name, so the rename is safe.
  copyFileSync(exe, join(portableDir, `${PORTABLE_APP_NAME}.exe`));
  // Loose runtime DLLs beside the exe (e.g. WebView2Loader.dll when not static).
  for (const f of readdirSync(releaseDir)) {
    if (f.toLowerCase().endsWith('.dll')) copyFileSync(join(releaseDir, f), join(portableDir, f));
  }
  cpSync(join(resourcesDir, 'python'), join(portableDir, 'python'), { recursive: true });
  cpSync(join(resourcesDir, 'bin'), join(portableDir, 'bin'), { recursive: true });
  writeFileSync(join(portableDir, 'portable'), '');

  rmSync(zipPath, { force: true });
  compressArchive(join(portableDir, '*'), zipPath);
  console.error(`[tauri-build] portable build : ${portableDir}`);
  console.error(`[tauri-build] portable zip   : ${zipPath}`);
}

/** Zip via PowerShell's Compress-Archive (no third-party dep; Windows-only path).
 *  Prefers pwsh (PowerShell 7), falls back to Windows PowerShell 5.1. */
function compressArchive(src: string, dest: string): void {
  const command = `Compress-Archive -Path '${src}' -DestinationPath '${dest}' -Force`;
  for (const shell of ['pwsh', 'powershell']) {
    const r = spawnSync(shell, ['-NoProfile', '-Command', command], { stdio: 'inherit' });
    if (r.status === 0) return;
    // Shell not installed -> try the next; any other failure is a real error.
    if ((r.error as { code?: string } | undefined)?.code === 'ENOENT') continue;
    throw new Error(`portable: ${shell} Compress-Archive failed (exit ${r.status})`);
  }
  throw new Error('portable: neither pwsh nor powershell found to create the zip');
}

function filesByExt(root: string, ext: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((entry) => {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) return filesByExt(p, ext);
    return p.endsWith(ext) ? [p] : [];
  });
}
