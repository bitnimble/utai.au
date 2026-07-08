// Tiny self-hosted LRCLIB mirror for the dev harness. Replaces building the
// LRCLIB Rust server from source (a ~1 GB toolchain + a minute of compiling)
// with a Bun script that queries the published SQLite dump directly. Runs on
// the `oven/bun` image the `web` service already uses, so there's no build.
//
// It serves just the one endpoint the frontend calls, `/api/search`, over the
// dump's FTS5 index (`tracks_fts`). It does NOT reproduce LRCLIB's ranking; the
// client re-filters every result by duration + fuzzy title/artist
// (pickConfidentMatch), so returning the FTS candidates is enough. On first run
// it downloads + decompresses the dump into the mounted /data volume (cached
// across restarts), then opens it read-only.
import { Database } from 'bun:sqlite';
import { mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const DB = process.env.LRCLIB_DB_PATH ?? '/data/db.sqlite3';
const PORT = Number(process.env.LRCLIB_PORT ?? 3300);
const DUMP_URL = process.env.LRCLIB_DUMP_URL ?? '';

async function ensureDb(): Promise<void> {
  if (await Bun.file(DB).exists()) {
    console.log(`[lrclib] using cached db ${DB}`);
    return;
  }
  if (!DUMP_URL) {
    console.error('[lrclib] no db and LRCLIB_DUMP_URL is unset.');
    console.error('[lrclib] pick a dump from https://lrclib.net/db-dumps and set LRCLIB_DUMP_URL.');
    process.exit(1);
  }
  console.log(`[lrclib] fetching dump (multi-GB, one-time): ${DUMP_URL}`);
  const res = await fetch(DUMP_URL);
  if (!res.ok || !res.body) {
    console.error(`[lrclib] download failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  await mkdir(dirname(DB), { recursive: true });
  // Stream download -> gunzip -> file, so a ~19 GB decompressed dump never sits
  // in memory. Write to a .partial and rename on success, so an interrupted run
  // never leaves a truncated db that looks cached.
  const partial = `${DB}.partial`;
  const body = DUMP_URL.endsWith('.gz')
    ? res.body.pipeThrough(new DecompressionStream('gzip'))
    : res.body;
  const writer = Bun.file(partial).writer();
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    writer.write(value);
  }
  await writer.end();
  await rename(partial, DB);
  console.log(`[lrclib] dump ready: ${DB}`);
}

await ensureDb();

const db = new Database(DB, { readonly: true });
db.exec('PRAGMA query_only = ON;');

// Join the FTS index -> its track -> that track's current lyrics. Synced-only
// (all the client uses). `content_rowid='id'` makes tracks_fts.rowid == tracks.id.
const search = db.query(
  `SELECT t.id AS id, t.name AS trackName, t.artist_name AS artistName,
          t.album_name AS albumName, t.duration AS duration,
          l.synced_lyrics AS syncedLyrics, l.plain_lyrics AS plainLyrics,
          l.instrumental AS instrumental
   FROM tracks_fts f
   JOIN tracks t ON t.id = f.rowid
   JOIN lyrics l ON l.id = t.last_lyrics_id
   WHERE tracks_fts MATCH $match AND l.has_synced_lyrics = 1
   ORDER BY rank
   LIMIT 50`,
);

/** FTS5 MATCH expression from the query words, each quoted as a literal so a
 *  stray `-`/`*`/`"`/`:` in a title can't be read as an FTS operator. All words
 *  (title + artist) AND together across the indexed name/artist/album columns.
 *  Null when there's nothing to search for. */
function ftsMatch(trackName: string, artistName: string): string | null {
  const tokens = `${trackName} ${artistName}`.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' ');
}

type Row = { instrumental: number | boolean };

Bun.serve({
  port: PORT,
  hostname: '0.0.0.0',
  fetch(req): Response {
    const url = new URL(req.url);
    if (url.pathname !== '/api/search') return new Response('not found', { status: 404 });
    const match = ftsMatch(
      url.searchParams.get('track_name') ?? '',
      url.searchParams.get('artist_name') ?? '',
    );
    let rows: Row[] = [];
    if (match != null) {
      try {
        rows = search.all({ $match: match }) as Row[];
      } catch {
        rows = []; // a malformed FTS expression just yields no matches
      }
    }
    // SQLite BOOLEAN comes back as 0/1; the client checks `instrumental === true`.
    const out = rows.map((r) => ({ ...r, instrumental: !!r.instrumental }));
    return Response.json(out, { headers: { 'access-control-allow-origin': '*' } });
  },
});

console.log(`[lrclib] serving ${DB} on :${PORT}`);
