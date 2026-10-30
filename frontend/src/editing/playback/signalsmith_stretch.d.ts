declare module 'signalsmith-stretch' {
  export type SignalsmithStretchNode = AudioWorkletNode & {
    addBuffers(channels: Float32Array[]): Promise<number>;
    dropBuffers(): Promise<unknown>;
    schedule(change: { active?: boolean; input?: number; rate?: number; output?: number }): Promise<void>;
  };

  export default function SignalsmithStretch(
    ctx: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<SignalsmithStretchNode>;
}
