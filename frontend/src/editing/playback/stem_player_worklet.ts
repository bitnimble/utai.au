import type { PcmChunk, PcmConsumerRequest } from './song_pcm_worker';

// AudioWorkletGlobalScope, which TypeScript's DOM lib doesn't describe.
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

export type StemPlayerMessage =
  | { kind: 'source'; port: MessagePort }
  | { kind: 'play'; frame: number; atFrame: number; rate: number }
  | { kind: 'stop' }
  | 'dispose';

class StemPlayerProcessor extends AudioWorkletProcessor {
  private source: MessagePort | undefined;
  private chunks: PcmChunk[] = [];
  private generation = 0;
  private playing = false;
  private startFrame = 0;
  private atFrame = 0;
  private rate = 1;
  private disposed = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<StemPlayerMessage>) => this.onMessage(e.data);
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.disposed) {
      this.port.postMessage('ended');
      return false;
    }
    const [outL, outR] = outputs[0];
    if (!this.playing) return true;
    for (let i = 0; i < outL.length; i++) {
      const elapsed = currentFrame + i - this.atFrame;
      if (elapsed < 0) continue;
      // From the clock alone: a stem whose audio is late rejoins in place, keeping stems sample-locked.
      const position = this.startFrame + elapsed * this.rate;
      this.dropFinishedChunks(position);
      const whole = Math.floor(position);
      const fraction = position - whole;
      outL[i] = this.sample('left', whole, fraction);
      outR[i] = this.sample('right', whole, fraction);
    }
    return true;
  }

  private onMessage(msg: StemPlayerMessage): void {
    if (msg === 'dispose') {
      this.disposed = true;
      this.source?.close();
    } else if (msg.kind === 'source') {
      this.source = msg.port;
      this.source.onmessage = (e: MessageEvent<PcmChunk>) => this.onChunk(e.data);
    } else if (msg.kind === 'stop') {
      this.playing = false;
    } else {
      this.playing = true;
      this.startFrame = msg.frame;
      this.atFrame = msg.atFrame;
      this.rate = msg.rate;
      if (!this.holds(Math.floor(msg.frame))) this.restartFrom(Math.floor(msg.frame));
    }
  }

  private holds(frame: number): boolean {
    return this.chunks.some((chunk) => frame >= chunk.frame && frame < chunk.frame + chunk.frames);
  }

  private restartFrom(frame: number): void {
    this.chunks = [];
    this.generation++;
    this.send({ kind: 'seek', generation: this.generation, frame });
  }

  private onChunk(chunk: PcmChunk): void {
    if (chunk.generation === this.generation) this.chunks.push(chunk);
  }

  private dropFinishedChunks(position: number): void {
    while (this.chunks.length > 0 && position >= this.chunks[0].frame + this.chunks[0].frames) {
      this.chunks.shift();
      this.send({ kind: 'ack', generation: this.generation });
    }
  }

  /** Only off 1x, when the stretcher failed, does `fraction` come into it. */
  private sample(channel: 'left' | 'right', whole: number, fraction: number): number {
    const here = this.at(channel, whole);
    return fraction === 0 ? here : here + (this.at(channel, whole + 1) - here) * fraction;
  }

  private at(channel: 'left' | 'right', frame: number): number {
    for (const chunk of this.chunks) {
      const offset = frame - chunk.frame;
      if (offset >= 0 && offset < chunk.frames) return chunk[channel][offset];
    }
    return 0;
  }

  private send(msg: PcmConsumerRequest): void {
    this.source?.postMessage(msg);
  }
}

registerProcessor('stem-player', StemPlayerProcessor);
