import { describe, expect, test } from 'bun:test';
import { PrepareStage, trackStage } from '../prepare_song';

describe('trackStage', () => {
  test('shows loading while any job loads, then the stage once all are running', async () => {
    const seen: string[] = [];
    const track = trackStage({ kind: 'separating' }, (s: PrepareStage) => seen.push(s.kind));
    let finishBeats!: () => void;

    const stems = track(async (onProgress) => {
      onProgress({ kind: 'loading' });
      await Promise.resolve();
      onProgress({ kind: 'running' });
    });
    const beats = track(
      (onProgress) =>
        new Promise<void>((resolve) => {
          onProgress({ kind: 'loading' });
          finishBeats = resolve;
        }),
    );
    await stems;
    expect(seen.at(-1)).toBe('loadingModels');

    finishBeats();
    await beats;
    expect(seen).toEqual(['separating', 'loadingModels', 'loadingModels', 'loadingModels', 'separating']);
  });

  test('a job that fails while loading stops counting as loading', async () => {
    const seen: string[] = [];
    const track = trackStage({ kind: 'aligning' }, (s: PrepareStage) => seen.push(s.kind));

    await track(async (onProgress) => {
      onProgress({ kind: 'loading' });
      throw new Error('no model');
    }).catch(() => undefined);

    expect(seen).toEqual(['aligning', 'loadingModels', 'aligning']);
  });
});
