/**
 * The song's beat/downbeat analysis, produced by the backend's Beat This!
 * tracker (`aligner/app/pipeline/beats/analyze.py::analyze_beats`) over the full
 * mix and returned from the `analyzeBeats` op. The frontend draws subtle beat
 * lines (downbeats thicker) on the audio + lyrics tracks from `beats` /
 * `downbeats`, and shows `bpm` + `timeSignature` as a readout.
 *
 * All times are seconds on the app's linear timeline. `downbeats` is an exact
 * subset of `beats` (same rounded values), so membership can be tested with a
 * `Set`.
 */

export type TimeSignature = { numerator: number; denominator: number };

export type BeatAnalysis = {
  /** Every detected beat time (seconds), ascending. */
  beats: number[];
  /** The bar-downbeat subset of `beats` (same values). */
  downbeats: number[];
  bpm: number;
  timeSignature: TimeSignature;
  hasTempoChanges: boolean;
  hasTimeSigChanges: boolean;
  /** True when Beat This! was unavailable and a plain librosa 4/4 tracker ran,
   *  so the grid is a low-trust assumption with no real downbeat classification. */
  beatFallbackUsed: boolean;
};

/** Parse the `beats` payload from an `analyzeBeats` result into a
 *  {@link BeatAnalysis}, or undefined when absent / malformed (best-effort: a bad
 *  payload just leaves the song without beat lines). */
export function parseBeatAnalysis(raw: unknown): BeatAnalysis | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const beats = parseNumberArray(r.beats);
  const downbeats = parseNumberArray(r.downbeats);
  if (!beats || !downbeats) return undefined;
  if (typeof r.bpm !== 'number' || !Number.isFinite(r.bpm)) return undefined;
  const timeSignature = parseTimeSignature(r.timeSignature);
  if (!timeSignature) return undefined;
  return {
    beats,
    downbeats,
    bpm: r.bpm,
    timeSignature,
    hasTempoChanges: r.hasTempoChanges === true,
    hasTimeSigChanges: r.hasTimeSigChanges === true,
    beatFallbackUsed: r.beatFallbackUsed === true,
  };
}

/** "128 BPM · 4/4" (or "4" numerator only would read oddly, so always n/d). */
export function formatBeatSummary(analysis: BeatAnalysis): string {
  const { numerator, denominator } = analysis.timeSignature;
  return `${Math.round(analysis.bpm)} BPM · ${numerator}/${denominator}`;
}

function parseNumberArray(raw: unknown): number[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = new Array<number>(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out[i] = v;
  }
  return out;
}

function parseTimeSignature(raw: unknown): TimeSignature | undefined {
  if (!Array.isArray(raw) || raw.length !== 2) return undefined;
  const [n, d] = raw as unknown[];
  if (typeof n !== 'number' || typeof d !== 'number' || !(n > 0) || !(d > 0)) return undefined;
  return { numerator: n, denominator: d };
}
