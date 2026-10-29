import wasmUrl from './surround_reverb.wasm?url';
import workletUrl from './surround_reverb_worklet.ts?worker&url';

let wasm: Promise<WebAssembly.Module> | undefined;
const loading = new WeakMap<BaseAudioContext, Promise<void>>();
const loaded = new WeakMap<BaseAudioContext, WebAssembly.Module>();

/** Fetches the effect and registers it on `ctx`; needed once per context
 *  before {@link createSurroundReverb}. */
export function loadSurroundReverb(ctx: BaseAudioContext): Promise<void> {
  let load = loading.get(ctx);
  if (load == null) {
    wasm ??= fetch(wasmUrl)
      .then((res) => res.arrayBuffer())
      .then((bytes) => WebAssembly.compile(bytes));
    load = Promise.all([wasm, ctx.audioWorklet.addModule(workletUrl)]).then(([module]) => {
      loaded.set(ctx, module);
    });
    loading.set(ctx, load);
  }
  return load;
}

/** The effect, feeding `output`; `undefined` until {@link loadSurroundReverb}
 *  resolves for `ctx`. Post it a message to end it. */
export function createSurroundReverb(ctx: BaseAudioContext, output: AudioNode): AudioWorkletNode | undefined {
  const module = loaded.get(ctx);
  if (module == null) return undefined;
  const node = new AudioWorkletNode(ctx, 'surround-reverb', {
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    processorOptions: { module },
  });
  node.connect(output);
  return node;
}
