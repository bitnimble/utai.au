import { expect, test } from 'bun:test';
import { mainActivity, patchManifest } from '../android-tv';

test('MainActivity tags the user agent and hands Back to the page', () => {
  const activity = mainActivity('au.utai.app');
  expect(activity).toStartWith('package au.utai.app\n');
  expect(activity).toContain('userAgentString + " UtaiTV"');
  expect(activity).toContain('webView.evaluateJavascript("window.utaiBack?.() === true")');
});

test('MainActivity forwards media buttons to the page by key name', () => {
  const activity = mainActivity('au.utai.app');
  expect(activity).toContain('KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "MediaPlayPause",');
  expect(activity).toContain('KeyEvent.KEYCODE_MEDIA_NEXT to "MediaTrackNext",');
  expect(activity).toContain(
    'webView.evaluateJavascript("window.utaiKey?.(\'$key\', ${event.repeatCount > 0})", null)',
  );
});

const TEMPLATE = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:icon="@mipmap/ic_launcher"
        android:usesCleartextTraffic="\${usesCleartextTraffic}">
        <activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

test('adds the TV features, launcher and banner once, and allows a plain-http server', () => {
  const patched = patchManifest(TEMPLATE);
  expect(patched).toBe(`<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:banner="@drawable/tv_banner"
        android:icon="@mipmap/ic_launcher"
        android:usesCleartextTraffic="true">
        <activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
                <category android:name="android.intent.category.LEANBACK_LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);
  expect(patchManifest(patched)).toBe(patched);
});

test('fails loudly when the template no longer has the cleartext placeholder', () => {
  const changed = TEMPLATE.replace('\n        android:usesCleartextTraffic="${usesCleartextTraffic}"', '');
  expect(() => patchManifest(changed)).toThrow('usesCleartextTraffic');
});
