import wasmUrl from './track_effects.wasm?url';
import workletUrl from './track_effects_worklet.ts?worker&url';

// Bit order matches EffectKind::ALL in src-tauri/crates/audio/src/effects.rs.
export const TRACK_EFFECTS = ['surround-reverb'] as const;
export type TrackEffect = (typeof TRACK_EFFECTS)[number];

export function trackEffectMask(effects: readonly TrackEffect[]): number {
  return effects.reduce((mask, effect) => mask | (1 << TRACK_EFFECTS.indexOf(effect)), 0);
}

let wasm: Promise<WebAssembly.Module> | undefined;
const loading = new WeakMap<BaseAudioContext, Promise<void>>();
const loaded = new WeakMap<BaseAudioContext, WebAssembly.Module>();

/** Fetches the effects and registers them on `ctx`; needed once per context
 *  before {@link createTrackEffects}. */
export function loadTrackEffects(ctx: BaseAudioContext): Promise<void> {
  let load = loading.get(ctx);
  if (load == null) {
    wasm ??= fetch(wasmUrl)
      .then((res) => res.arrayBuffer())
      .then((bytes) => WebAssembly.compile(bytes));
    load = Promise.all([wasm, ctx.audioWorklet.addModule(workletUrl)]).then(([module]) => {
      loaded.set(ctx, module);
    });
    loading.set(ctx, load);
    // Forget a failure (a network blip, say) so the next call retries instead of staying dry until reload.
    load.catch(() => {
      loading.delete(ctx);
      wasm = undefined;
    });
  }
  return load;
}

/** The effect chain for `mask`, feeding `output`; `undefined` until
 *  {@link loadTrackEffects} resolves for `ctx`. End it with {@link endTrackEffects}. */
export function createTrackEffects(
  ctx: BaseAudioContext,
  output: AudioNode,
  mask: number,
): AudioWorkletNode | undefined {
  const module = loaded.get(ctx);
  if (module == null) return undefined;
  const node = new AudioWorkletNode(ctx, 'track-effects', {
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { module, mask },
  });
  node.connect(output);
  return node;
}

export function endTrackEffects(node: AudioWorkletNode): void {
  // Pulled by a muted sink until the processor confirms it stopped: cut off from the graph,
  // its process() may never run again, leaving it and its WASM instance alive.
  node.disconnect();
  node.connect(silentSink(node.context));
  node.port.onmessage = () => node.disconnect();
  node.port.postMessage('dispose');
}

const silentSinks = new WeakMap<BaseAudioContext, GainNode>();

function silentSink(ctx: BaseAudioContext): GainNode {
  let sink = silentSinks.get(ctx);
  if (sink == null) {
    sink = new GainNode(ctx, { gain: 0 });
    sink.connect(ctx.destination);
    silentSinks.set(ctx, sink);
  }
  return sink;
}
