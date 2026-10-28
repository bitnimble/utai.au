import { beforeEach, describe, expect, test } from 'bun:test';
import { toastStore } from 'src/ui/toasts/toasts';
import {
  PROVISIONING_ERROR_TOAST_TEST_ID,
  PROVISIONING_TOAST_TEST_ID,
  ProvisioningPresenter,
} from '../provisioning_presenter';
import { ProvisioningStore, ProvisionStatus } from '../provisioning_store';
import { ProvisioningSource } from '../provisioning_source';

type OnStatus = (s: ProvisionStatus) => void;

/** A source the test drives by hand: it records which of watch/download is live
 *  so the test can push statuses into it, and whether it was disposed. */
class FakeSource implements ProvisioningSource {
  onStatus: OnStatus | undefined;
  live: 'watch' | 'download' | undefined;
  disposed = false;
  watch(onStatus: OnStatus): () => void {
    return this.open('watch', onStatus);
  }
  download(onStatus: OnStatus): () => void {
    return this.open('download', onStatus);
  }
  push(s: ProvisionStatus): void {
    this.onStatus?.(s);
  }
  private open(kind: 'watch' | 'download', onStatus: OnStatus): () => void {
    this.onStatus = onStatus;
    this.live = kind;
    this.disposed = false;
    return () => {
      this.disposed = true;
    };
  }
}

function setup(): { store: ProvisioningStore; presenter: ProvisioningPresenter; source: FakeSource } {
  const store = new ProvisioningStore();
  const source = new FakeSource();
  const presenter = new ProvisioningPresenter(store, source);
  presenter.start();
  return { store, presenter, source };
}

const toast = (testId: string) => toastStore.toasts.find((t) => t.testId === testId);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const AVAILABLE: ProvisionStatus = {
  state: 'available',
  assets: [
    { name: 'sep.onnx', phase: 'outdated', bytesTotal: 300 * 1024 * 1024 },
    { name: 'f0.onnx', phase: 'current', bytesTotal: 1024 },
  ],
};

describe('ProvisioningPresenter', () => {
  beforeEach(() => {
    for (const t of [...toastStore.toasts]) toastStore.dismiss(t.id);
  });

  test('an up-to-date launch (checking -> ready fast) never shows a toast', async () => {
    const { source } = setup();
    source.push({ state: 'checking', assets: [] });
    source.push({ state: 'ready', assets: [] });
    await sleep(700);
    expect(toastStore.toasts).toEqual([]);
    expect(source.disposed).toBe(true);
  });

  test('a slow check shows a toast, as a toast rather than anything blocking', async () => {
    const { source } = setup();
    source.push({ state: 'checking', assets: [] });
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeUndefined();
    await sleep(700);
    expect(toast(PROVISIONING_TOAST_TEST_ID)?.kind).toBe('info');
  });

  test('available models wait for the user instead of downloading', () => {
    const { store, source } = setup();
    source.push(AVAILABLE);
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeDefined();
    expect(source.live).toBe('watch');
    expect(store.pending.map((a) => a.name)).toEqual(['sep.onnx']);
    expect(store.anyMissing).toBe(false);
    expect(store.pendingBytes).toBe(300 * 1024 * 1024);
  });

  test('download fetches, then reports success', () => {
    const { presenter, source } = setup();
    source.push(AVAILABLE);
    presenter.download();
    expect(source.live).toBe('download');
    source.push({ state: 'downloading', assets: [{ name: 'sep.onnx', phase: 'downloading', bytesDone: 1, bytesTotal: 2 }] });
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeDefined();
    source.push({ state: 'ready', assets: [] });
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeUndefined();
    expect(toastStore.toasts.map((t) => t.kind)).toEqual(['success']);
  });

  test('a toast the user dismissed stays hidden until the state changes', () => {
    const { presenter, source } = setup();
    source.push(AVAILABLE);
    presenter.download();
    const downloading: ProvisionStatus = { state: 'downloading', assets: [] };
    source.push(downloading);
    toastStore.dismiss(toast(PROVISIONING_TOAST_TEST_ID)!.id);
    source.push(downloading);
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeUndefined();
    source.push({ state: 'ready', assets: [] });
    expect(toastStore.toasts.map((t) => t.kind)).toEqual(['success']);
  });

  test('later dismisses the prompt without downloading', () => {
    const { presenter, source } = setup();
    source.push(AVAILABLE);
    presenter.later();
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeUndefined();
    expect(source.live).toBe('watch');
    expect(source.disposed).toBe(true);
  });

  test('an error replaces the toast with an error toast, and retry checks again', () => {
    const { store, presenter, source } = setup();
    source.push(AVAILABLE);
    source.push({ state: 'error', error: 'boom', assets: [] });
    expect(toast(PROVISIONING_TOAST_TEST_ID)).toBeUndefined();
    expect(toast(PROVISIONING_ERROR_TOAST_TEST_ID)?.kind).toBe('error');
    expect(store.errorMessage).toBe('boom');

    presenter.retry();
    expect(toast(PROVISIONING_ERROR_TOAST_TEST_ID)).toBeUndefined();
    expect(store.status).toBeUndefined();
    expect(source.live).toBe('watch');
    expect(source.disposed).toBe(false);
  });

  test('aggregates download fraction across sized assets', () => {
    const { store, source } = setup();
    source.push({
      state: 'downloading',
      assets: [
        { name: 'a', phase: 'done', bytesDone: 100, bytesTotal: 100 },
        { name: 'b', phase: 'downloading', bytesDone: 50, bytesTotal: 100 },
        { name: 'c', phase: 'checking' }, // unsized -> excluded
      ],
    });
    expect(store.downloadFraction).toBeCloseTo(150 / 200, 5);
    expect(store.currentDownload?.name).toBe('b');
  });
});
