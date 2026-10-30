// Fits the generated Android project (src-tauri/gen/android, which `tauri android init` writes and
// git ignores) for Android TV: a launcher banner, no touchscreen required, and a MainActivity that
// tells the page it is on a TV and hands the remote's Back and media buttons to it. scripts/tauri-build.ts
// runs it after `android init` and before every other android command; it is idempotent.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TV_AGENT, TV_BACK, TV_KEY } from '../frontend/src/tv_remote/tv';

const MAIN = join(import.meta.dir, '..', 'src-tauri', 'gen', 'android', 'app', 'src', 'main');

const LEANBACK = '<uses-feature android:name="android.software.leanback" android:required="false" />';
const TOUCHSCREEN = '<uses-feature android:name="android.hardware.touchscreen" android:required="false" />';
const LAUNCHER = '<category android:name="android.intent.category.LAUNCHER" />';
const TV_LAUNCHER = '<category android:name="android.intent.category.LEANBACK_LAUNCHER" />';
const BANNER = 'android:banner="@drawable/tv_banner"';

const BANNER_DRAWABLE = `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item>
        <shape android:shape="rectangle">
            <solid android:color="#1a1814" />
            <size android:width="320dp" android:height="180dp" />
        </shape>
    </item>
    <item android:drawable="@mipmap/ic_launcher_foreground" android:gravity="center" android:width="180dp" android:height="180dp" />
</layer-list>
`;

const MEDIA_KEYS = [
  ['KEYCODE_MEDIA_PLAY_PAUSE', 'MediaPlayPause'],
  ['KEYCODE_MEDIA_PLAY', 'MediaPlay'],
  ['KEYCODE_MEDIA_PAUSE', 'MediaPause'],
  ['KEYCODE_MEDIA_STOP', 'MediaStop'],
  ['KEYCODE_MEDIA_NEXT', 'MediaTrackNext'],
  ['KEYCODE_MEDIA_PREVIOUS', 'MediaTrackPrevious'],
  ['KEYCODE_MEDIA_FAST_FORWARD', 'MediaFastForward'],
  ['KEYCODE_MEDIA_REWIND', 'MediaRewind'],
  ['KEYCODE_MEDIA_SKIP_FORWARD', 'MediaFastForward'],
  ['KEYCODE_MEDIA_SKIP_BACKWARD', 'MediaRewind'],
] as const;

export function mainActivity(packageName: string): string {
  return `package ${packageName}

import android.app.UiModeManager
import android.content.res.Configuration
import android.os.Bundle
import android.view.KeyEvent
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private val onTv by lazy {
    getSystemService(UiModeManager::class.java).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION
  }
  private var tvWebView: WebView? = null
  private val mediaKeys = mapOf(
${MEDIA_KEYS.map(([code, key]) => `    KeyEvent.${code} to "${key}",`).join('\n')}
  )

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Ahead of the WebView, which doesn't reliably pass media keys on to the page.
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val key = mediaKeys[event.keyCode]
    val webView = tvWebView
    if (key == null || webView == null) return super.dispatchKeyEvent(event)
    if (event.action == KeyEvent.ACTION_DOWN) {
      webView.evaluateJavascript("window.${TV_KEY}?.('\$key', \${event.repeatCount > 0})", null)
    }
    return true
  }

  override fun onWebViewCreate(webView: WebView) {
    if (!onTv) return
    tvWebView = webView
    webView.settings.userAgentString = webView.settings.userAgentString + " ${TV_AGENT}"
    // D-pad keys go to the focused view.
    webView.requestFocus()
    // Here, not in onCreate: Tauri adds its own Back callback (webView.goBack()) after onCreate,
    // and the newest callback runs first.
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        webView.evaluateJavascript("window.${TV_BACK}?.() === true") { handled ->
          if (handled != "true") moveTaskToBack(true)
        }
      }
    })
  }
}
`;
}

export function patchManifest(manifest: string): string {
  let out = manifest;
  if (!out.includes(LEANBACK)) out = insert(out, '<application', 'before', `${LEANBACK}\n    `);
  if (!out.includes(TOUCHSCREEN)) out = insert(out, '<application', 'before', `${TOUCHSCREEN}\n\n    `);
  if (!out.includes(TV_LAUNCHER)) out = insert(out, LAUNCHER, 'after', `\n                ${TV_LAUNCHER}`);
  if (!out.includes(BANNER)) out = insert(out, '<application', 'after', `\n        ${BANNER}`);
  return out;
}

function insert(text: string, anchor: string, side: 'before' | 'after', addition: string): string {
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error(`[android-tv] AndroidManifest.xml has no ${anchor}: the Tauri template changed`);
  const index = side === 'before' ? at : at + anchor.length;
  return text.slice(0, index) + addition + text.slice(index);
}

export function patchAndroidProject(): void {
  if (!existsSync(MAIN)) throw new Error('[android-tv] no generated Android project: run `bun run android:init`');
  const manifestPath = join(MAIN, 'AndroidManifest.xml');
  writeFileSync(manifestPath, patchManifest(readFileSync(manifestPath, 'utf8')));

  const drawables = join(MAIN, 'res', 'drawable');
  mkdirSync(drawables, { recursive: true });
  writeFileSync(join(drawables, 'tv_banner.xml'), BANNER_DRAWABLE);

  const identifier: string = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
  ).identifier;
  const activity = join(MAIN, 'java', ...identifier.split('.'), 'MainActivity.kt');
  if (!existsSync(activity)) throw new Error(`[android-tv] no ${activity}: the Tauri template changed`);
  writeFileSync(activity, mainActivity(identifier));
}
