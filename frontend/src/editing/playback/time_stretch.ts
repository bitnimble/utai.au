import type { SignalsmithStretchNode } from 'signalsmith-stretch';
import type { StemPcm } from './song_pcm';
import type { PcmChunk, PcmConsumerRequest } from './song_pcm_worker';

// Signalsmith overshoots full scale by up to 6 dB on loud material, which would clip at the output.
const STRETCH_GAIN = 0.5;
const PREROLL_SEC = 1;
const KEEP_BEHIND_SEC = 2;
const TRIM_INTERVAL_MS = 1000;
const TRIM_SETTLE_SEC = 0.5;
const MIN_LEAD_CHUNKS = 2;

export type TrackStretcher = {
  readonly output: GainNode;
  /** Plays the stem from song second `offsetSec` at context time `when`, at `rate`. */
  schedule(when: number, offsetSec: number, rate: number): void;
  pause(): void;
};

export class StreamedStretcher implements TrackStretcher {
  private source: MessagePort | undefined;
  private generation = 0;
  /** Song seconds of the node's input time 0, and how far its fed audio reaches past that. */
  private originSec = 0;
  private fedSec = 0;
  /** Where in the window the node's audio starts, what's before it having been dropped. */
  private heldFromSec = 0;
  private chunkSec = 0;
  /** How much of the window has been handed back to the worker. */
  private ackedSec = 0;
  // The node reports its old position for a moment after a schedule, which would trim the wrong audio.
  private trimFromCtxSec = 0;
  /** Waiting on the first chunk of a new window. */
  private pendingStart: { when: number; offsetSec: number; rate: number } | undefined;
  private trimTimer: number | undefined;

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly node: SignalsmithStretchNode,
    readonly output: GainNode,
  ) {}

  feedFrom(pcm: StemPcm): void {
    this.source = pcm.attach();
    this.source.onmessage = (e: MessageEvent<PcmChunk>) => this.onChunk(e.data);
    this.trimTimer = window.setInterval(() => this.trim(), TRIM_INTERVAL_MS);
  }

  stopFeeding(): void {
    window.clearInterval(this.trimTimer);
    this.source?.close();
    this.source = undefined;
    this.pendingStart = undefined;
    this.fedSec = 0;
    void this.node.schedule({ active: false });
    void this.node.dropBuffers();
  }

  schedule(when: number, offsetSec: number, rate: number): void {
    const input = offsetSec - this.originSec;
    this.trimFromCtxSec = when + TRIM_SETTLE_SEC;
    // Room comes back only as trims free it, too slowly to save a jump to the edge of what's fed.
    const leadSec = MIN_LEAD_CHUNKS * this.chunkSec;
    if (this.fedSec > 0 && input >= this.heldFromSec && input + leadSec < this.fedSec) {
      void this.node.schedule({ active: true, input, rate, output: when });
      return;
    }
    void this.node.schedule({ active: false });
    void this.node.dropBuffers();
    this.originSec = Math.max(0, offsetSec - PREROLL_SEC);
    this.fedSec = 0;
    this.heldFromSec = 0;
    this.chunkSec = 0;
    this.ackedSec = 0;
    this.pendingStart = { when, offsetSec, rate };
    this.generation++;
    this.send({ kind: 'seek', generation: this.generation, frame: Math.floor(this.originSec * this.ctx.sampleRate) });
  }

  pause(): void {
    this.pendingStart = undefined;
    void this.node.schedule({ active: false });
  }

  private onChunk(chunk: PcmChunk): void {
    if (chunk.generation !== this.generation) return;
    void this.node.addBuffers([chunk.left, chunk.right], [chunk.left.buffer, chunk.right.buffer]);
    if (this.chunkSec === 0) this.chunkSec = chunk.frames / this.ctx.sampleRate;
    this.fedSec += chunk.frames / this.ctx.sampleRate;
    const start = this.pendingStart;
    if (start == null) return;
    this.pendingStart = undefined;
    const now = this.ctx.currentTime;
    const lateSec = Math.max(0, now - start.when);
    this.trimFromCtxSec = start.when + lateSec + TRIM_SETTLE_SEC;
    void this.node.schedule({
      active: true,
      input: start.offsetSec - this.originSec + lateSec * start.rate,
      rate: start.rate,
      output: start.when + lateSec,
    });
  }

  private trim(): void {
    if (this.ctx.currentTime < this.trimFromCtxSec || this.pendingStart != null) return;
    const playedSec = this.node.inputTime - KEEP_BEHIND_SEC;
    if (playedSec <= 0) return;
    const { generation } = this;
    void this.node.dropBuffers(playedSec).then(({ start }) => {
      if (generation !== this.generation) return;
      this.heldFromSec = start;
      while (this.chunkSec > 0 && this.ackedSec + this.chunkSec <= start) {
        this.ackedSec += this.chunkSec;
        this.send({ kind: 'ack', generation });
      }
    });
  }

  private send(msg: PcmConsumerRequest): void {
    this.source?.postMessage(msg);
  }
}

/** Hands out Signalsmith worklet nodes streaming a track's audio. They're reused because
 *  the processor has no way to end: dropped nodes would each keep a WASM instance alive. */
export class TrackStretchers {
  private readonly free: StreamedStretcher[] = [];
  failed = false;

  async acquire(ctx: BaseAudioContext, pcm: StemPcm): Promise<TrackStretcher> {
    const stretcher = this.free.pop() ?? (await create(ctx));
    stretcher.feedFrom(pcm);
    return stretcher;
  }

  release(stretcher: TrackStretcher): void {
    if (!(stretcher instanceof StreamedStretcher)) return;
    stretcher.output.disconnect();
    stretcher.stopFeeding();
    this.free.push(stretcher);
  }
}

async function create(ctx: BaseAudioContext): Promise<StreamedStretcher> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch');
  const node = await SignalsmithStretch(ctx);
  const output = new GainNode(ctx, { gain: STRETCH_GAIN });
  node.connect(output);
  return new StreamedStretcher(ctx, node, output);
}
