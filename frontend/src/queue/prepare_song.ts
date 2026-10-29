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
import { ModelsMissingError, type JobProgress } from 'src/net/backend_job';
import type { JobAudio } from 'src/net/job_audio';
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
  | { kind: 'loadingModels' }
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
  return prepareMix({ file }, {}, music, findSyncedLyrics(parsed.title, parsed.artist, music, opts.signal), opts);
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
  download: Promise<JobAudio>,
  skipSegments: Promise<SkipSegment[]>,
  identity: Promise<SongIdentity>,
): Promise<KnownMusic> {
  const [segments, song] = await Promise.all([skipSegments, identity]);
  const durationSec = track.durationSec ?? (await decodeDurationSec((await download).file));
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
  mix: JobAudio,
  meta: SongMeta,
  music: KnownMusic,
  lyricsSearch: Promise<SyncedLyrics | undefined>,
  { signal, onStage }: PrepareOptions,
): Promise<PreparedSong> {
  const parsed = parseSongFilename(mix.file.name);
  const songLabel = meta.title || parsed.title || mix.file.name;

  const separating = trackStage({ kind: 'separating' }, onStage);
  const [stems, beats, match] = await Promise.all([
    separating((onProgress) => separateStems(mix, { signal, onProgress })).catch((err: unknown) => {
      if (signal.aborted || isBackendUnreachable(err)) return undefined;
      toastStore.showWarning(
        err instanceof ModelsMissingError
          ? `${songLabel}: playing the full mix, as the AI models aren't downloaded.`
          : `${songLabel}: kept the full mix (stem separation failed: ${message(err)}).`,
        { testId: KEPT_FULL_MIX_TOAST_TEST_ID },
      );
      return undefined;
    }),
    separating((onProgress) => analyzeBeats(mix, { signal, onProgress })).catch((err: unknown) => {
      if (!signal.aborted && !isQuietFailure(err)) console.warn('[beats] analysis failed:', message(err));
      return undefined;
    }),
    lyricsSearch,
  ]);
  signal.throwIfAborted();

  const [aligned, pitchContour] = await Promise.all([
    match &&
      alignWords(match.lines, music.startSec, mix, stems, songLabel, signal, trackStage({ kind: 'aligning' }, onStage)),
    stems &&
      extractPitch(stems.vocals, signal).catch((err: unknown) => {
        if (!signal.aborted && !isQuietFailure(err)) console.warn('[pitch] extraction failed:', message(err));
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
          { role: 'backing', file: stems.backing.file },
          { role: 'vocals', file: stems.vocals.file, pitchContour },
        ]
      : [{ role: 'full-mix', file: mix.file }],
    lyrics,
    beats,
  };
}

type TrackJob = <T>(job: (onProgress: (event: JobProgress) => void) => Promise<T>) => Promise<T>;

/** Reports `stage` now, and `loadingModels` instead while any job run through
 *  the returned tracker is still loading its models. */
export function trackStage(stage: PrepareStage, onStage: (stage: PrepareStage) => void): TrackJob {
  const loading = new Set<symbol>();
  const report = (): void => onStage(loading.size > 0 ? { kind: 'loadingModels' } : stage);
  report();
  return (job) => {
    const id = Symbol();
    return job((event) => {
      if (event.kind === 'loading') loading.add(id);
      else loading.delete(id);
      report();
    }).finally(() => {
      if (loading.delete(id)) report();
    });
  };
}

/** Upgrade line-timed lyrics to word timings, in audio time (`lines` are
 *  relative to `offsetSec` into the audio). Undefined when nothing aligned. */
async function alignWords(
  lines: LyricLine[],
  offsetSec: number,
  mix: JobAudio,
  stems: SeparatedStems | undefined,
  songLabel: string,
  signal: AbortSignal,
  track: TrackJob,
): Promise<LyricLine[] | undefined> {
  try {
    const aligned = await track((onProgress) =>
      alignLyricsForced(
        {
          kind: stems ? 'vocals' : 'mix',
          audio: stems?.vocals ?? mix,
          realign: { lines: lines.map((l) => ({ startSec: l.startSec + offsetSec, text: l.text })) },
        },
        { signal, onProgress },
      ),
    );
    return aligned.length > 0 ? aligned : undefined;
  } catch (err) {
    signal.throwIfAborted();
    // With stems, separation had its models, so no toast has said these are missing.
    const quiet = stems ? isBackendUnreachable(err) : isQuietFailure(err);
    if (!quiet) toastStore.showError(`${songLabel}: lyrics align failed: ${message(err)}`);
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

const KEPT_FULL_MIX_TOAST_TEST_ID = 'kept-full-mix-toast';

/** Already reported: the server is down, or the job's models aren't downloaded,
 *  which separation's full-mix toast covers. */
function isQuietFailure(err: unknown): boolean {
  return isBackendUnreachable(err) || err instanceof ModelsMissingError;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
