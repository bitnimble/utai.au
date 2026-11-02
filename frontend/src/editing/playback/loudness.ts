const TARGET_LUFS = -14;
const MAX_GAIN = 4;
const HOP_SEC = 0.1;
const HOPS_PER_BLOCK = 4;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = -10;

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/**
 * Measures a song fed through {@link add} a stretch at a time, holding only filter
 * state and one energy per hop, so its cost doesn't grow with the song's PCM.
 */
export class LoudnessMeter {
  private readonly energies: number[] = [];
  private readonly left: ChannelEnergy;
  private readonly right: ChannelEnergy;
  private readonly hopFrames: number;
  private peak = 0;
  private sumLeft = new Float32Array(0);
  private sumRight = new Float32Array(0);

  constructor(sampleRate: number) {
    this.hopFrames = hopFramesAt(sampleRate);
    this.left = new ChannelEnergy(sampleRate, this.hopFrames, this.energies);
    this.right = new ChannelEnergy(sampleRate, this.hopFrames, this.energies);
  }

  /** The next stretch of the song: each track's channels, measured summed. */
  add(tracks: readonly Float32Array[][]): void {
    const length = Math.max(0, ...tracks.flatMap((channels) => channels.map((c) => c.length)));
    if (this.sumLeft.length < length) {
      this.sumLeft = new Float32Array(length);
      this.sumRight = new Float32Array(length);
    }
    const left = this.sumLeft.subarray(0, length).fill(0);
    const right = this.sumRight.subarray(0, length).fill(0);
    for (const channels of tracks) {
      const l = channels[0];
      if (l == null) continue;
      // Mono plays out of both speakers, so it counts in both.
      const r = channels[1] ?? l;
      for (let i = 0; i < l.length; i++) left[i] += l[i];
      for (let i = 0; i < r.length; i++) right[i] += r[i];
    }
    this.left.add(left);
    this.right.add(right);
    this.peak = Math.max(this.peak, peakOf(left), peakOf(right));
  }

  /** The gain that brings the song to the target loudness without clipping. Silence gets 1. */
  gain(): number {
    const lufs = this.lufs();
    if (!Number.isFinite(lufs)) return 1;
    return Math.min(10 ** ((TARGET_LUFS - lufs) / 20), MAX_GAIN, 1 / this.peak);
  }

  /** ITU-R BS.1770 gated loudness; `-Infinity` when nothing passes the gates. */
  lufs(): number {
    return gatedLufs(this.energies, this.hopFrames);
  }
}

function hopFramesAt(sampleRate: number): number {
  return Math.round(sampleRate * HOP_SEC);
}

function gatedLufs(hopEnergies: readonly number[], hopFrames: number): number {
  const blocks: number[] = [];
  for (let end = HOPS_PER_BLOCK; end <= hopEnergies.length; end++) {
    const hops = hopEnergies.slice(end - HOPS_PER_BLOCK, end);
    blocks.push(hops.reduce((sum, e) => sum + e, 0) / (HOPS_PER_BLOCK * hopFrames));
  }
  const audible = blocks.filter((e) => energyToLufs(e) > ABSOLUTE_GATE_LUFS);
  if (audible.length === 0) return -Infinity;
  const relativeGate = energyToLufs(mean(audible)) + RELATIVE_GATE_LU;
  return energyToLufs(mean(audible.filter((e) => energyToLufs(e) > relativeGate)));
}

/** One channel's K-weighted energy, added into a shared list per completed hop. */
class ChannelEnergy {
  private readonly shelf: Biquad;
  private readonly highPass: Biquad;
  private shelf1 = 0;
  private shelf2 = 0;
  private pass1 = 0;
  private pass2 = 0;
  private hop = 0;
  private hopFill = 0;
  private hopEnergy = 0;

  constructor(
    sampleRate: number,
    private readonly hopFrames: number,
    private readonly energies: number[],
  ) {
    this.shelf = highShelf(sampleRate);
    this.highPass = rlbHighPass(sampleRate);
  }

  add(samples: Float32Array): void {
    const { shelf, highPass, hopFrames } = this;
    let { shelf1, shelf2, pass1, pass2, hopFill, hopEnergy } = this;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const shelved = shelf.b0 * x + shelf1;
      shelf1 = shelf.b1 * x - shelf.a1 * shelved + shelf2;
      shelf2 = shelf.b2 * x - shelf.a2 * shelved;
      const y = highPass.b0 * shelved + pass1;
      pass1 = highPass.b1 * shelved - highPass.a1 * y + pass2;
      pass2 = highPass.b2 * shelved - highPass.a2 * y;
      hopEnergy += y * y;
      if (++hopFill === hopFrames) {
        this.energies[this.hop] = (this.energies[this.hop] ?? 0) + hopEnergy;
        this.hop++;
        hopFill = 0;
        hopEnergy = 0;
      }
    }
    Object.assign(this, { shelf1, shelf2, pass1, pass2, hopFill, hopEnergy });
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

function peakOf(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}
