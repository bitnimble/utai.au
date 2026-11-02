import { resolveBackendUrl } from 'src/net/backend_fetch';
import type { JobAudio } from 'src/net/job_audio';
import { appSettingsStore } from 'src/settings/app_settings_presenter';
import { BYTES_PER_FRAME, type PcmStem } from './pcm';
import type { SongPcmRequest, SongPcmResponse } from './song_pcm_worker';

/** One stem of an open song: what a player, a stretcher or the waveform reads it through. */
export type StemPcm = PcmStem & {
  sampleRate: number;
  /** A stream of the stem for one consumer; see `PcmStream`. */
  attach(): MessagePort;
  /** The song's worker goes once all its stems have been released. */
  release(): void;
};

export type OpenedSongPcm = {
  /** In the order of the audio asked for; undefined where it couldn't be read. */
  stems: Array<StemPcm | undefined>;
  failures: string[];
  loudnessGain: number;
};

const CONTENT_RANGE_TOTAL = /\/(\d+)$/;
const ENCODE_CHUNK_FRAMES = 1 << 16;
const DURATION_PROBE_RATE = 48_000;

/** Ready to play: each stem's length known, its opening read and the song's loudness measured. */
export async function openSongPcm(audio: readonly JobAudio[], sampleRate: number): Promise<OpenedSongPcm> {
  const failures: string[] = [];
  const stems: Array<PcmStem | undefined> = [];
  // One at a time: a local file's decode is the one step here that holds a whole song.
  for (const item of audio) {
    try {
      stems.push(await pcmStemOf(item, sampleRate));
    } catch (err) {
      stems.push(undefined);
      failures.push(`Could not load ${audioFilename(item)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const readable = stems.filter((stem) => stem != null);
  const worker = new Worker(new URL('./song_pcm_worker.ts', import.meta.url), { type: 'module' });
  const opened = await new Promise<SongPcmResponse>((resolve) => {
    worker.onmessage = (e: MessageEvent<SongPcmResponse>) => resolve(e.data);
    worker.onerror = (err) => resolve({ kind: 'failed', message: err.message });
    worker.postMessage({ kind: 'open', stems: readable, sampleRate } satisfies SongPcmRequest);
  });
  if (opened.kind === 'failed') {
    failures.push(`Could not read the song: ${opened.message}`);
    worker.terminate();
    return { stems: stems.map(() => undefined), failures, loudnessGain: 1 };
  }

  let open = readable.length;
  if (open === 0) worker.terminate();
  let index = 0;
  return {
    failures,
    loudnessGain: opened.loudnessGain,
    stems: stems.map((stem) => {
      if (stem == null) return undefined;
      const workerIndex = index++;
      let released = false;
      return {
        ...stem,
        sampleRate,
        attach: () => {
          const { port1, port2 } = new MessageChannel();
          worker.postMessage({ kind: 'attach', stem: workerIndex, port: port2 } satisfies SongPcmRequest, [port2]);
          return port1;
        },
        release: () => {
          if (released) return;
          released = true;
          if (--open === 0) worker.terminate();
        },
      };
    }),
  };
}

export function audioFilename(audio: JobAudio): string {
  return 'file' in audio ? audio.file.name : audio.filename;
}

/** The encoded file, for saving it or handing it to a job. */
export async function encodedAudio(audio: JobAudio): Promise<Blob> {
  if ('file' in audio) return audio.file;
  const url = await resolveBackendUrl(`${appSettingsStore.apiBase}/${audio.downloadPath}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${audio.filename} download answered ${res.status}`);
  return res.blob();
}

export async function audioDurationSec(audio: JobAudio): Promise<number> {
  if (audio.serverPath != null) {
    return (await backendPcmStem(audio.serverPath, DURATION_PROBE_RATE)).frames / DURATION_PROBE_RATE;
  }
  const file = audioFile(audio);
  try {
    const decoder = new OfflineAudioContext(1, 1, DURATION_PROBE_RATE);
    return (await decoder.decodeAudioData(await file.arrayBuffer())).duration;
  } catch (err) {
    throw new Error(`Could not decode ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function pcmStemOf(audio: JobAudio, sampleRate: number): Promise<PcmStem> {
  if (audio.serverPath == null) return decodedPcmStem(audioFile(audio), sampleRate);
  try {
    return await backendPcmStem(audio.serverPath, sampleRate);
  } catch (err) {
    if (!('file' in audio)) throw err;
    console.warn('[pcm] backend has no PCM for this; decoding it here:', err);
    return decodedPcmStem(audio.file, sampleRate);
  }
}

function audioFile(audio: JobAudio): File {
  if (!('file' in audio)) throw new Error(`${audio.filename} is neither on the backend nor local`);
  return audio.file;
}

async function backendPcmStem(serverPath: string, sampleRate: number): Promise<PcmStem> {
  const query = new URLSearchParams({ path: serverPath, rate: String(sampleRate) });
  const url = new URL(
    await resolveBackendUrl(`${appSettingsStore.apiBase}/music/pcm?${query.toString()}`),
    window.location.href,
  ).href;
  // The first request is the one that makes the PCM.
  const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
  if (res.status !== 206) throw new Error(`PCM answered ${res.status}`);
  const total = CONTENT_RANGE_TOTAL.exec(res.headers.get('content-range') ?? '')?.[1];
  if (total == null) throw new Error('PCM answered no length');
  return { origin: { kind: 'url', url }, frames: Number(total) / BYTES_PER_FRAME };
}

async function decodedPcmStem(file: File, sampleRate: number): Promise<PcmStem> {
  const decoder = new OfflineAudioContext(2, 1, sampleRate);
  const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
  const left = new Float32Array(ENCODE_CHUNK_FRAMES);
  const right = new Float32Array(ENCODE_CHUNK_FRAMES);
  const parts: Int16Array<ArrayBuffer>[] = [];
  for (let frame = 0; frame < buffer.length; frame += ENCODE_CHUNK_FRAMES) {
    const frames = Math.min(ENCODE_CHUNK_FRAMES, buffer.length - frame);
    buffer.copyFromChannel(left, 0, frame);
    buffer.copyFromChannel(right, buffer.numberOfChannels > 1 ? 1 : 0, frame);
    const samples = new Int16Array(frames * 2);
    for (let i = 0; i < frames; i++) {
      samples[i * 2] = toInt16(left[i]);
      samples[i * 2 + 1] = toInt16(right[i]);
    }
    parts.push(samples);
  }
  return { origin: { kind: 'blob', blob: new Blob(parts) }, frames: buffer.length };
}

function toInt16(sample: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(sample * 32768)));
}
