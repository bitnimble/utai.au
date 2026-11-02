/// <reference lib="webworker" />
import { LoudnessMeter } from './loudness';
import { PCM_CHUNK_FRAMES, PCM_PASS_CHUNK_FRAMES, PcmReader, type PcmStem } from './pcm';

const PCM_WINDOW_CHUNKS = 6;
const READ_FAILED_RETRY_MS = 1000;

export type SongPcmRequest =
  | { kind: 'open'; stems: PcmStem[]; sampleRate: number }
  | { kind: 'attach'; stem: number; port: MessagePort };

export type SongPcmResponse = { kind: 'opened'; loudnessGain: number } | { kind: 'failed'; message: string };

/** Sent by a consumer. `seek` restarts the stream from `frame`; `ack` hands back a finished chunk's room. */
export type PcmConsumerRequest =
  | { kind: 'seek'; generation: number; frame: number }
  | { kind: 'ack'; generation: number };

export type PcmChunk = {
  generation: number;
  frame: number;
  frames: number;
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
};

type StemHead = { frames: number; left: Float32Array; right: Float32Array };

class SongPcm {
  private stems: PcmStem[] = [];
  /** Read ahead so a preloaded song starts with its audio in hand. */
  private heads: StemHead[] = [];

  async open(stems: PcmStem[], sampleRate: number): Promise<SongPcmResponse> {
    this.stems = stems;
    try {
      const loudnessGain = await this.measureLoudness(sampleRate);
      this.heads = await Promise.all(stems.map(readHead));
      return { kind: 'opened', loudnessGain };
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
    }
  }

  attach(stem: number, port: MessagePort): void {
    new PcmStream(port, this.stems[stem], this.heads[stem]);
  }

  /** 1 when it can't be measured: the song still plays. */
  private async measureLoudness(sampleRate: number): Promise<number> {
    try {
      const meter = new LoudnessMeter(sampleRate);
      const totalFrames = Math.max(0, ...this.stems.map((s) => s.frames));
      const readers = this.stems.map(() => ({
        reader: new PcmReader(),
        left: new Float32Array(PCM_PASS_CHUNK_FRAMES),
        right: new Float32Array(PCM_PASS_CHUNK_FRAMES),
      }));
      for (let frame = 0; frame < totalFrames; frame += PCM_PASS_CHUNK_FRAMES) {
        const frames = Math.min(PCM_PASS_CHUNK_FRAMES, totalFrames - frame);
        const tracks = await Promise.all(
          this.stems.map(async (stem, s) => {
            const { reader, left, right } = readers[s];
            const toRead = Math.min(frames, stem.frames - frame);
            const written = toRead > 0 ? await reader.read(stem.origin, frame, toRead, left, right) : 0;
            left.fill(0, written, frames);
            right.fill(0, written, frames);
            return [left.subarray(0, frames), right.subarray(0, frames)];
          }),
        );
        meter.add(tracks);
      }
      return meter.gain();
    } catch (err) {
      console.error('[loudness] measurement failed:', err);
      return 1;
    }
  }
}

async function readHead(stem: PcmStem): Promise<StemHead> {
  const wanted = Math.min(PCM_CHUNK_FRAMES, stem.frames);
  const left = new Float32Array(wanted);
  const right = new Float32Array(wanted);
  const frames = await new PcmReader().read(stem.origin, 0, wanted, left, right);
  return { frames, left, right };
}

class PcmStream {
  private generation = 0;
  private nextFrame = 0;
  private room = 0;
  private pumping = false;
  private closed = false;
  private readonly reader = new PcmReader();

  constructor(
    private readonly port: MessagePort,
    private readonly stem: PcmStem,
    private readonly head: StemHead,
  ) {
    port.onmessage = (e: MessageEvent<PcmConsumerRequest>) => this.onRequest(e.data);
    port.addEventListener('close', () => {
      this.closed = true;
    });
  }

  private onRequest(msg: PcmConsumerRequest): void {
    if (msg.kind === 'seek') {
      this.generation = msg.generation;
      this.nextFrame = msg.frame;
      this.room = PCM_WINDOW_CHUNKS;
    } else if (msg.generation === this.generation) {
      this.room++;
    }
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    while (!this.closed && this.room > 0 && this.nextFrame < this.stem.frames) {
      const { generation, nextFrame: frame } = this;
      const frames = Math.min(PCM_CHUNK_FRAMES, this.stem.frames - frame);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      try {
        const written = await this.readChunk(frame, frames, left, right);
        if (generation !== this.generation) continue;
        this.room--;
        this.nextFrame += frames;
        this.port.postMessage({ generation, frame, frames: written, left, right } satisfies PcmChunk, [
          left.buffer,
          right.buffer,
        ]);
      } catch (err) {
        if (generation !== this.generation) continue;
        console.error('[pcm] read failed:', err);
        // No ack will restart this once the consumer has run dry, so it has to keep trying.
        await new Promise((resolve) => setTimeout(resolve, READ_FAILED_RETRY_MS));
      }
    }
    this.pumping = false;
  }

  private async readChunk(frame: number, frames: number, left: Float32Array, right: Float32Array): Promise<number> {
    if (frame !== 0) return this.reader.read(this.stem.origin, frame, frames, left, right);
    left.set(this.head.left);
    right.set(this.head.right);
    return this.head.frames;
  }
}

const song = new SongPcm();
const ctx = self as unknown as DedicatedWorkerGlobalScope;
ctx.onmessage = (e: MessageEvent<SongPcmRequest>) => {
  const msg = e.data;
  if (msg.kind === 'attach') song.attach(msg.stem, msg.port);
  else void song.open(msg.stems, msg.sampleRate).then((response) => ctx.postMessage(response));
};
