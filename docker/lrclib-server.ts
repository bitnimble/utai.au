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
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const DB = process.env.LRCLIB_DB_PATH ?? '/data/db.sqlite3';
const PORT = Number(process.env.LRCLIB_PORT ?? 3300);
const DUMP_URL = process.env.LRCLIB_DUMP_URL ?? '';

async function fileSize(p: string): Promise<number> {
  try {
    return (await stat(p)).size;
  } catch {
    return 0;
  }
}

/** gzip magic (1f 8b). Guards against the transport having already decoded the
 *  body (Content-Encoding), in which case the "download" is the db itself. */
async function isGzip(p: string): Promise<boolean> {
  const head = new Uint8Array(await Bun.file(p).slice(0, 2).arrayBuffer());
  return head[0] === 0x1f && head[1] === 0x8b;
}

async function ensureDb(): Promise<void> {
  if (await Bun.file(DB).exists()) {
    console.log(`[lrclib] using cached db ${DB}`);
    return;
  }
  if (!DUMP_URL) {
    throw new Error(
      'LRCLIB_DUMP_URL is unset. Pick a dump from https://lrclib.net/db-dumps and set it.',
    );
  }
  await mkdir(dirname(DB), { recursive: true });
  const isGz = DUMP_URL.endsWith('.gz');
  const download = isGz ? `${DB}.download` : `${DB}.partial`;

  // Resume a partial download (HTTP Range) so a restart doesn't re-fetch the
  // whole multi-GB dump from scratch. `accept-encoding: identity` keeps the
  // transport from gzip-decoding the .gz body: that would make bytes-offsets
  // (Range resume) and the gzip-magic check meaningless.
  let offset = await fileSize(download);
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  if (offset > 0) headers.range = `bytes=${offset}-`;
  const res = await fetch(DUMP_URL, { headers });
  if (offset > 0 && res.status !== 206) offset = 0; // server ignored the range
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  console.log(
    offset > 0
      ? `[lrclib] resuming download at ${(offset / 1e9).toFixed(2)} GB: ${DUMP_URL}`
      : `[lrclib] fetching dump (multi-GB, one-time): ${DUMP_URL}`,
  );

  // Download to disk with a manual reader + write()/drain loop so backpressure
  // reaches the network (Readable.fromWeb / Bun's FileSink buffer the body and
  // OOM). This raw-download side is the one Bun path that holds up at scale.
  const out = createWriteStream(download, { flags: offset > 0 ? 'a' : 'w' });
  const reader = res.body.getReader();
  let got = offset;
  let lastLog = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.length;
    if (!out.write(value)) await once(out, 'drain');
    if (Date.now() - lastLog > 15000) {
      console.log(`[lrclib] downloaded ${(got / 1e9).toFixed(2)} GB`);
      lastLog = Date.now();
    }
  }
  out.end();
  await once(out, 'finish');

  if (isGz && (await isGzip(download))) {
    // Decompress with the SYSTEM gunzip via a shell redirect (`gunzip -c > db`),
    // so NO Bun stream sits between gunzip and the file. Bun's own zlib
    // segfaults on the real stream, and its subprocess-stdout Readable emits
    // >2 GB chunks that overflow fs.write (ERR_OUT_OF_RANGE). The shell wires
    // gunzip's stdout straight to the file descriptor; Bun just waits.
    console.log('[lrclib] decompressing (system gunzip)...');
    const partial = `${DB}.partial`;
    const proc = Bun.spawn(['sh', '-c', 'exec gunzip -c "$1" > "$2"', 'sh', download, partial], {
      stdout: 'inherit',
      stderr: 'inherit',
    });
    if ((await proc.exited) !== 0) throw new Error('gunzip failed');
    await unlink(download).catch(() => {});
    await rename(partial, DB);
  } else {
    // Not gzipped (or the transport already decoded it): the download IS the db.
    await rename(download, DB);
  }
  console.log(`[lrclib] dump ready: ${DB}`);
}

try {
  await ensureDb();
} catch (err) {
  // Don't crash-loop the multi-GB download: log and exit. The container's
  // restart policy is `no`, so a failed setup stops here instead of retrying.
  // (A resumed retry is a manual `docker compose restart lrclib` away.)
  console.error(`[lrclib] setup failed: ${err instanceof Error ? err.message : String(err)}`);
  console.error('[lrclib] not retrying automatically; restart the container to resume.');
  process.exit(1);
}

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
