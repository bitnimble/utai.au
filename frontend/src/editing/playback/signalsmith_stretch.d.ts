declare module 'signalsmith-stretch' {
  export type SignalsmithStretchNode = AudioWorkletNode & {
    /** Where it's got to in the audio it holds, in seconds from the first buffer since a full drop. */
    inputTime: number;
    addBuffers(channels: Float32Array[], transfer?: Transferable[]): Promise<number>;
    /** Everything, or only whole buffers ending before `toSeconds`. Resolves to what it still holds. */
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    schedule(change: { active?: boolean; input?: number; rate?: number; output?: number }): Promise<void>;
  };

  export default function SignalsmithStretch(
    ctx: BaseAudioContext,
    channelOptions?: AudioWorkletNodeOptions,
  ): Promise<SignalsmithStretchNode>;
}
