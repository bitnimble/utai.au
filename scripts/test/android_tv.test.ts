import { expect, test } from 'bun:test';
import { mainActivity, patchManifest } from '../android-tv';

test('MainActivity tags the user agent and hands Back to the page', () => {
  const activity = mainActivity('au.utai.app');
  expect(activity).toStartWith('package au.utai.app\n');
  expect(activity).toContain('userAgentString + " UtaiTV"');
  expect(activity).toContain('webView.evaluateJavascript("window.utaiBack?.() === true")');
});

const TEMPLATE = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:icon="@mipmap/ic_launcher">
        <activity android:name=".MainActivity">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`;

test('adds the TV features, launcher and banner once', () => {
  const patched = patchManifest(TEMPLATE);
  expect(patched).toBe(`<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.INTERNET" />

    <uses-feature android:name="android.software.leanback" android:required="false" />
    <uses-feature android:name="android.hardware.touchscreen" android:required="false" />

    <application
        android:banner="@drawable/tv_banner"
        android:icon="@mipmap/ic_launcher">
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
