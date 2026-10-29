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
import { parseSongFilename, pickConfidentMatch } from 'src/lyrics/auto_lyrics';
import { extractPitch } from 'src/lyrics/extract_pitch';
import { alignLyricsForced } from 'src/lyrics/forced_align';
import { LyricLine, parseLrc, shiftLines } from 'src/lyrics/lrc';
import { LrclibMatch, searchLrclib } from 'src/lyrics/lrclib';
import { attachPitchToLines } from 'src/lyrics/pitch_contour';
import { separateStems, type SeparatedStems } from 'src/lyrics/separate_stems';
import { isBackendUnreachable } from 'src/net/backend_fetch';
import { fetchTrack, type TrackResult } from 'src/net/music_source_client';
import {
  fetchSkipSegments,
  musicDurationSec,
  musicDurationSlackSec,
  musicStartSec,
  type SkipSegment,
} from 'src/skip_segments/sponsorblock';
import type { SongIdentity } from 'src/song_identity/identify_song';
import { identifyTrack } from 'src/song_identity/identify_track';
import { toastStore } from 'src/ui/toasts/toasts';
import { prefetchBackingVideo } from 'src/video/video_client';
import { songVideoId } from 'src/video/youtube';

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
  /** A streaming track's identity, if already being looked up. */
  identity?: Promise<SongIdentity>;
};

export type PrepareSong = (source: QueueSource, opts: PrepareOptions) => Promise<PreparedSong>;

export const prepareSong: PrepareSong = async (source, opts) => {
  if (source.kind === 'bundle') {
    const prepared = fromBundle(await unpackSongBundle(new Uint8Array(await source.file.arrayBuffer())));
    await warmBackingVideo(prepared.meta, opts.signal);
    return prepared;
  }
  if (source.kind === 'file') {
    return prepareFile(source.file, opts);
  }
  const { track } = source;
  const video = warmBackingVideo({ sourceUrl: track.sourceUrl }, opts.signal);
  const prepared = await prepareStreaming(track, opts);
  await video;
  return prepared;
};

/** Best-effort: the video area just starts blank (or falls back to the embed)
 *  when this fails. */
async function warmBackingVideo(meta: SongMeta, signal: AbortSignal): Promise<void> {
  const videoId = songVideoId(meta);
  if (videoId == null) return;
  try {
    await prefetchBackingVideo(videoId, { signal });
  } catch (err) {
    if (!signal.aborted) console.warn('[video] prefetch failed:', message(err));
  }
}

async function prepareFile(file: File, opts: PrepareOptions): Promise<PreparedSong> {
  const music = { durationSec: await decodeDurationSec(file), startSec: 0, durationSlackSec: 0, isCover: false };
  const parsed = parseSongFilename(file.name);
  return prepareMix(file, {}, music, findSyncedLyrics(parsed.title, parsed.artist, music, opts.signal), opts);
}

/** The lyrics search starts once the song is identified, without waiting for the download. */
async function prepareStreaming(track: TrackResult, opts: PrepareOptions): Promise<PreparedSong> {
  opts.onStage({ kind: 'downloading', frac: 0 });
  const download = fetchTrack(track, {
    signal: opts.signal,
    onProgress: (p) => opts.onStage({ kind: 'downloading', frac: p.frac }),
  });
  const identity = opts.identity ?? identifyTrack(track, opts.signal);
  const music = streamingMusic(track, download, lookUpSkipSegments(track.sourceUrl, opts.signal), identity);
  const lyrics = Promise.all([identity, music])
    .then(([song, m]) => findSyncedLyrics(song.title, song.artist, m, opts.signal))
    // Only rejects when `music` does, i.e. a failed download, which the await below reports.
    .catch(() => undefined);
  const [mix, song, knownMusic] = await Promise.all([download, identity, music]);
  const meta: SongMeta = {
    title: song.title,
    artist: song.artist || undefined,
    album: track.album ?? undefined,
    albumArtUrl: track.coverUrl ?? undefined,
    sourceUrl: track.sourceUrl,
  };
  return prepareMix(mix, meta, knownMusic, lyrics, opts);
}

async function streamingMusic(
  track: TrackResult,
  download: Promise<File>,
  skipSegments: Promise<SkipSegment[]>,
  identity: Promise<SongIdentity>,
): Promise<KnownMusic> {
  const [segments, song] = await Promise.all([skipSegments, identity]);
  const durationSec = track.durationSec ?? (await decodeDurationSec(await download));
  return {
    durationSec: musicDurationSec(segments, durationSec),
    startSec: musicStartSec(segments, durationSec),
    durationSlackSec: musicDurationSlackSec(segments, durationSec),
    isCover: song.isCover,
  };
}

const SKIP_SEGMENTS_TIMEOUT_MS = 10_000;

/** Best-effort: without segments, lyrics match against the full length. */
async function lookUpSkipSegments(sourceUrl: string | undefined, signal: AbortSignal): Promise<SkipSegment[]> {
  const videoId = songVideoId({ sourceUrl });
  if (videoId == null) return [];
  try {
    return await fetchSkipSegments(videoId, AbortSignal.any([signal, AbortSignal.timeout(SKIP_SEGMENTS_TIMEOUT_MS)]));
  } catch (err) {
    if (!signal.aborted) console.warn('[skip-segments] SponsorBlock lookup failed:', message(err));
    return [];
  }
}

type KnownMusic = { durationSec: number; startSec: number; durationSlackSec: number; isCover: boolean };

type SyncedLyrics = { lines: LyricLine[]; trackName: string; artistName: string };

/** Separate and beat-track a full mix, then align the lyrics (once both the
 *  vocal stem and `lyricsSearch` are in) alongside the vocal pitch pass. */
async function prepareMix(
  mix: File,
  meta: SongMeta,
  music: KnownMusic,
  lyricsSearch: Promise<SyncedLyrics | undefined>,
  { signal, onStage }: PrepareOptions,
): Promise<PreparedSong> {
  const parsed = parseSongFilename(mix.name);
  const songLabel = meta.title || parsed.title || mix.name;

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
    lyricsSearch,
  ]);
  signal.throwIfAborted();

  if (match) onStage({ kind: 'aligning' });
  const [aligned, pitchContour] = await Promise.all([
    match && alignWords(match.lines, music.startSec, mix, stems, songLabel, signal),
    stems &&
      extractPitch(stems.vocals, signal).catch((err: unknown) => {
        if (!signal.aborted && !isBackendUnreachable(err)) console.warn('[pitch] extraction failed:', message(err));
        return undefined;
      }),
  ]);
  signal.throwIfAborted();

  const lyrics: LoadedLyrics[] = [];
  if (match) {
    if (aligned && pitchContour) attachPitchToLines(pitchContour, aligned);
    lyrics.push({
      lines: aligned ? shiftLines(aligned, -music.startSec) : match.lines,
      source: 'lrclib',
      sourceLabel: `LRCLIB · ${match.trackName} - ${match.artistName}`,
      offsetSec: music.startSec,
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
          { role: 'vocals', file: stems.vocals, pitchContour },
        ]
      : [{ role: 'full-mix', file: mix }],
    lyrics,
    beats,
  };
}

/** Upgrade line-timed lyrics to word timings, in audio time (`lines` are
 *  relative to `offsetSec` into the audio). Undefined when nothing aligned. */
async function alignWords(
  lines: LyricLine[],
  offsetSec: number,
  mix: File,
  stems: SeparatedStems | undefined,
  songLabel: string,
  signal: AbortSignal,
): Promise<LyricLine[] | undefined> {
  try {
    const aligned = await alignLyricsForced(
      {
        kind: stems ? 'vocals' : 'mix',
        file: stems?.vocals ?? mix,
        realign: { lines: lines.map((l) => ({ startSec: l.startSec + offsetSec, text: l.text })) },
      },
      { signal },
    );
    return aligned.length > 0 ? aligned : undefined;
  } catch (err) {
    signal.throwIfAborted();
    if (!isBackendUnreachable(err)) toastStore.showError(`${songLabel}: lyrics align failed: ${message(err)}`);
    return undefined;
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
  music: KnownMusic,
  signal: AbortSignal,
): Promise<SyncedLyrics | undefined> {
  const title = rawTitle.trim();
  const artist = rawArtist.trim();
  if (title.length === 0 && artist.length === 0) return undefined;
  const { durationSec, durationSlackSec } = music;
  let best = await searchAndPick(title, artist, durationSec, signal, {
    title,
    artist,
    durationSlackSec: durationSlackSec + (music.isCover ? COVER_DURATION_SLACK_SEC : 0),
  });
  // Title alone is too weak a name gate to also widen for a cover: any same-titled song would pass.
  if (best == null && title.length > 0 && artist.length > 0) {
    best = await searchAndPick(title, '', durationSec, signal, { title, ignoreArtist: true, durationSlackSec });
  }
  if (best?.syncedLyrics == null) return undefined;
  const lines = parseLrc(best.syncedLyrics);
  if (lines.length === 0) return undefined;
  return { lines, trackName: best.trackName, artistName: best.artistName };
}

const COVER_DURATION_SLACK_SEC = 30;

async function searchAndPick(
  trackName: string,
  artistName: string,
  durationSec: number,
  signal: AbortSignal,
  matchOpts: { title: string; artist?: string; ignoreArtist?: boolean; durationSlackSec: number },
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
