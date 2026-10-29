// AudioWorkletGlobalScope, which TypeScript's DOM lib doesn't describe.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new (options: { processorOptions: { module: WebAssembly.Module } }) => AudioWorkletProcessor,
): void;

type Exports = {
  memory: WebAssembly.Memory;
  surround_reverb_new(sampleRate: number, maxFrames: number): number;
  surround_reverb_block(fx: number): number;
  surround_reverb_process(fx: number, frames: number): void;
};

const QUANTUM_FRAMES = 128;

class SurroundReverbProcessor extends AudioWorkletProcessor {
  private readonly wasm: Exports;
  private readonly fx: number;
  private block: Float32Array;
  private disposed = false;

  constructor(options: { processorOptions: { module: WebAssembly.Module } }) {
    super();
    const instance = new WebAssembly.Instance(options.processorOptions.module, {});
    this.wasm = instance.exports as unknown as Exports;
    this.fx = this.wasm.surround_reverb_new(sampleRate, QUANTUM_FRAMES);
    this.block = this.view();
    this.port.onmessage = () => {
      this.disposed = true;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.disposed) return false;
    // A memory.grow detaches the old view.
    if (this.block.byteLength === 0) this.block = this.view();
    const [inL, inR = inL] = inputs[0];
    const [outL, outR] = outputs[0];
    const frames = outL.length;
    for (let i = 0; i < frames; i++) {
      this.block[i * 2] = inL?.[i] ?? 0;
      this.block[i * 2 + 1] = inR?.[i] ?? 0;
    }
    this.wasm.surround_reverb_process(this.fx, frames);
    for (let i = 0; i < frames; i++) {
      outL[i] = this.block[i * 2];
      outR[i] = this.block[i * 2 + 1];
    }
    // Kept alive while disconnected, so a switched-off tail rings out and a
    // switch back on reuses it; the owner posts a message to end it.
    return true;
  }

  private view(): Float32Array {
    const ptr = this.wasm.surround_reverb_block(this.fx);
    return new Float32Array(this.wasm.memory.buffer, ptr, QUANTUM_FRAMES * 2);
  }
}

registerProcessor('surround-reverb', SurroundReverbProcessor);

// A module, so the scope declarations above stay out of the app's globals.
export {};
