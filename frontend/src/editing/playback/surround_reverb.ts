// Mirrors src-tauri/crates/audio/src/effect.rs; change both together.
const REVERB_SEC = 2.4;
const HAAS_DELAY_SEC = 0.018;
const DIRECT_GAIN = 0.35;
const SIDE_GAIN = 0.4;
const WET_GAIN = 0.7;
const WET_LOWPASS_HZ = 6000;

/** Builds the effect feeding `output`; returns its input. */
export function createSurroundReverb(ctx: BaseAudioContext, output: AudioNode): AudioNode {
  const mono = new GainNode(ctx, { channelCount: 1, channelCountMode: 'explicit' });

  mono.connect(new GainNode(ctx, { gain: DIRECT_GAIN })).connect(output);

  // Delayed copy, in phase on the left and inverted on the right: pushes the
  // voice out to the sides and cancels when summed to mono.
  const delayed = mono.connect(new DelayNode(ctx, { delayTime: HAAS_DELAY_SEC }));
  const sides = new ChannelMergerNode(ctx, { numberOfInputs: 2 });
  delayed.connect(new GainNode(ctx, { gain: SIDE_GAIN })).connect(sides, 0, 0);
  delayed.connect(new GainNode(ctx, { gain: -SIDE_GAIN })).connect(sides, 0, 1);
  sides.connect(output);

  mono
    .connect(new ConvolverNode(ctx, { buffer: impulseResponse(ctx) }))
    .connect(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: WET_LOWPASS_HZ }))
    .connect(new GainNode(ctx, { gain: WET_GAIN }))
    .connect(output);

  return mono;
}

function impulseResponse(ctx: BaseAudioContext): AudioBuffer {
  const length = Math.round(REVERB_SEC * ctx.sampleRate);
  const ir = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const data = ir.getChannelData(c);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(10, (-3 * i) / length);
    }
  }
  return ir;
}
