import { nativeAudioEngine } from 'src/editing/playback/player';
import type { LivePitchSource } from './live_pitch_source';
import { OnnxLivePitchSource } from './onnx_live_pitch_source';
import { SidecarLivePitchSource } from './sidecar_live_pitch_source';

/** Pick the live-pitch backend for this platform: desktop streams the native mic
 *  capture to the Python sidecar's RMVPE (`audio_pitch_subscribe` → LivePitchStream,
 *  octave-robust + matches the offline reference); web + Android run SwiftF0
 *  in-browser via onnxruntime-web. */
export function createLivePitchSource(): LivePitchSource {
  return nativeAudioEngine != null
    ? new SidecarLivePitchSource(nativeAudioEngine)
    : new OnnxLivePitchSource();
}
