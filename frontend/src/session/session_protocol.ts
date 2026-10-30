import { z } from 'zod';

const MAX_SEARCH_QUERY_CHARS = 200;

const trackResultSchema = z.object({
  id: z.string(),
  service: z.string(),
  title: z.string(),
  artists: z.string(),
  album: z.string().nullish(),
  durationSec: z.number().nullish(),
  coverUrl: z.string().nullish(),
  sourceUrl: z.string(),
  uploaderTitled: z.boolean(),
});

const remoteQueueStatusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('waiting') }),
  z.object({ kind: z.literal('downloading'), frac: z.number() }),
  z.object({ kind: z.literal('loadingModels') }),
  z.object({ kind: z.literal('separating') }),
  z.object({ kind: z.literal('aligning') }),
  z.object({ kind: z.literal('ready') }),
  z.object({ kind: z.literal('failed'), message: z.string() }),
]);
export type RemoteQueueStatus = z.infer<typeof remoteQueueStatusSchema>;

const remoteQueueItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  status: remoteQueueStatusSchema,
  /** Streaming items only: lets a reloaded host re-queue them. */
  track: trackResultSchema.optional(),
});
export type RemoteQueueItem = z.infer<typeof remoteQueueItemSchema>;

const remotePlayedSongSchema = z.object({
  title: z.string(),
  artist: z.string(),
  /** Streaming songs only: what a remote re-adds, and a reloaded host restores. */
  track: trackResultSchema.optional(),
});
export type RemotePlayedSong = z.infer<typeof remotePlayedSongSchema>;

export const hostStateSchema = z.object({
  nowPlaying: z
    .object({
      title: z.string(),
      artist: z.string(),
      albumArtUrl: z.string().optional(),
      durationSec: z.number(),
    })
    .nullable(),
  playback: z.enum(['idle', 'playing', 'paused']),
  positionSec: z.number(),
  outputVolume: z.number(),
  /** The current song's vocal stem; null until it's separated. */
  vocals: z.object({ volume: z.number(), muted: z.boolean() }).nullable().default(null),
  queue: z.array(remoteQueueItemSchema),
  history: z.array(remotePlayedSongSchema).default([]),
  waitingForId: z.string().optional(),
  canSkip: z.boolean(),
});
export type HostState = z.infer<typeof hostStateSchema>;

export const remoteCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('play') }),
  z.object({ kind: z.literal('pause') }),
  z.object({ kind: z.literal('seek'), sec: z.number() }),
  z.object({ kind: z.literal('skip') }),
  z.object({ kind: z.literal('setVolume'), volume: z.number() }),
  z.object({ kind: z.literal('setVocalVolume'), volume: z.number() }),
  z.object({ kind: z.literal('setVocalMuted'), muted: z.boolean() }),
  z.object({ kind: z.literal('add'), track: trackResultSchema }),
  z.object({ kind: z.literal('remove'), id: z.string() }),
  z.object({ kind: z.literal('move'), id: z.string(), toIndex: z.number().int() }),
  z.object({ kind: z.literal('playNext'), id: z.string() }),
  z.object({ kind: z.literal('search'), requestId: z.number(), query: z.string().max(MAX_SEARCH_QUERY_CHARS) }),
]);
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;

export const hostReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('searchResults'), requestId: z.number(), results: z.array(trackResultSchema) }),
  z.object({ kind: z.literal('searchError'), requestId: z.number(), message: z.string() }),
]);
export type HostReply = z.infer<typeof hostReplySchema>;

export const relayFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    clientId: z.string(),
    hostConnected: z.boolean(),
    state: z.unknown(),
  }),
  z.object({ type: z.literal('state'), state: z.unknown() }),
  z.object({ type: z.literal('host'), connected: z.boolean() }),
  z.object({ type: z.literal('command'), from: z.string(), command: z.unknown() }),
  z.object({ type: z.literal('reply'), reply: z.unknown() }),
  z.object({ type: z.literal('replaced') }),
]);
export type RelayFrame = z.infer<typeof relayFrameSchema>;

export const CLOSE_NO_SESSION = 4404;
export const CLOSE_BAD_TOKEN = 4403;
export const CLOSE_REPLACED = 4000;
