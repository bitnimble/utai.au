import { isTauri } from '@tauri-apps/api/core';
import { NativeAudioOutput } from './native_audio_output';
import { PlaybackEngine } from './playback_engine';
import { WebAudioOutput } from './web_audio_output';

export const webAudioOutput = new WebAudioOutput();

/** The Rust/cpal engine on the desktop app, else `undefined` (web + Android use
 *  Web Audio). Call `.init()` once mounted. */
export const nativeAudioOutput = isTauri() && !__IS_MOBILE__ ? new NativeAudioOutput() : undefined;

export const playbackEngine = new PlaybackEngine(nativeAudioOutput ?? webAudioOutput);
