//   bun run release            the patch after the current version
//   bun run release 1.2.0      that version
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { changelog } from './changelog';

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const ROOT = join(import.meta.dir, '..');
const PACKAGE_JSON = join(ROOT, 'package.json');
const CHANGELOG_JSON = join(ROOT, 'changelog.json');

export function nextVersion(current: string, requested: string | undefined): string {
  if (requested != null) {
    const version = requested.replace(/^v/, '');
    if (!SEMVER.test(version)) throw new Error(`${requested} is not a semver version (1.2.3, 1.2.3-rc1)`);
    return version;
  }
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (parts == null) throw new Error(`the version is ${current}, which has no patch to increment: name the version`);
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}`;
}

/** `package.json` with its version replaced, everything else byte for byte. */
export function withVersion(packageJson: string, version: string): string {
  const pattern = /^(\s*"version":\s*")[^"]*(")/m;
  if (!pattern.test(packageJson)) throw new Error('package.json has no "version" field');
  return packageJson.replace(pattern, `$1${version}$2`);
}

function git(...args: string[]): string {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (run.status !== 0) fail(`git ${args.join(' ')} failed:\n${run.stderr}`);
  return run.stdout.trim();
}

function fail(message: string): never {
  console.error(`[release] ${message}`);
  process.exit(1);
}

function previousTag(): string {
  const run = spawnSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: ROOT, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : '';
}

if (import.meta.main) {
  const dirty = git('status', '--porcelain');
  if (dirty !== '') fail(`the working tree has uncommitted or untracked files:\n${dirty}`);
  if (git('branch', '--show-current') !== 'main') fail('releases must be cut on main');

  const packageJson = readFileSync(PACKAGE_JSON, 'utf8');
  const current: string = JSON.parse(packageJson).version;
  let version: string;
  try {
    version = nextVersion(current, process.argv[2]);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const tag = `v${version}`;
  if (git('tag', '--list', tag) !== '') fail(`${tag} already exists`);

  console.log('[release] writing the changelog');
  const notes = changelog(previousTag(), 'HEAD');
  const changelogs = JSON.parse(readFileSync(CHANGELOG_JSON, 'utf8'));
  writeFileSync(CHANGELOG_JSON, `${JSON.stringify({ ...changelogs, [tag]: notes }, null, 2)}\n`);
  writeFileSync(PACKAGE_JSON, withVersion(packageJson, version));
  const commit = spawnSync('git', ['commit', '--quiet', '-m', `chore(release): ${version}`, '--', 'package.json', 'changelog.json'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (commit.status !== 0) {
    // Else the next run refuses the dirty tree this leaves.
    git('checkout', '--', 'package.json', 'changelog.json');
    fail(`git commit failed:\n${commit.stderr}`);
  }
  // Annotated, because `git push --follow-tags` pushes only annotated tags.
  git('tag', '--annotate', tag, '-m', tag);

  console.log(`[release] ${current} -> ${version}, committed and tagged ${tag}`);
  console.log(`[release] changelog:\n${notes}`);
  console.log('[release] git push --follow-tags   to build and publish it');
}
