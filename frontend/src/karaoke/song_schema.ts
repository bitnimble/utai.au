/**
 * Zod schema for a saved-song bundle's `index.json`. A bundle is a `.zip`
 * carrying the "upfront work" for a song, the separated stems, the
 * word-aligned lyrics (as enhanced `.lrc`), and this manifest of light
 * metadata + where each file lives inside the archive.
 *
 * `index.json` never holds audio or lyric bytes itself, only relative
 * paths into the same zip. The loader validates against this schema before
 * trusting any of it (first Zod use in the repo).
 */

import { z } from 'zod';

/** Bumped when the bundle layout changes incompatibly. The loader rejects
 *  an unknown version rather than guessing. */
export const SONG_BUNDLE_VERSION = 1;

/** Mirrors the in-app `AudioTrackRole` plus the saved-only `backing`
 *  stem (the separation residual, absent from the live session until a
 *  song is loaded from a bundle). */
export const audioStemRoleSchema = z.enum(['full-mix', 'vocals', 'backing', 'unknown']);
export type AudioStemRole = z.infer<typeof audioStemRoleSchema>;

export const audioStemSchema = z.object({
  role: audioStemRoleSchema,
  /** Path within the zip, e.g. `audio/vocals.flac`. */
  file: z.string(),
  /** Original display filename, preserved for the mixer row label. */
  filename: z.string().optional(),
  durationSec: z.number().optional(),
});
export type AudioStemDoc = z.infer<typeof audioStemSchema>;

export const lyricsTrackDocSchema = z.object({
  /** Path within the zip, e.g. `lyrics/01-lrclib.lrc`. */
  file: z.string(),
  source: z.enum(['lrclib', 'file', 'plaintext']).optional(),
  sourceLabel: z.string().optional(),
  offsetSec: z.number().optional(),
  color: z.string().optional(),
});
export type LyricsTrackDoc = z.infer<typeof lyricsTrackDocSchema>;

export const songDocSchema = z.object({
  version: z.literal(SONG_BUNDLE_VERSION),
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  /** URL to cover art; not embedded, so an offline reload shows no art. */
  albumArtUrl: z.string().optional(),
  /** YouTube (or other) music-video URL. */
  musicVideoUrl: z.string().optional(),
  /** The streaming-service track URL the audio was fetched from, if any. */
  sourceUrl: z.string().optional(),
  durationSec: z.number().optional(),
  audio: z.array(audioStemSchema),
  lyrics: z.array(lyricsTrackDocSchema),
});
export type SongDoc = z.infer<typeof songDocSchema>;

/** Editable song facts, the subset a user can fill in before saving.
 *  Shared by the store, the details form, and the bundle writer. */
export type SongMeta = {
  title?: string;
  artist?: string;
  album?: string;
  albumArtUrl?: string;
  musicVideoUrl?: string;
  sourceUrl?: string;
};
