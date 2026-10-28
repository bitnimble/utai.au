import { expect, test } from 'bun:test';
import type { ReleaseNote } from '../releases';
import { UpdatesPresenter, type UpdateShell } from '../updates_presenter';
import { UpdatesStore } from '../updates_store';

const NOTE: ReleaseNote = {
  version: '0.2.0',
  notes: '### New\n\n- Queue songs',
  url: 'https://github.com/bitnimble/utai.au/releases/tag/v0.2.0',
  apkUrl: 'https://github.com/bitnimble/utai.au/releases/download/v0.2.0/utai.au_0.2.0_android-arm64.apk',
};

function setup(shell: Partial<UpdateShell>, newer: ReleaseNote[] = [NOTE]) {
  const opened: string[] = [];
  const store = new UpdatesStore();
  const presenter = new UpdatesPresenter(
    store,
    {
      isAndroid: false,
      version: async () => '0.1.0',
      canInstall: async () => true,
      install: async () => {},
      open: async (url) => {
        opened.push(url);
      },
      ...shell,
    },
    async () => newer,
  );
  return { store, presenter, opened };
}

test('start reads the version and whether it can install, then checks', async () => {
  const { store, presenter } = setup({ version: async () => '0.1.5', canInstall: async () => false });
  await presenter.start();
  expect(store.current).toBe('0.1.5');
  expect(store.canInstall).toBe(false);
  expect(store.latest).toEqual(NOTE);
});

test('start says so when the version cannot be read, and checks nothing', async () => {
  const { store, presenter } = setup({
    version: async () => {
      throw new Error('no shell');
    },
  });
  await presenter.start();
  expect(store.current).toBeNull();
  expect(store.checkedAt).toBeNull();
  expect(store.error).toBe("Couldn't read this app's version: no shell");
});

test('check records the newer releases for the running version', async () => {
  const { store, presenter } = setup({});
  store.current = '0.1.0';
  await presenter.check();
  expect(store.latest).toEqual(NOTE);
  expect(store.checkedAt).not.toBeNull();
  expect(store.error).toBeNull();
});

test('a failed check says why and keeps the releases it knew', async () => {
  const store = new UpdatesStore();
  const presenter = new UpdatesPresenter(
    store,
    { isAndroid: false, version: async () => '0.1.0', canInstall: async () => true, install: async () => {}, open: async () => {} },
    async () => {
      throw new Error('GitHub answered 403');
    },
  );
  store.current = '0.1.0';
  store.newer = [NOTE];
  await presenter.check();
  expect(store.error).toBe("Couldn't check for updates: GitHub answered 403");
  expect(store.latest).toEqual(NOTE);
  expect(store.checking).toBe(false);
  expect(store.checkedAt).not.toBeNull();
});

test('install reports download progress, then waits for the relaunch', async () => {
  const { store, presenter } = setup({
    install: async (onProgress) => {
      onProgress({ downloaded: 50, total: 100, done: false });
      expect(store.install).toBe('downloading');
      expect(store.downloadFraction).toBe(0.5);
      onProgress({ downloaded: 100, total: null, done: true });
    },
  });
  store.newer = [NOTE];
  store.canInstall = true;
  await presenter.install();
  expect(store.install).toBe('restarting');
});

test('a failed install says why and can be retried', async () => {
  const { store, presenter } = setup({
    install: async () => {
      throw new Error('signature mismatch');
    },
  });
  store.newer = [NOTE];
  store.canInstall = true;
  await presenter.install();
  expect(store.install).toBe('idle');
  expect(store.error).toBe("Couldn't install the update: signature mismatch");
});

test('an install that cannot be replaced opens the download instead', async () => {
  const desktop = setup({});
  desktop.store.newer = [NOTE];
  await desktop.presenter.install();
  expect(desktop.opened).toEqual([NOTE.url]);

  const android = setup({ isAndroid: true });
  android.store.newer = [NOTE];
  await android.presenter.install();
  expect(android.opened).toEqual([NOTE.apkUrl!]);

  const noApk = setup({ isAndroid: true });
  noApk.store.newer = [{ ...NOTE, apkUrl: null }];
  await noApk.presenter.install();
  expect(noApk.opened).toEqual([NOTE.url]);
});

test('a link that fails to open says so', async () => {
  const { store, presenter } = setup({
    open: async () => {
      throw new Error('no browser');
    },
  });
  await presenter.openUrl('https://utai.au');
  expect(store.error).toBe("Couldn't open https://utai.au: no browser");
});
