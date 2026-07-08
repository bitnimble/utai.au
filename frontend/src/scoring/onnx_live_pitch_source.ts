import type * as Ort from 'onnxruntime-web';
import { utaiPlayer } from 'src/editing/playback/player';
import { frameFromHz, type LivePitchListener, type LivePitchSource } from './live_pitch_source';

/**
 * Web {@link LivePitchSource}: SwiftF0 over onnxruntime-web on the live mic.
 *
 * The mic is tapped through an `AnalyserNode` on the shared AudioContext (same
 * pattern as the level meter in web_audio_backend.ts), no audible connection,
 * just a rolling most-recent window we resample to 16 kHz and feed the model.
 * onnxruntime-web is dynamic-imported so its (large) WASM bundle only loads when
 * a scoring session starts, and code-splits out of the main app chunk.
 *
 * SwiftF0's octave-doubling weakness is on separated stems with bleed; a close
 * mic is a clean solo signal, so it holds up well here. Desktop uses the
 * sidecar RMVPE path instead (see SidecarLivePitchSource) for parity with the
 * offline reference.
 */

/** Emit cadence; also the `fps` the scoring DSP uses for vibrato timing. Kept
 *  below the WASM inference budget so the self-scheduling loop actually holds it. */
const TARGET_FPS = 40;
/** Analysis window (power of two): ~0.34 s at 48 kHz / ~0.37 s at 44.1 kHz, long
 *  enough for a stable low-note estimate, short enough to stay responsive. */
const FFT_SIZE = 16384;
const SR_TARGET = 16000;

const DEFAULT_MODEL_URL = 'https://huggingface.co/bitnimble/utai-onnx/resolve/main/f0_swiftf0.onnx';

export class OnnxLivePitchSource implements LivePitchSource {
  readonly fps = TARGET_FPS;

  private readonly listeners = new Set<LivePitchListener>();
  private ort: typeof Ort | undefined;
  private session: Ort.InferenceSession | undefined;
  private inputName = '';
  private pitchName = '';
  private confName = '';

  private stream: MediaStream | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private analyser: AnalyserNode | undefined;
  private timeBuf: Float32Array<ArrayBuffer> | undefined;
  private srcSampleRate = 48000;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly modelUrl: string = DEFAULT_MODEL_URL) {}

  async start(inputId: string): Promise<void> {
    if (this.session == null) await this.loadModel();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = utaiPlayer.getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser); // analysis tap only, not routed to output

    this.stream = stream;
    this.source = source;
    this.analyser = analyser;
    this.srcSampleRate = ctx.sampleRate;
    this.timeBuf = new Float32Array(analyser.fftSize);
    this.running = true;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = undefined;
    this.source?.disconnect();
    this.analyser?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.source = undefined;
    this.analyser = undefined;
    this.timeBuf = undefined;
  }

  onFrame(cb: LivePitchListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private async loadModel(): Promise<void> {
    // onnxruntime-web resolves its WASM from the Vite-emitted asset (via
    // import.meta.url), so no wasmPaths override, keeps it offline-capable.
    const ort = await import('onnxruntime-web');
    const res = await fetch(this.modelUrl);
    if (!res.ok) throw new Error(`pitch model fetch failed (${res.status})`);
    const bytes = await res.arrayBuffer();
    this.session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
    this.ort = ort;
    this.inputName = this.session.inputNames[0];
    const outs = this.session.outputNames;
    this.confName = outs.find((n) => /conf/i.test(n)) ?? outs[1] ?? outs[0];
    this.pitchName = outs.find((n) => n !== this.confName) ?? outs[0];
  }

  /** Self-scheduling so a slow inference just lowers the rate instead of piling
   *  up: run, then wait out the rest of the frame interval. */
  private loop = (): void => {
    if (!this.running) return;
    const started = performance.now();
    void this.tick().finally(() => {
      if (!this.running) return;
      const rest = 1000 / TARGET_FPS - (performance.now() - started);
      this.timer = setTimeout(this.loop, Math.max(0, rest));
    });
  };

  private async tick(): Promise<void> {
    const { analyser, timeBuf, session, ort } = this;
    if (analyser == null || timeBuf == null || session == null || ort == null) return;
    analyser.getFloatTimeDomainData(timeBuf);
    const audio = resampleTo16k(timeBuf, this.srcSampleRate);
    const tensor = new ort.Tensor('float32', audio, [1, audio.length]);
    const out = await session.run({ [this.inputName]: tensor });
    if (!this.running) return;
    const hz = out[this.pitchName].data as Float32Array;
    const conf = out[this.confName].data as Float32Array;
    const i = hz.length - 1;
    const frame = i >= 0 ? frameFromHz(hz[i], conf[i]) : { midi: null, confidence: 0 };
    for (const l of this.listeners) l(frame);
  }
}

/** Linear-interpolation resample of a mono buffer to 16 kHz. Anti-aliasing is
 *  unnecessary here: vocal f0 sits well below the 8 kHz target Nyquist. */
function resampleTo16k(src: Float32Array, srcRate: number): Float32Array {
  if (srcRate === SR_TARGET) return src.slice();
  const ratio = srcRate / SR_TARGET;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    const a = src[j];
    const b = j + 1 < src.length ? src[j + 1] : a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
