// Stages the Python backend + the `uv` binary into src-tauri/resources/ so a
// packaged build can self-install capabilities on a clean machine -- with NO
// system git and NO C compiler needed at runtime. Wired into tauri.conf's
// beforeBuildCommand; a no-op for `tauri dev`, which uses the in-repo
// ../aligner directly.
//
// The aligner pins a few deps to git. To avoid requiring git + a toolchain on
// the user's machine, we prebuild those as wheels here (build host has git + a
// compiler), bundle the wheelhouse, rewrite the bundled pyproject to install
// them from there (find-links + pinned versions), pin Python to match the wheel
// ABI, and re-lock. Runtime `uv sync` then installs everything from wheels.
//
// Layout produced (mirrored into the app's $RESOURCE/ at bundle time):
//   resources/python/aligner/{pyproject.toml,uv.lock,app/,wheels/}
//   resources/bin/uv[.exe]                                (host uv, if found)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// App venv Python. Pins the prebuilt-wheel ABI (cp311) and the runtime venv so
// they match; keep in sync with the Rust installer's `uv sync --python`.
const PY = '3.11';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'src-tauri', 'resources');
const pyOut = join(out, 'python');
const binOut = join(out, 'bin');
const wheelCache = join(out, 'wheel-cache'); // persists across builds; not bundled
const devMarker = join(out, 'devbuild');

// Dev cross-build (scripts/mac-build.ts): ship the aligner source + a target `uv`
// but DON'T vendor the git deps as wheels -- the runtime `uv sync`s them from git
// on first launch (needs git + a compiler on the test machine). `UTAI_RESOURCE_UV`
// is the target-platform `uv` to bundle (host `uv` is still used for `uv lock`);
// unset means bundle the host `uv` (a native desktop build).
const DEV = process.env.UTAI_RESOURCE_DEV === '1';
const bundledUvSrc = process.env.UTAI_RESOURCE_UV?.trim();

const skipJunk = (src: string): boolean =>
  !src.includes('__pycache__') && !src.endsWith('.pyc') && !src.includes('.egg-info');

function findOnPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`command failed (${r.status ?? r.signal}): ${cmd} ${args.join(' ')}`);
  }
}

const depName = (spec: string): string => spec.split('@')[0].trim();
const venvPython = (venv: string): string =>
  join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

// --- stage the Python source (sidecar + pipeline) ---------------------------
await rm(pyOut, { recursive: true, force: true });
await rm(devMarker, { force: true }); // never leave a stale marker on a non-dev build
await mkdir(join(pyOut, 'aligner'), { recursive: true });
await mkdir(binOut, { recursive: true });

await copyFile(join(repo, 'aligner/pyproject.toml'), join(pyOut, 'aligner/pyproject.toml'));
await copyFile(join(repo, 'aligner/uv.lock'), join(pyOut, 'aligner/uv.lock'));
await cp(join(repo, 'aligner/app'), join(pyOut, 'aligner/app'), {
  recursive: true,
  filter: skipJunk,
});

// --- bundle uv (uv fetches its own managed Python when it syncs) ------------
// Host uv drives the build (wheel vendoring + `uv lock`); the bundled copy is
// the TARGET-platform uv (same on a native build; a downloaded macOS uv on a
// cross-build), since a Linux uv won't run inside a macOS .app.
const uv = findOnPath('uv');
if (!uv) {
  // The shipped app can't function without uv: every capability install is a
  // `uv sync`, and the git deps are vendored to wheels here (which needs uv).
  // A `console.warn` here once let a uv-less bundle ship silently broken, so
  // fail the build instead.
  throw new Error(
    '[desktop-resources] uv not found on PATH; cannot stage the desktop bundle. ' +
      'Install uv (https://docs.astral.sh/uv/) before building.',
  );
}
const uvDest = join(binOut, process.platform === 'win32' ? 'uv.exe' : 'uv');
await copyFile(bundledUvSrc ?? uv, uvDest);
// Homebrew's uv is mode 0o555 (no write bit); copyFile preserves that, and so
// does tauri's resource copy into target/. A rebuild then can't overwrite the
// stale read-only copy -> "Permission denied (os error 13)" in the build
// script. Force 0o755 so the staged binary is writable+executable (matches the
// runtime chmod in capability.rs::resolve_uv).
await chmod(uvDest, 0o755);
console.log(`[desktop-resources] bundled uv from ${bundledUvSrc ?? uv}`);

// --- rewrite the bundled pyproject + re-lock --------------------------------
const pyprojectPath = join(pyOut, 'aligner', 'pyproject.toml');
// Normalize to LF: on Windows (autocrlf) the file checks out with CRLF, which
// breaks the newline-spanning marker matches below ([tool.uv]\n).
let pyproject = (await readFile(pyprojectPath, 'utf8')).replaceAll('\r\n', '\n');
const gitSpecs = [...pyproject.matchAll(/"([^"]+ @ git\+[^"]+)"/g)].map((m) => m[1]);

// Each rewrite asserts its marker was present: a silent no-op (e.g. pyproject
// reformatted) would otherwise ship a bundle that still pins >=3.11 or drags in
// torch.
const mustReplace = (text: string, find: string, repl: string, what: string): string => {
  if (!text.includes(find)) {
    throw new Error(`bundled pyproject rewrite failed: ${what} marker not found (reformatted?)`);
  }
  return text.replace(find, repl);
};

// Both modes: pin Python to the runtime venv's version (uv sync --python 3.11)
// and null torch/torchaudio/torchcodec out of the resolved graph. The torch drop
// is essential even for a dev build -- `ctc-forced-aligner` declares torch (and
// torchcodec) so uv sync would pull multi-GB torch without it; the vendored path
// (lyrics_onnx.py) uses only its compiled kernel + text_utils and decodes audio
// via librosa, so torchcodec is dead weight too. (Build artifact only -- the dev
// pyproject keeps torch for ONNX export + the offline parity checks.)
pyproject = mustReplace(
  pyproject,
  'requires-python = ">=3.11"',
  `requires-python = "==${PY}.*"`,
  'requires-python',
);
pyproject = mustReplace(
  pyproject,
  `override-dependencies = ["torchvision; sys_platform == 'never'"]`,
  `override-dependencies = ["torchvision; sys_platform == 'never'", "torch; sys_platform == 'never'", "torchaudio; sys_platform == 'never'", "torchcodec; sys_platform == 'never'"]`,
  'torch-free override',
);

if (DEV) {
  // Dev build: leave the git specs as git. The runtime `uv sync` builds them
  // from git on the test machine (git + a compiler required there), so we skip
  // the wheelhouse entirely -- a dev bundle can't cross-compile the C extensions
  // for the target platform anyway.
  console.log('[desktop-resources] dev build: git deps stay as git specs (runtime builds them)');
} else if (gitSpecs.length === 0) {
  console.log('[desktop-resources] no git deps to vendor');
} else {
  // Vendor the git/source deps as prebuilt wheels + point pyproject at the
  // wheelhouse, so the runtime install needs NO system git and NO C compiler.
  await mkdir(wheelCache, { recursive: true });
  const cached = (await readdir(wheelCache)).filter((f) => f.endsWith('.whl'));
  const wheelFor = (spec: string, pool: string[]): string | undefined => {
    const norm = depName(spec).replace(/-/g, '_').toLowerCase();
    return pool.find((w) => w.toLowerCase().startsWith(`${norm}-`));
  };

  if (!gitSpecs.every((s) => wheelFor(s, cached))) {
    // Build the wheels in a throwaway py-pinned venv (needs git + a compiler,
    // which the build host has). Cached so any source build is one-time.
    const buildenv = join(out, 'wheel-buildenv');
    await rm(buildenv, { recursive: true, force: true });
    run(uv, ['venv', '--python', PY, buildenv]);
    run(uv, ['pip', 'install', '--python', buildenv, 'pip', 'wheel']);
    run(venvPython(buildenv), ['-m', 'pip', 'wheel', '--no-deps', '--wheel-dir', wheelCache, ...gitSpecs]);
    await rm(buildenv, { recursive: true, force: true });
    console.log(`[desktop-resources] built ${gitSpecs.length} wheels`);
  } else {
    console.log('[desktop-resources] reusing cached wheels');
  }

  const wheelhouse = join(pyOut, 'aligner', 'wheels');
  await mkdir(wheelhouse, { recursive: true });
  const wheels = (await readdir(wheelCache)).filter((f) => f.endsWith('.whl'));
  for (const w of wheels) {
    await copyFile(join(wheelCache, w), join(wheelhouse, w));
  }

  for (const spec of gitSpecs) {
    const wheel = wheelFor(spec, wheels);
    if (!wheel) {
      throw new Error(`no wheel built for ${depName(spec)}`);
    }
    pyproject = mustReplace(
      pyproject,
      `"${spec}"`,
      `"${depName(spec)}==${wheel.split('-')[1]}"`,
      depName(spec),
    );
  }
  pyproject = mustReplace(
    pyproject,
    '[tool.uv]\n',
    '[tool.uv]\nfind-links = ["wheels"]\n',
    'find-links',
  );
}

await writeFile(pyprojectPath, pyproject);
// Re-lock so the runtime `uv sync` matches the rewritten pyproject (torch
// dropped; wheelhouse pins in a native build, plain git specs in a dev build).
run(uv, ['lock', '--directory', join(pyOut, 'aligner')]);
console.log('[desktop-resources] rewrote pyproject + re-locked');

if (DEV) {
  await writeFile(devMarker, '');
  console.log('[desktop-resources] wrote devbuild marker (runtime uv-syncs on first launch)');
}

console.log(`[desktop-resources] staged Python backend -> ${pyOut}`);
