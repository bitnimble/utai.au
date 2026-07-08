import { describe, expect, test } from 'bun:test';
import { ProvisioningPresenter } from '../provisioning_presenter';
import { ProvisioningStore, ProvisionStatus } from '../provisioning_store';
import { ProvisioningSource } from '../provisioning_source';

/** A source the test drives by hand: capture the `onStatus` callback so the test
 *  can push statuses, and record disposal. */
class FakeSource implements ProvisioningSource {
  onStatus: ((s: ProvisionStatus) => void) | undefined;
  disposed = false;
  watch(onStatus: (s: ProvisionStatus) => void): () => void {
    this.onStatus = onStatus;
    this.disposed = false;
    return () => {
      this.disposed = true;
    };
  }
  push(s: ProvisionStatus): void {
    this.onStatus?.(s);
  }
}

function setup(): { store: ProvisioningStore; presenter: ProvisioningPresenter; source: FakeSource } {
  const store = new ProvisioningStore();
  const source = new FakeSource();
  const presenter = new ProvisioningPresenter(store, source);
  presenter.start();
  return { store, presenter, source };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ProvisioningPresenter', () => {
  test('shows the gate immediately while downloading', () => {
    const { store, source } = setup();
    source.push({ state: 'downloading', assets: [{ name: 'm', phase: 'downloading', bytesDone: 1, bytesTotal: 10 }] });
    expect(store.gateVisible).toBe(true);
    expect(store.state).toBe('downloading');
  });

  test('hides the gate and stops watching on ready', () => {
    const { store, source } = setup();
    source.push({ state: 'downloading', assets: [] });
    expect(store.gateVisible).toBe(true);
    source.push({ state: 'ready', assets: [] });
    expect(store.gateVisible).toBe(false);
    expect(source.disposed).toBe(true);
  });

  test('an up-to-date boot (checking -> ready fast) never shows the gate', async () => {
    const { store, source } = setup();
    source.push({ state: 'checking', assets: [] });
    expect(store.gateVisible).toBe(false); // debounced, not shown yet
    source.push({ state: 'ready', assets: [] });
    await sleep(50);
    expect(store.gateVisible).toBe(false); // debounce cleared by ready
  });

  test('a slow check eventually shows the gate', async () => {
    const { store, source } = setup();
    source.push({ state: 'checking', assets: [] });
    expect(store.gateVisible).toBe(false);
    await sleep(700); // past GATE_DEBOUNCE_MS
    expect(store.gateVisible).toBe(true);
  });

  test('error shows the gate with the message and stops watching', () => {
    const { store, source } = setup();
    source.push({ state: 'error', error: 'boom', assets: [] });
    expect(store.gateVisible).toBe(true);
    expect(store.isError).toBe(true);
    expect(store.errorMessage).toBe('boom');
    expect(source.disposed).toBe(true);
  });

  test('retry re-watches from a clean slate', () => {
    const { store, presenter, source } = setup();
    source.push({ state: 'error', error: 'boom', assets: [] });
    expect(source.disposed).toBe(true);
    presenter.retry();
    expect(store.status).toBeUndefined();
    expect(store.gateVisible).toBe(false);
    expect(source.disposed).toBe(false); // watching again
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
