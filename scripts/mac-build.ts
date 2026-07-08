// Cross-compile the macOS desktop app (.app bundle) from Linux via osxcross, for
// DEV TESTING only -- unsigned, not notarized, no DMG. Emits the `.app` into
// `UTAI_MAC_DIST_DIR` (set in `.env`) if given, else leaves it under the Rust
// target dir.
//
// Unlike the native/Windows builds this ships a *dev* sidecar (see
// prepare-desktop-resources.ts `UTAI_RESOURCE_DEV`): the pure-Python aligner
// source + a macOS `uv`, but NO vendored wheels/models -- the runtime `uv sync`s
// the deps from git and downloads models on first launch (a `devbuild` marker in
// the app resources tells it to; see paths.rs::is_dev_build). So the test Mac
// needs **Xcode Command Line Tools** (git + a C compiler) and a network on first
// run; after that alignment works offline.
//
// The heavy Rust `target/` still honours `UTAI_BUILD_DIR` (see build_env.ts).
//
// One-time host prerequisites (not in the repo):
//   rustup target add aarch64-apple-darwin      # or x86_64-apple-darwin
//   # osxcross toolchain with the macOS SDK extracted from Xcode (Apple's SDK is
//   # not redistributable -- you must supply it): https://github.com/tpoechtrager/osxcross
//   # Then point cargo at its clang/linker for the target, e.g. via ~/.cargo/config
//   # or the CC_*/CARGO_TARGET_*_LINKER env vars. Set OSXCROSS_ROOT to have this
//   # script prepend <root>/bin to PATH and export SDKROOT for you.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildOutputEnv } from './build_env';

const TARGET = process.env.UTAI_MAC_TARGET?.trim() || 'aarch64-apple-darwin';
const APP_NAME = 'utai.au.app'; // matches productName in tauri.conf.json
// arm64 macOS starts at 11.0; Intel can go lower. Used for both the cross
// deployment target and the bundle's LSMinimumSystemVersion.
const MAC_MIN_VERSION = TARGET.startsWith('aarch64') ? '11.0' : '10.13';

// --- resolve the macOS `uv` to bundle (a Linux uv won't run in a .app) -------
function hostUvVersion(): string {
  const r = spawnSync('uv', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[mac-build] host `uv` not found; install uv (https://docs.astral.sh/uv/)');
    process.exit(1);
  }
  const m = r.stdout.match(/uv\s+(\d+\.\d+\.\d+)/);
  if (!m) {
    console.error(`[mac-build] could not parse uv version from: ${r.stdout.trim()}`);
    process.exit(1);
  }
  return m[1];
}

// Set when fetchMacUv downloads (not on the UTAI_MACOS_UV override path); removed
// after the build stages the uv into the bundle.
let macUvTmpDir: string | undefined;

function fetchMacUv(): string {
  const override = process.env.UTAI_MACOS_UV?.trim();
  if (override) {
    if (!existsSync(override)) {
      console.error(`[mac-build] UTAI_MACOS_UV=${override} does not exist`);
      process.exit(1);
    }
    return override;
  }
  const version = hostUvVersion();
  const asset = `uv-${TARGET}.tar.gz`; // uv release assets are named by target triple
  const url = `https://github.com/astral-sh/uv/releases/download/${version}/${asset}`;
  const dir = mkdtempSync(join(tmpdir(), 'utai-macuv-'));
  macUvTmpDir = dir;
  const tarball = join(dir, asset);
  console.error(`[mac-build] downloading macOS uv ${version} (${TARGET})`);
  // curl, not bun's fetch(): fetch() hangs indefinitely on GitHub's release-asset
  // redirect to the signed CDN URL; curl follows it fine.
  const dl = spawnSync('curl', ['-fSL', '--retry', '3', '-o', tarball, url], {
    stdio: 'inherit',
  });
  if (dl.status !== 0) {
    console.error(
      `[mac-build] failed to download ${url}. ` +
        'Set UTAI_MACOS_UV to a macOS uv binary to skip the download.',
    );
    process.exit(1);
  }
  const untar = spawnSync('tar', ['xzf', tarball, '-C', dir], { stdio: 'inherit' });
  if (untar.status !== 0) process.exit(untar.status ?? 1);
  const uv = join(dir, `uv-${TARGET}`, 'uv');
  if (!existsSync(uv)) {
    console.error(`[mac-build] extracted archive but ${uv} is missing`);
    process.exit(1);
  }
  return uv;
}

const macUv = fetchMacUv();

// --- build -------------------------------------------------------------------
const extra = buildOutputEnv();
// If OSXCROSS_ROOT is set, wire cargo + the `cc`/`bindgen` build crates at the
// osxcross toolchain: PATH, the cross linker, CC/CXX/AR, the SDK sysroot, and the
// bindgen clang args (cpal's coreaudio-sys runs bindgen against the CoreAudio
// headers and needs the sysroot). Derive everything from the triple so a x86_64
// target works too; the `ar` carries the SDK's darwin version, so discover it.
const osxcross: Record<string, string> = {};
if (process.env.OSXCROSS_ROOT) {
  const root = process.env.OSXCROSS_ROOT;
  const bin = join(root, 'bin');
  const isArm = TARGET.startsWith('aarch64');
  const clang = isArm ? 'oa64-clang' : 'o64-clang';
  const clangxx = `${clang}++`;
  const arch = isArm ? 'aarch64' : 'x86_64';
  const ar = existsSync(bin)
    ? readdirSync(bin).find((f) => f.startsWith(`${arch}-apple-darwin`) && f.endsWith('-ar'))
    : undefined;
  const under = TARGET.replaceAll('-', '_'); // aarch64_apple_darwin
  const sdk =
    process.env.SDKROOT ??
    (() => {
      const sdks = join(root, 'SDK');
      const d = existsSync(sdks) ? readdirSync(sdks).find((n) => n.startsWith('MacOSX')) : undefined;
      return d ? join(sdks, d) : undefined;
    })();

  osxcross.PATH = `${bin}:${process.env.PATH ?? ''}`;
  osxcross[`CARGO_TARGET_${under.toUpperCase()}_LINKER`] = clang;
  osxcross[`CC_${under}`] = clang;
  osxcross[`CXX_${under}`] = clangxx;
  if (ar) osxcross[`AR_${under}`] = ar;
  // osxcross defaults the min lower, which some objc2/wry APIs don't support.
  osxcross.MACOSX_DEPLOYMENT_TARGET = MAC_MIN_VERSION;
  if (sdk) {
    osxcross.SDKROOT = sdk;
    osxcross.BINDGEN_EXTRA_CLANG_ARGS = `-isysroot ${sdk} --target=${TARGET}`;
  }
}
const env = {
  ...process.env,
  ...extra,
  // Steer prepare-desktop-resources into dev mode + bundle the macOS uv.
  UTAI_RESOURCE_DEV: '1',
  UTAI_RESOURCE_UV: macUv,
  ...osxcross,
};

// `tauri build` on Linux has no macOS bundler (it only offers deb/rpm/appimage),
// so build the raw binary with --no-bundle and hand-assemble the .app below.
const args = ['build', '--target', TARGET, '--no-bundle', ...process.argv.slice(2)];
if (extra.CARGO_TARGET_DIR) console.error(`[mac-build] CARGO_TARGET_DIR=${extra.CARGO_TARGET_DIR}`);
const r = spawnSync('tauri', args, { stdio: 'inherit', env });
if (macUvTmpDir) rmSync(macUvTmpDir, { recursive: true, force: true }); // done with the tarball
if (r.status !== 0) process.exit(r.status ?? 1);

// --- assemble the .app by hand ----------------------------------------------
const releaseDir = join(extra.CARGO_TARGET_DIR ?? join('src-tauri', 'target'), TARGET, 'release');
const binary = join(releaseDir, 'app'); // [[bin]] name in src-tauri/Cargo.toml
if (!existsSync(binary)) {
  console.error(`[mac-build] build succeeded but the binary ${binary} is missing`);
  process.exit(1);
}

const repoRoot = resolve(import.meta.dir, '..');
const resourcesDir = join(repoRoot, 'src-tauri', 'resources');
const conf = JSON.parse(readFileSync(join(repoRoot, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const EXE = 'app'; // CFBundleExecutable = the file in Contents/MacOS

function assembleApp(appDir: string): void {
  rmSync(appDir, { recursive: true, force: true });
  const contents = join(appDir, 'Contents');
  const macos = join(contents, 'MacOS');
  const res = join(contents, 'Resources');
  mkdirSync(macos, { recursive: true });
  mkdirSync(res, { recursive: true });

  copyFileSync(binary, join(macos, EXE));
  chmodSync(join(macos, EXE), 0o755);

  // Runtime resolves BaseDirectory::Resource to Contents/Resources, so the dev
  // sidecar (python/, bin/uv) and the devbuild marker go straight under it.
  for (const name of ['python', 'bin', 'devbuild']) {
    const src = join(resourcesDir, name);
    if (existsSync(src)) cpSync(src, join(res, name), { recursive: true });
  }
  const icon = join(repoRoot, 'src-tauri', 'icons', 'icon.icns');
  if (existsSync(icon)) copyFileSync(icon, join(res, 'icon.icns'));

  writeFileSync(join(contents, 'Info.plist'), infoPlist());
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????');
}

function infoPlist(): string {
  // NSMicrophoneUsageDescription is load-bearing: WKWebView denies getUserMedia
  // outright without it (see src-tauri/Info.plist).
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>en</string>
	<key>CFBundleExecutable</key><string>${EXE}</string>
	<key>CFBundleIdentifier</key><string>${conf.identifier}</string>
	<key>CFBundleName</key><string>${conf.productName}</string>
	<key>CFBundleDisplayName</key><string>${conf.productName}</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>${conf.version}</string>
	<key>CFBundleVersion</key><string>${conf.version}</string>
	<key>CFBundleIconFile</key><string>icon.icns</string>
	<key>LSMinimumSystemVersion</key><string>${MAC_MIN_VERSION}</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSMicrophoneUsageDescription</key><string>utai.au uses your microphone for live karaoke, so you can hear yourself sing over the backing track.</string>
</dict>
</plist>
`;
}

const dist = process.env.UTAI_MAC_DIST_DIR?.trim();
const appDir = dist ? join(resolve(dist), APP_NAME) : join(releaseDir, APP_NAME);
if (dist) mkdirSync(resolve(dist), { recursive: true });
assembleApp(appDir);
console.error(`[mac-build] app : ${appDir} (unsigned; right-click > Open on first launch)`);
