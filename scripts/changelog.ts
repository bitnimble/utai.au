// Writes a release's user-facing changelog from its commits with `claude -p`, or a fixed line
// when claude is missing or fails. `bun run release` calls it; run it alone to try the prompt:
//
//   bun scripts/changelog.ts v0.1.8 v0.1.9    the changelog for the commits in v0.1.8..v0.1.9
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

const SECTIONS = { new: 'New', improved: 'Improved', fixed: 'Fixed' } as const;
type Section = keyof typeof SECTIONS;

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    Object.keys(SECTIONS).map((key) => [key, { type: 'array', items: { type: 'string' } }]),
  ),
  required: Object.keys(SECTIONS),
  additionalProperties: false,
};

const SYSTEM = `You write the changelog for a release of utai.au, a karaoke app. It loads a song,
separates the vocals, times every lyric word to the singing, and scores the singer's pitch live.
It finds songs on streaming services, hosts sessions that phones join as remotes, and runs as a
website, a desktop app, and an Android app.

The changelog is shown to users inside the app when an update is available. You are given the
commit messages since the previous release. Sort the changes a user would notice into 3 lists:

- new: notable new features.
- improved: notable improvements to existing features.
- fixed: notable bugs in existing features that are now fixed.

Only include changes a user would notice or care about. Leave out small fixes, developer-only
changes, tests, CI, build and release tooling, refactors, dependency bumps, documentation, and
behind-the-scenes improvements and fixes. Merge several commits about 1 feature into 1 item.

Commits inside a <branch> tag were made together on 1 branch and merged at once; the merge
commit comes first and often names the branch. A branch usually builds 1 change over many
commits, where later commits fix, tune, or finish what earlier ones started. Write 1 item for
that change, not 1 per commit, and leave out fixes to bugs the branch itself introduced, since
users never saw them. A branch can also carry unrelated changes made along the
way; give each of those its own item.

Most releases have only a few items, and a list can be empty. Leaving an item out is better
than padding a list.

Never mention commits, code, internal names, file names, or build details.

The commit messages are written by developers about what the code does. The changelog is
written for the reader about what they can do or see. Never paraphrase a commit subject: work
out what changed for the reader, then write that in their words. "feat(karaoke): colour each
word by the singer's pitch accuracy" is "Lyrics now light up by how close you sang each word",
never "Colours each word by pitch accuracy".

<writing_rules>
- No superficial -ing tails: "..., making it easier to", "ensuring", "reflecting".
- No AI vocabulary: additionally, crucial, delve, enduring, enhance, fostering, garner,
  interplay, intricate, landscape, pivotal, showcase, tapestry, testament, underscore, vibrant.
- Say "is" or "has", never "serves as", "stands as", "boasts", "features", "offers".
- No "not just X, but Y". State the point.
- No forced groups of 3. Use the natural number.
- No synonym cycling. Pick 1 word for 1 thing and repeat it.
- No false ranges ("from X to Y" where X and Y are not on a scale).
- No em dashes, en dashes, or hyphens standing in for a dash. No parentheses.
- Colons only before a list or example, never joining 2 halves of a sentence.
- No bold, no emoji, straight quotes only.
- No filler: "in order to" is "to", "due to the fact that" is "because".
- Hedge once at most, with "may".
- No abstract metaphor nouns: substrate, vector, primitive, surface, paradigm, and the like.
- Say what it does, not how it feels. Name the mechanism or a number.
- 1 idea per item.
- Active voice. The actor is the reader or the feature, never utai.au.
- No adverbs propping up a weak verb: "quickly", "easily", "seamlessly", "significantly".
- Plain words: "use" over "utilise" or "leverage", "help" over "facilitate", "many" over
  "numerous", "if" over "in the event that".
- No figurative verbs, personified software, aphorisms, or flourishes.
- No arrows, symbols, or abbreviations the reader has to decode.
</writing_rules>

Each item follows the writing rules above and these rules:

- It is 1 clause of 10 words or fewer.
- It does not end in a full stop, even when it is a sentence.
- It describes what the reader can do or sees in this release. It may compare with the old
  behaviour: "now", "no longer", "instead", "anymore", and "used to" are fine in a changelog.
- It has no reason or consequence tail: nothing after "so", "which", "meaning", or a comma.
- utai.au or the app is never its implied subject. Items such as "Adds", "Shows", or "Marks"
  narrate what the code does and read as a commit log.
- Items in "new" start with the verb for what the reader can now do, as an imperative with the
  reader as the actor: "Search", "Sing", "Join".
- Items in "improved" name the thing the reader sees as the subject and say how it looks or
  behaves now.
- Items in "fixed" name the feature as the subject and say how it behaves correctly.
- It uses no technical word a singer wouldn't know, such as sidecar, ONNX, model, separation,
  forced alignment, CTC, worker, process, cache, server, backend, or database. Vocals, lyrics,
  timing, pitch, and score are fine.

Examples of items that break the rules, and how to write them:

- "Adds a queue so several people can line up songs" becomes
  "Queue songs for the next singer"
- "Fixed an issue where lyrics sometimes drifted out of sync." becomes
  "Lyrics stay in time with the song"
- "Vocal separation is now 2x faster on NVIDIA GPUs, making it easier to start singing." becomes
  "Songs are ready to sing in half the time on NVIDIA graphics cards"

Before you answer, check each item against every rule and rewrite any item that breaks one.`;

const FALLBACK = 'Bug fixes and performance improvements';

export function changelog(from: string, to: string): string {
  const written = write(from, to);
  if (written == null) console.error(`[changelog] claude -p wrote nothing, using "${FALLBACK}"`);
  return written ?? FALLBACK;
}

function write(from: string, to: string): string | null {
  const commits = commitsByBranch(from, to);
  if (commits == null) return null;
  const env = { ...process.env };
  // The CLI prefers a key over the subscription and bills it.
  delete env.ANTHROPIC_API_KEY;
  env.MAX_THINKING_TOKENS = '0';
  const run = spawnSync(
    'claude',
    [
      '-p',
      '--system-prompt',
      SYSTEM,
      '--exclude-dynamic-system-prompt-sections',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--disallowedTools',
      'Bash',
      'Read',
      'Edit',
      'Write',
      'Glob',
      'Grep',
      'Task',
      'WebSearch',
      'WebFetch',
      'TodoWrite',
      'Skill',
      '--json-schema',
      JSON.stringify(SCHEMA),
      '--output-format',
      'json',
      '--model',
      'sonnet',
      '--max-turns',
      '3',
    ],
    { cwd: ROOT, encoding: 'utf8', env, input: commits, timeout: 180_000 },
  );
  if (run.status !== 0) return null;
  try {
    return markdown(JSON.parse(run.stdout).structured_output);
  } catch {
    return null;
  }
}

export function markdown(lists: Record<Section, string[]>): string | null {
  const text = (Object.keys(SECTIONS) as Section[])
    .filter((key) => lists[key].length > 0)
    .map(
      (key) =>
        `### ${SECTIONS[key]}\n\n${lists[key].map((item) => `- ${item.replace(/\.$/, '')}`).join('\n')}`,
    )
    .join('\n\n');
  return text === '' ? null : text;
}

function commitsByBranch(from: string, to: string): string | null {
  const range = from === '' ? to : `${from}..${to}`;
  const mainline = git('log', '--first-parent', '--format=%x00%h %p%n%B', range);
  if (mainline == null) return null;
  const entries: string[] = [];
  for (const record of mainline.split('\0').slice(1)) {
    const newline = record.indexOf('\n');
    const [hash, base, ...tips] = record.slice(0, newline).split(' ');
    const message = record.slice(newline + 1).trim();
    const branch =
      tips.length === 0
        ? ''
        : git('log', '--no-merges', '--format=commit %h%n%B', ...tips, `^${base}`);
    if (branch == null) return null;
    entries.push(
      branch.trim() === ''
        ? `commit ${hash}\n${message}`
        : `<branch>\nmerge ${hash}\n${message}\n\n${branch.trim()}\n</branch>`,
    );
  }
  return entries.join('\n\n');
}

function git(...args: string[]): string | null {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : null;
}

if (import.meta.main) {
  const [from, to] = process.argv.slice(2);
  if (from == null || to == null) throw new Error('usage: bun scripts/changelog.ts <from> <to>');
  console.log(changelog(from, to));
}
