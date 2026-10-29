import { isTauri } from '@tauri-apps/api/core';

/** True on the Tauri desktop build, which runs the backend itself on loopback
 *  (`src-tauri/src/local_backend.rs`). False on web and on Android (Tauri, but
 *  no Python: it uses a remote backend). */
export function hasLocalBackend(): boolean {
  return isTauri() && !__IS_MOBILE__;
}
