import { expect, test } from 'bun:test';
import { LyricsStore } from '../store';

test('a track added first goes on top and becomes the first track', () => {
  const store = new LyricsStore();
  store.add([], { source: 'file', sourceLabel: 'old' });
  store.add([], { source: 'plaintext', sourceLabel: 'imported', first: true });
  store.add([], { source: 'file', sourceLabel: 'appended' });

  expect(store.trackIds.map((id) => store.get(id)?.sourceLabel)).toEqual(['imported', 'old', 'appended']);
  expect(store.firstTrack?.sourceLabel).toBe('imported');
});
