/**
 * Pack / unpack a saved-song `.zip` bundle: separated stems (already-
 * compressed audio, stored uncompressed in the zip), word-aligned lyrics
 * as enhanced `.lrc`, and an `index.json` manifest ({@link SongDoc}).
 *
 * Pure data in / data out, no store or DOM access, so it's unit-testable
 * and the presenter owns gathering inputs from the stores and applying the
 * loaded result. The lyrics round-trip reuses the existing enhanced-LRC
 * codec, which preserves per-word start + end timings.
 */

import {
  unzip,
  zip,
  strFromU8,
  strToU8,
  type AsyncZippable,
  type Unzipped,
} from 'fflate';
import { parseEnhancedLrc, serializeEnhancedLrc } from 'src/lyrics/enhanced_lrc';
import { LyricLine } from 'src/lyrics/lrc';
import { LyricsSource } from 'src/lyrics/store';
import {
  AudioStemDoc,
  AudioStemRole,
  LyricsTrackDoc,
  SONG_BUNDLE_VERSION,
  SongDoc,
  SongMeta,
  songDocSchema,
} from './song_schema';

export type BundleStemInput = {
  role: AudioStemRole;
  filename: string;
  blob: Blob;
  durationSec?: number;
};

export type BundleLyricsInput = {
  lines: readonly LyricLine[];
  source?: LyricsSource;
  sourceLabel: string;
  offsetSec: number;
  color?: string;
};

export type SongBundleInput = {
  meta: SongMeta;
  durationSec?: number;
  stems: readonly BundleStemInput[];
  lyrics: readonly BundleLyricsInput[];
};

export type LoadedStem = {
  role: AudioStemRole;
  filename: string;
  bytes: Uint8Array;
  contentType: string;
  durationSec?: number;
};

export type LoadedLyrics = {
  lines: LyricLine[];
  source?: LyricsSource;
  sourceLabel: string;
  offsetSec: number;
  color?: string;
};

export type LoadedSong = {
  meta: SongMeta;
  durationSec?: number;
  stems: LoadedStem[];
  lyrics: LoadedLyrics[];
};

/** Assemble a song bundle into a `application/zip` {@link Blob}. Audio
 *  entries are stored (level 0) since stems arrive already compressed;
 *  the JSON + LRC text is deflated. */
export async function packSongBundle(input: SongBundleInput): Promise<Blob> {
  const files: AsyncZippable = {};

  const audio: AudioStemDoc[] = [];
  const usedAudio = new Set<string>();
  for (const stem of input.stems) {
    const ext = extFromFilename(stem.filename) ?? extFromMime(stem.blob.type) ?? 'bin';
    const file = uniquePath(`audio/${stem.role}.${ext}`, usedAudio);
    files[file] = [new Uint8Array(await stem.blob.arrayBuffer()), { level: 0 }];
    audio.push({ role: stem.role, file, filename: stem.filename, durationSec: stem.durationSec });
  }

  const lyrics: LyricsTrackDoc[] = [];
  const usedLyrics = new Set<string>();
  input.lyrics.forEach((track, i) => {
    const text = serializeEnhancedLrc(track.lines, { offsetSec: track.offsetSec });
    const file = uniquePath(`lyrics/${pad2(i + 1)}-${slug(track.sourceLabel)}.lrc`, usedLyrics);
    files[file] = strToU8(text);
    lyrics.push({
      file,
      source: track.source,
      sourceLabel: track.sourceLabel,
      offsetSec: track.offsetSec,
      color: track.color,
    });
  });

  const doc: SongDoc = {
    version: SONG_BUNDLE_VERSION,
    ...cleanMeta(input.meta),
    ...(input.durationSec !== undefined ? { durationSec: input.durationSec } : {}),
    audio,
    lyrics,
  };
  files['index.json'] = strToU8(JSON.stringify(doc, null, 2));

  const zipped = await zipAsync(files);
  // Copy into an ArrayBuffer-backed view: fflate types its output as
  // `Uint8Array<ArrayBufferLike>`, which the DOM `BlobPart` type rejects.
  return new Blob([new Uint8Array(zipped)], { type: 'application/zip' });
}

/** Parse + validate a song bundle. Throws a user-facing `Error` on a
 *  malformed archive (missing `index.json`, bad JSON, schema mismatch, or
 *  a manifest entry pointing at an absent file). */
export async function unpackSongBundle(data: Uint8Array): Promise<LoadedSong> {
  const entries = await unzipAsync(data);

  const indexBytes = entries['index.json'];
  if (indexBytes == null) {
    throw new Error('Not a valid song bundle (missing index.json).');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(indexBytes));
  } catch {
    throw new Error('Song bundle index.json is not valid JSON.');
  }
  const parsed = songDocSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join('.') || 'index.json';
    throw new Error(`Song bundle is invalid (${where}: ${issue?.message ?? 'schema mismatch'}).`);
  }
  const doc = parsed.data;

  const stems: LoadedStem[] = doc.audio.map((a) => {
    const bytes = entries[a.file];
    if (bytes == null) throw new Error(`Song bundle is missing audio file "${a.file}".`);
    return {
      role: a.role,
      filename: a.filename ?? basename(a.file),
      bytes,
      contentType: mimeFromExt(extFromFilename(a.file)),
      durationSec: a.durationSec,
    };
  });

  const lyrics: LoadedLyrics[] = doc.lyrics.map((l) => {
    const bytes = entries[l.file];
    if (bytes == null) throw new Error(`Song bundle is missing lyrics file "${l.file}".`);
    const parsedLrc = parseEnhancedLrc(strFromU8(bytes));
    return {
      lines: parsedLrc.lines,
      source: l.source,
      sourceLabel: l.sourceLabel ?? basename(l.file),
      offsetSec: l.offsetSec ?? parsedLrc.offsetSec,
      color: l.color,
    };
  });

  return { meta: extractMeta(doc), durationSec: doc.durationSec, stems, lyrics };
}

// --- helpers ----------------------------------------------------------------

function zipAsync(files: AsyncZippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

function unzipAsync(data: Uint8Array): Promise<Unzipped> {
  return new Promise((resolve, reject) => {
    unzip(data, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

const META_KEYS = ['title', 'artist', 'album', 'albumArtUrl', 'musicVideoUrl', 'sourceUrl'] as const;

/** Drop empty / whitespace-only metadata so the manifest omits them
 *  rather than writing `""`. */
function cleanMeta(meta: SongMeta): SongMeta {
  const out: SongMeta = {};
  for (const key of META_KEYS) {
    const v = meta[key]?.trim();
    if (v) out[key] = v;
  }
  return out;
}

function extractMeta(doc: SongDoc): SongMeta {
  const out: SongMeta = {};
  for (const key of META_KEYS) {
    const v = doc[key];
    if (v) out[key] = v;
  }
  return out;
}

function extFromFilename(name: string): string | undefined {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  flac: 'audio/flac',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
};

const EXT_BY_MIME: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
};

function mimeFromExt(ext: string | undefined): string {
  return (ext && MIME_BY_EXT[ext]) || 'application/octet-stream';
}

function extFromMime(mime: string): string | undefined {
  const base = mime.split(';', 1)[0].trim().toLowerCase();
  return EXT_BY_MIME[base];
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function slug(label: string): string {
  const s = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s.slice(0, 40) || 'lyrics';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Ensure a zip entry path is unique, appending `-2`, `-3`, … before the
 *  extension on collision. */
function uniquePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = dot >= 0 ? path.slice(0, dot) : path;
  const ext = dot >= 0 ? path.slice(dot) : '';
  let n = 2;
  let candidate = `${stem}-${n}${ext}`;
  while (used.has(candidate)) {
    n++;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}
