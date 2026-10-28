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

test('check records the newer releases for the running version', async () => {
  const { store, presenter } = setup({});
  store.current = '0.1.0';
  await presenter.check();
  expect(store.latest).toEqual(NOTE);
  expect(store.checkedAt).not.toBeNull();
  expect(store.error).toBeNull();
});

test('install reports download progress, then waits for the relaunch', async () => {
  const { store, presenter } = setup({
    install: async (onProgress) => {
      onProgress({ downloaded: 50, total: 100 });
      expect(store.install).toBe('downloading');
      expect(store.downloadFraction).toBe(0.5);
      onProgress({ downloaded: 100, total: 100 });
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
});
