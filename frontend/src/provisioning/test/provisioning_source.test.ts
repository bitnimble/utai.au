import { afterEach, expect, test } from 'bun:test';
import { HttpProvisioningSource } from '../provisioning_source';
import { ProvisionStatus } from '../provisioning_store';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(respond: () => Response): void {
  globalThis.fetch = (async (_input: RequestInfo | URL, _init?: RequestInit) => respond()) as typeof fetch;
}

function nextStatus(start: (onStatus: (status: ProvisionStatus) => void) => () => void): Promise<ProvisionStatus> {
  return new Promise((resolve) => {
    const dispose = start((status) => {
      dispose();
      resolve(status);
    });
  });
}

test('a download the backend refuses reports an error', async () => {
  stubFetch(() => new Response(null, { status: 500 }));
  const status = await nextStatus((onStatus) => new HttpProvisioningSource().download(onStatus));
  expect(status.state).toBe('error');
});

test('watching reports the backend status', async () => {
  stubFetch(() =>
    Response.json({
      state: 'available',
      assets: [{ name: 'a.onnx', phase: 'missing', bytesTotal: 10 }],
    }),
  );
  const status = await nextStatus((onStatus) => new HttpProvisioningSource().watch(onStatus));
  expect(status).toEqual({
    state: 'available',
    error: undefined,
    assets: [{ name: 'a.onnx', phase: 'missing', bytesDone: undefined, bytesTotal: 10 }],
  });
});
