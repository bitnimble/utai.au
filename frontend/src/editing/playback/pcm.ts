/** 16-bit little-endian stereo: frame `n` is at byte `n * BYTES_PER_FRAME`. */
export const BYTES_PER_FRAME = 4;
export const PCM_CHUNK_FRAMES = 1 << 16;
export const PCM_PASS_CHUNK_FRAMES = 1 << 18;

/** Where a stem's PCM can be read from, in any thread. */
export type PcmOrigin = { kind: 'url'; url: string } | { kind: 'blob'; blob: Blob };

export type PcmStem = { origin: PcmOrigin; frames: number };

const READ_ATTEMPTS = 3;
const READ_RETRY_MS = 250;

/** One read at a time. */
export class PcmReader {
  // Reused: a pass over a whole song outruns GC, so fresh buffers would let its length show in peak memory.
  private scratch = new ArrayBuffer(0);

  /** Fills `left` / `right` from the stem; returns the frames written. */
  async read(
    origin: PcmOrigin,
    startFrame: number,
    frames: number,
    left: Float32Array,
    right: Float32Array,
  ): Promise<number> {
    const start = startFrame * BYTES_PER_FRAME;
    const bytes = frames * BYTES_PER_FRAME;
    for (let attempt = 1; ; attempt++) {
      try {
        return deinterleave(await this.readBytes(await byteStream(origin, start, start + bytes), bytes), left, right);
      } catch (err) {
        if (attempt === READ_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_MS));
      }
    }
  }

  private async readBytes(stream: ReadableStream<Uint8Array<ArrayBuffer>>, bytes: number): Promise<Int16Array> {
    // A read gone wrong takes the buffer with it, which leaves this empty.
    if (this.scratch.byteLength < bytes) this.scratch = new ArrayBuffer(bytes);
    const reader = stream.getReader({ mode: 'byob' });
    let filled = 0;
    while (filled < bytes) {
      const { value, done } = await reader.read(new Uint8Array(this.scratch, filled, bytes - filled));
      if (value != null) {
        this.scratch = value.buffer;
        filled += value.byteLength;
      }
      if (done) break;
    }
    void reader.cancel();
    if (filled < bytes) throw new Error(`PCM read came up short: ${filled} of ${bytes} bytes`);
    return new Int16Array(this.scratch, 0, bytes >> 1);
  }
}

async function byteStream(origin: PcmOrigin, start: number, end: number): Promise<ReadableStream<Uint8Array<ArrayBuffer>>> {
  if (origin.kind === 'blob') return origin.blob.slice(start, end).stream();
  const res = await fetch(origin.url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (res.status === 206 && res.body != null) return res.body;
  void res.body?.cancel();
  throw new Error(`PCM range answered ${res.status}`);
}

function deinterleave(samples: Int16Array, left: Float32Array, right: Float32Array): number {
  const frames = Math.min(samples.length >> 1, left.length);
  for (let i = 0; i < frames; i++) {
    left[i] = samples[i * 2] / 32768;
    right[i] = samples[i * 2 + 1] / 32768;
  }
  return frames;
}
