const TARGET_LUFS = -14;
const MAX_GAIN = 4;
const HOP_SEC = 0.1;
const HOPS_PER_BLOCK = 4;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/**
 * The gain that brings a song to the target loudness without clipping. `tracks`
 * holds each track's channels; they're measured summed, so one gain applies to
 * every stem and muting one doesn't move the level. Silence gets 1.
 */
export function songLoudnessGain(tracks: readonly Float32Array[][], sampleRate: number): number {
  const stereo = sumToStereo(tracks);
  const lufs = integratedLufs(stereo, sampleRate);
  if (!Number.isFinite(lufs)) return 1;
  return Math.min(10 ** ((TARGET_LUFS - lufs) / 20), MAX_GAIN, 1 / peakOf(stereo));
}

/** ITU-R BS.1770 gated loudness of `channels`; `-Infinity` when nothing passes the gates. */
export function integratedLufs(channels: readonly Float32Array[], sampleRate: number): number {
  const hopFrames = Math.round(sampleRate * HOP_SEC);
  const hopEnergies = new Float64Array(Math.floor((channels[0]?.length ?? 0) / hopFrames));
  for (const channel of channels) addHopEnergies(channel, sampleRate, hopFrames, hopEnergies);

  const blocks: number[] = [];
  for (let end = HOPS_PER_BLOCK; end <= hopEnergies.length; end++) {
    const hops = hopEnergies.subarray(end - HOPS_PER_BLOCK, end);
    blocks.push(hops.reduce((sum, e) => sum + e, 0) / (HOPS_PER_BLOCK * hopFrames));
  }
  const audible = blocks.filter((e) => energyToLufs(e) > ABSOLUTE_GATE_LUFS);
  if (audible.length === 0) return -Infinity;
  const relativeGate = energyToLufs(mean(audible)) + RELATIVE_GATE_LU;
  return energyToLufs(mean(audible.filter((e) => energyToLufs(e) > relativeGate)));
}

function sumToStereo(tracks: readonly Float32Array[][]): [Float32Array, Float32Array] {
  const length = Math.max(0, ...tracks.flatMap((channels) => channels.map((c) => c.length)));
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const channels of tracks) {
    const l = channels[0];
    if (l == null) continue;
    // Mono plays out of both speakers, so it counts in both.
    const r = channels[1] ?? l;
    for (let i = 0; i < l.length; i++) left[i] += l[i];
    for (let i = 0; i < r.length; i++) right[i] += r[i];
  }
  return [left, right];
}

function addHopEnergies(samples: Float32Array, sampleRate: number, hopFrames: number, energies: Float64Array): void {
  const shelf = highShelf(sampleRate);
  const highPass = rlbHighPass(sampleRate);
  let shelf1 = 0;
  let shelf2 = 0;
  let pass1 = 0;
  let pass2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const shelved = shelf.b0 * x + shelf1;
    shelf1 = shelf.b1 * x - shelf.a1 * shelved + shelf2;
    shelf2 = shelf.b2 * x - shelf.a2 * shelved;
    const y = highPass.b0 * shelved + pass1;
    pass1 = highPass.b1 * shelved - highPass.a1 * y + pass2;
    pass2 = highPass.b2 * shelved - highPass.a2 * y;
    energies[Math.floor(i / hopFrames)] += y * y;
  }
}

/** BS.1770 lists these coefficients at 48 kHz only; these are libebur128's analog prototypes for any rate. */
function highShelf(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  const a0 = 1 + k / q + k * k;
  return {
    b0: (vh + (vb * k) / q + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / q + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / q + k * k) / a0,
  };
}

function rlbHighPass(sampleRate: number): Biquad {
  const k = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  const q = 0.5003270373238773;
  const a0 = 1 + k / q + k * k;
  return { b0: 1, b1: -2, b2: 1, a1: (2 * (k * k - 1)) / a0, a2: (1 - k / q + k * k) / a0 };
}

function energyToLufs(energy: number): number {
  return -0.691 + 10 * Math.log10(energy);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function peakOf(channels: readonly Float32Array[]): number {
  let peak = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
  }
  return peak;
}
