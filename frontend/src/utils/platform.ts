import { isTauri } from '@tauri-apps/api/core';

/** The Tauri desktop build; false on web and on the Android app. */
export function isDesktopApp(): boolean {
  return isTauri() && !__IS_MOBILE__;
}
