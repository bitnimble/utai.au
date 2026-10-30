import type { SignalsmithStretchNode } from 'signalsmith-stretch';

// Signalsmith overshoots full scale by up to 6 dB on loud material, which would clip at the output.
const STRETCH_GAIN = 0.5;

export type TrackStretcher = { node: SignalsmithStretchNode; output: GainNode };

/** Hands out Signalsmith worklet nodes holding a track's audio. They're reused because
 *  the processor has no way to end: dropped nodes would each keep a WASM instance alive. */
export class TrackStretchers {
  private readonly free: TrackStretcher[] = [];
  failed = false;

  async acquire(ctx: BaseAudioContext, buffer: AudioBuffer): Promise<TrackStretcher> {
    const stretcher = this.free.pop() ?? (await create(ctx));
    const left = buffer.getChannelData(0);
    // Mono as one channel, not the same array twice: the worklet's dropBuffers lists each
    // buffer to transfer, and a duplicate makes that throw.
    await stretcher.node.addBuffers(buffer.numberOfChannels > 1 ? [left, buffer.getChannelData(1)] : [left]);
    return stretcher;
  }

  release(stretcher: TrackStretcher): void {
    stretcher.output.disconnect();
    void stretcher.node.schedule({ active: false });
    void stretcher.node.dropBuffers();
    this.free.push(stretcher);
  }
}

async function create(ctx: BaseAudioContext): Promise<TrackStretcher> {
  const { default: SignalsmithStretch } = await import('signalsmith-stretch');
  const node = await SignalsmithStretch(ctx);
  const output = new GainNode(ctx, { gain: STRETCH_GAIN });
  node.connect(output);
  return { node, output };
}
