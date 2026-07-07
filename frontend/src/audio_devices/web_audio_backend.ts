import { UtaiPlayer, utaiPlayer } from 'src/editing/playback/player';
import {
  NONE_DEVICE_ID,
  type AudioDevice,
  type AudioIoBackend,
  type MicPermission,
  type MonitorOptions,
} from './audio_io_backend';

/**
 * Web Audio implementation of {@link AudioIoBackend}: `getUserMedia` for
 * capture, a `MediaStreamAudioSourceNode → gain → master bus` monitor path
 * (metered off an `AnalyserNode` tapped pre-gain, so muting still shows level),
 * the player's master gain for output volume, and `AudioContext.setSinkId` for
 * output routing. The monitor attaches to the player's shared context + master
 * bus so one sink choice routes the track and the monitor together.
 */
export class WebAudioBackend implements AudioIoBackend {
  readonly outputSelectable = UtaiPlayer.outputSinkSupported;

  private stream: MediaStream | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private gainNode: GainNode | undefined;
  private analyser: AnalyserNode | undefined;
  private levelBuf: Float32Array<ArrayBuffer> | undefined;
  private rafId: number | undefined;

  async enumerate(): Promise<AudioDevice[]> {
    const md = navigator.mediaDevices;
    if (md?.enumerateDevices == null) return [];
    const devices = await md.enumerateDevices();
    const result: AudioDevice[] = [];
    for (const d of devices) {
      if (d.kind === 'audioinput') result.push({ id: d.deviceId, label: d.label, kind: 'input' });
      else if (d.kind === 'audiooutput') result.push({ id: d.deviceId, label: d.label, kind: 'output' });
    }
    return result;
  }

  onDevicesChanged(cb: () => void): () => void {
    const md = navigator.mediaDevices;
    if (md == null) return () => {};
    md.addEventListener('devicechange', cb);
    return () => md.removeEventListener('devicechange', cb);
  }

  async requestPermission(): Promise<MicPermission> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only wanted the grant (+ device labels); the monitor opens its own
      // stream on the chosen device.
      for (const t of stream.getTracks()) t.stop();
      return 'granted';
    } catch (err) {
      return err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'prompt';
    }
  }

  async queryPermission(): Promise<MicPermission> {
    const perms = navigator.permissions;
    if (perms?.query == null) return 'unknown';
    try {
      // 'microphone' is a valid PermissionName in browsers but absent from
      // TS's lib.dom union, hence the cast.
      const status = await perms.query({ name: 'microphone' as PermissionName });
      return status.state;
    } catch {
      return 'unknown';
    }
  }

  async startMonitor({ inputId, gain, onLevel }: MonitorOptions): Promise<void> {
    this.stopMonitor();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: inputId ? { exact: inputId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    const ctx = utaiPlayer.getAudioContext();
    // Best-effort: without a prior user gesture resume() rejects; the graph is
    // built regardless and becomes audible once the context resumes (on play).
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const gainNode = ctx.createGain();
    gainNode.gain.value = gain;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    source.connect(gainNode);
    gainNode.connect(utaiPlayer.getOutputNode());

    this.stream = stream;
    this.source = source;
    this.gainNode = gainNode;
    this.analyser = analyser;
    this.levelBuf = new Float32Array(analyser.fftSize);
    this.runLevelLoop(onLevel);
  }

  setMicGain(gain: number): void {
    if (this.gainNode != null) this.gainNode.gain.value = gain;
  }

  setOutputVolume(volume: number): void {
    utaiPlayer.setOutputVolume(volume);
  }

  stopMonitor(): void {
    if (this.rafId !== undefined) {
      cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
    this.source?.disconnect();
    this.gainNode?.disconnect();
    this.analyser?.disconnect();
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = undefined;
    this.source = undefined;
    this.gainNode = undefined;
    this.analyser = undefined;
    this.levelBuf = undefined;
  }

  async setOutputSink(outputId: string): Promise<void> {
    if (!this.outputSelectable) return;
    await utaiPlayer.setOutputSink(outputId === NONE_DEVICE_ID ? { type: 'none' } : outputId);
  }

  private runLevelLoop(onLevel: (level: number) => void): void {
    const tick = (): void => {
      const analyser = this.analyser;
      const buf = this.levelBuf;
      if (analyser == null || buf == null) {
        this.rafId = undefined;
        return;
      }
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      // ×2 headroom so ordinary singing fills most of the meter.
      onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 2));
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }
}
