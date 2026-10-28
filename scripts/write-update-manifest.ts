// Writes the `latest.json` the desktop updater reads (tauri.conf.json `plugins.updater.endpoints`)
// from the release files CI collected, so a platform whose build failed is simply absent.
//
//   bun scripts/write-update-manifest.ts --dist dist --tag v0.1.2 --repo bitnimble/utai.au
//
// Each updater bundle sits beside its `.sig`, as `<dist>/<platform>/<file>{,.sig}`.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/** The release file suffix of each updater bundle, by the updater's platform key. */
const BUNDLES: Record<string, string> = {
  'windows-x86_64': '-setup.exe',
  'darwin-aarch64': '.app.tar.gz',
};

type Manifest = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
};

export function manifest(files: readonly string[], read: (file: string) => string, tag: string, repo: string, notes: string, now: Date): Manifest {
  const platforms: Manifest['platforms'] = {};
  for (const [platform, suffix] of Object.entries(BUNDLES)) {
    const bundle = files.find((f) => f.endsWith(suffix) && files.includes(`${f}.sig`));
    if (bundle == null) continue;
    const name = bundle.split('/').at(-1)!;
    platforms[platform] = {
      signature: read(`${bundle}.sig`).trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
    };
  }
  return { version: tag.replace(/^v/, ''), notes, pub_date: now.toISOString(), platforms };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { dist: { type: 'string' }, tag: { type: 'string' }, repo: { type: 'string' } } });
  const { dist, tag, repo } = values;
  if (dist == null || tag == null || repo == null) throw new Error('usage: --dist <dir> --tag <vX.Y.Z> --repo <owner/name>');
  const files = readdirSync(dist, { recursive: true, encoding: 'utf8' }).map((f) => join(dist, f));
  const changelog = JSON.parse(readFileSync('changelog.json', 'utf8'));
  const result = manifest(files, (f) => readFileSync(f, 'utf8'), tag, repo, changelog[tag] ?? '', new Date());
  if (Object.keys(result.platforms).length === 0) console.error('[update-manifest] no signed updater bundles: desktop installs will see no update');
  const out = join(dist, 'latest.json');
  if (existsSync(out)) throw new Error(`${out} already exists`);
  writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`[update-manifest] ${out}: ${Object.keys(result.platforms).join(', ') || 'no platforms'}`);
}
