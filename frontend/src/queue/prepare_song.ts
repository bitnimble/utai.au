/**
 * Turn a queued song source into a {@link PreparedSong}: everything the
 * session needs to play it (stems, word-aligned lyrics, beats, metadata),
 * built off to the side so the song currently playing is untouched.
 *
 * Every backend step is best-effort except getting decodable audio: a failed
 * separation keeps the full mix, a missed LRCLIB match or failed alignment
 * just leaves the song without (word-timed) lyrics.
 */

import { analyzeBeats } from 'src/editing/beats/analyze_beats_client';
import {
  LoadedLyrics,
  LoadedSong,
  PreparedSong,
  unpackSongBundle,
} from 'src/karaoke/song_bundle';
import type { SongMeta } from 'src/karaoke/song_schema';
import { cleanStreamingTitle, parseSongFilename, pickConfidentMatch } from 'src/lyrics/auto_lyrics';
import { alignLyricsForced } from 'src/lyrics/forced_align';
import { LyricLine, parseLrc } from 'src/lyrics/lrc';
import { LrclibMatch, searchLrclib } from 'src/lyrics/lrclib';
import { attachPitchToLines } from 'src/lyrics/pitch_contour';
import { separateStems, type SeparatedStems } from 'src/lyrics/separate_stems';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { fetchTrack, type TrackResult } from 'src/net/music_source_client';
import { toastStore } from 'src/ui/toasts/toasts';

export type QueueSource =
  | { kind: 'file'; file: File }
  | { kind: 'streaming'; track: TrackResult }
  | { kind: 'bundle'; file: File };

export type PrepareStage =
  | { kind: 'downloading'; frac: number }
  | { kind: 'separating' }
  | { kind: 'aligning' };

export type PrepareOptions = {
  signal: AbortSignal;
  onStage: (stage: PrepareStage) => void;
};

export type PrepareSong = (source: QueueSource, opts: PrepareOptions) => Promise<PreparedSong>;

export const prepareSong: PrepareSong = async (source, opts) => {
  if (source.kind === 'bundle') {
    return fromBundle(await unpackSongBundle(new Uint8Array(await source.file.arrayBuffer())));
  }
  if (source.kind === 'file') {
    return prepareMix(source.file, {}, undefined, opts);
  }
  const { track } = source;
  opts.onStage({ kind: 'downloading', frac: 0 });
  const mix = await fetchTrack(track, {
    signal: opts.signal,
    onProgress: (p) => opts.onStage({ kind: 'downloading', frac: p.frac }),
  });
  const meta: SongMeta = {
    title: cleanStreamingTitle(track.title, track.artists),
    artist: track.artists || undefined,
    album: track.album ?? undefined,
    albumArtUrl: track.coverUrl ?? undefined,
    sourceUrl: track.sourceUrl,
  };
  return prepareMix(mix, meta, track.durationSec ?? undefined, opts);
};

/** Separate, beat-track, and fetch + align lyrics for a full mix. */
async function prepareMix(
  mix: File,
  meta: SongMeta,
  knownDurationSec: number | undefined,
  { signal, onStage }: PrepareOptions,
): Promise<PreparedSong> {
  const durationSec = knownDurationSec ?? (await decodeDurationSec(mix));
  const parsed = parseSongFilename(mix.name);
  const title = meta.title || parsed.title;
  const songLabel = title || mix.name;

  onStage({ kind: 'separating' });
  const [stems, beats, match] = await Promise.all([
    separateStems(mix, { signal }).catch((err: unknown) => {
      if (!signal.aborted && !isBackendUnreachable(err)) {
        toastStore.showWarning(`${songLabel}: kept the full mix (stem separation failed: ${message(err)}).`);
      }
      return undefined;
    }),
    analyzeBeats(mix, { signal }).catch((err: unknown) => {
      if (!signal.aborted && !isBackendUnreachable(err)) console.warn('[beats] analysis failed:', message(err));
      return undefined;
    }),
    findSyncedLyrics(title, meta.artist || parsed.artist, durationSec, signal),
  ]);
  signal.throwIfAborted();

  const lyrics: LoadedLyrics[] = [];
  if (match) {
    onStage({ kind: 'aligning' });
    lyrics.push({
      lines: await alignWords(match.lines, mix, stems, songLabel, signal),
      source: 'lrclib',
      sourceLabel: `LRCLIB · ${match.trackName} - ${match.artistName}`,
      offsetSec: 0,
    });
  }

  return {
    meta: {
      ...meta,
      title: meta.title || match?.trackName || parsed.title || undefined,
      artist: meta.artist || match?.artistName || parsed.artist || undefined,
    },
    stems: stems
      ? [
          { role: 'backing', file: stems.backing },
          { role: 'vocals', file: stems.vocals, pitchContour: stems.pitchContour },
        ]
      : [{ role: 'full-mix', file: mix }],
    lyrics,
    beats,
  };
}

/** Upgrade line-timed lyrics to word timings (plus the vocal pitch, when
 *  separation extracted it). Falls back to the line-timed input on failure. */
async function alignWords(
  lines: LyricLine[],
  mix: File,
  stems: SeparatedStems | undefined,
  songLabel: string,
  signal: AbortSignal,
): Promise<LyricLine[]> {
  try {
    const aligned = await alignLyricsForced(
      {
        kind: stems ? 'vocals' : 'mix',
        file: stems?.vocals ?? mix,
        realign: { lines: lines.map((l) => ({ startSec: l.startSec, text: l.text })) },
      },
      { signal },
    );
    if (aligned.length === 0) return lines;
    if (stems?.pitchContour) attachPitchToLines(stems.pitchContour, aligned);
    return aligned;
  } catch (err) {
    signal.throwIfAborted();
    if (!isBackendUnreachable(err)) toastStore.showError(`${songLabel}: lyrics align failed: ${message(err)}`);
    return lines;
  }
}

/**
 * Search LRCLIB for the song's synced lyrics and keep a confident match (per
 * {@link pickConfidentMatch}: duration + fuzzy title/artist). On a miss it
 * retries title-only: LRCLIB's search is artist-sensitive and the source's
 * "artist" may be a mislabelling YouTube uploader. Silent on a miss.
 */
async function findSyncedLyrics(
  rawTitle: string,
  rawArtist: string,
  durationSec: number,
  signal: AbortSignal,
): Promise<{ lines: LyricLine[]; trackName: string; artistName: string } | undefined> {
  const title = rawTitle.trim();
  const artist = rawArtist.trim();
  if (title.length === 0 && artist.length === 0) return undefined;
  let best = await searchAndPick(title, artist, durationSec, signal, { title, artist });
  if (best == null && title.length > 0 && artist.length > 0) {
    best = await searchAndPick(title, '', durationSec, signal, { title, ignoreArtist: true });
  }
  if (best?.syncedLyrics == null) return undefined;
  const lines = parseLrc(best.syncedLyrics);
  if (lines.length === 0) return undefined;
  return { lines, trackName: best.trackName, artistName: best.artistName };
}

async function searchAndPick(
  trackName: string,
  artistName: string,
  durationSec: number,
  signal: AbortSignal,
  matchOpts: { title: string; artist?: string; ignoreArtist?: boolean },
): Promise<LrclibMatch | undefined> {
  let matches: LrclibMatch[];
  try {
    matches = await searchLrclib({ trackName, artistName, signal });
  } catch (err) {
    console.log('[auto-lyrics] search failed', err);
    return undefined;
  }
  return pickConfidentMatch(matches, durationSec, {
    ...matchOpts,
    onTrace: (t) =>
      console.log(
        `[auto-lyrics] ${t.accepted ? 'ACCEPT' : 'reject'} "${t.trackName} - ${t.artistName}" (${t.reason})`,
        { duration: t.duration, durationDelta: t.durationDelta, nameSim: t.nameSim },
      ),
  });
}

async function decodeDurationSec(file: File): Promise<number> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44_100);
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    return buffer.duration;
  } catch (err) {
    throw new Error(`Could not decode ${file.name}: ${message(err)}`);
  }
}

function fromBundle(loaded: LoadedSong): PreparedSong {
  return {
    meta: loaded.meta,
    // `new Uint8Array(...)` rebinds fflate's `ArrayBufferLike`-typed bytes
    // to an ArrayBuffer-backed view the DOM `BlobPart` type accepts.
    stems: loaded.stems.map((stem) => ({
      role: stem.role,
      file: new File([new Uint8Array(stem.bytes)], stem.filename, { type: stem.contentType }),
    })),
    lyrics: loaded.lyrics,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
