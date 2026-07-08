import type { LyricsStore, LyricsTrack } from 'src/lyrics/store';
import { noteTargetsFromWord, type NoteTarget } from './scoring';

/** The reference melody to score against: every pitched note across a lyrics
 *  track's words, shifted by the track's user time-offset into playback time. */
export function referenceTargets(track: LyricsTrack | undefined): NoteTarget[] {
  if (track == null) return [];
  const targets: NoteTarget[] = [];
  for (const line of track.lines) {
    for (const word of line.words ?? []) {
      for (const t of noteTargetsFromWord(word)) {
        targets.push({ ...t, startSec: t.startSec + track.offsetSec, endSec: t.endSec + track.offsetSec });
      }
    }
  }
  return targets;
}

/** The first lyrics track carrying word-level pitch (what the offline pitch pass
 *  populated); undefined when no track has been aligned with the pitch stage. */
export function firstPitchedTrack(store: LyricsStore): LyricsTrack | undefined {
  for (const id of store.trackIds) {
    const track = store.get(id);
    if (track == null) continue;
    for (const line of track.lines) {
      for (const word of line.words ?? []) {
        if (word.midi != null || (word.pitchSegments != null && word.pitchSegments.length > 0)) {
          return track;
        }
      }
    }
  }
  return undefined;
}
