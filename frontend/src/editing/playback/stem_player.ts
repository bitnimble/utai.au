import type { StemPlayerMessage } from './stem_player_worklet';
import workletUrl from './stem_player_worklet.ts?worker&url';
import { endTrackEffects } from './track_effects';

const loading = new WeakMap<BaseAudioContext, Promise<void>>();

/** Needed once per context before {@link createStemPlayback}. */
export function loadStemPlayer(ctx: BaseAudioContext): Promise<void> {
  let load = loading.get(ctx);
  if (load == null) {
    load = ctx.audioWorklet.addModule(workletUrl);
    loading.set(ctx, load);
    load.catch(() => loading.delete(ctx));
  }
  return load;
}

export type StemPlayback = {
  readonly node: AudioNode;
  /** From song second `offsetSec`, starting at context time `when`. */
  play(when: number, offsetSec: number, rate: number): void;
  stop(): void;
  dispose(): void;
};

export function createStemPlayback(ctx: BaseAudioContext, source: MessagePort): StemPlayback {
  const node = new AudioWorkletNode(ctx, 'stem-player', {
    numberOfInputs: 0,
    outputChannelCount: [2],
  });
  const send = (msg: StemPlayerMessage, transfer: Transferable[] = []): void => node.port.postMessage(msg, transfer);
  send({ kind: 'source', port: source }, [source]);
  return {
    node,
    play: (when, offsetSec, rate) =>
      send({
        kind: 'play',
        // Whole: a fractional start would run all of a 1x play through interpolation, dulling its highs.
        frame: Math.round(offsetSec * ctx.sampleRate),
        atFrame: Math.round(when * ctx.sampleRate),
        rate,
      }),
    stop: () => send({ kind: 'stop' }),
    dispose: () => endTrackEffects(node),
  };
}
