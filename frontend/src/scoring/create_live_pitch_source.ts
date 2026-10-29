import { nativeAudioOutput } from 'src/editing/playback/player';
import type { LivePitchSource } from './live_pitch_source';
import { RmvpeLivePitchSource } from './rmvpe_live_pitch_source';
import { SwiftF0LivePitchSource } from './swiftf0_live_pitch_source';

/** RMVPE on desktop, which has the Python sidecar to run it; SwiftF0 in-browser
 *  on web + Android. */
export function createLivePitchSource(): LivePitchSource {
  return nativeAudioOutput != null ? new RmvpeLivePitchSource(nativeAudioOutput) : new SwiftF0LivePitchSource();
}
