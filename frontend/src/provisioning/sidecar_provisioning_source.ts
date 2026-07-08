import { Channel, invoke } from '@tauri-apps/api/core';
import { ProvisionAsset, ProvisionState, ProvisionStatus } from './provisioning_store';
import type { ProvisioningSource } from './provisioning_source';

/** One frame from the Rust `ensure_models` command: a per-asset progress tick,
 *  or the terminal done/error. Mirrors `app.pipeline.provision --progress-json`
 *  parsed by the broker. */
type EnsureModelsEvent =
  | { type: 'progress'; asset: string; phase: string; bytesDone: number | null; bytesTotal: number | null }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Desktop provisioning watcher: drives the Rust `ensure_models` command (which
 * syncs the venv if needed, then runs `provision --progress-json` for the
 * startup capability set) and accumulates its per-asset frames into a
 * {@link ProvisionStatus}. There is no separator-warm phase here (the sidecar
 * loads models per job), so the terminal is `ready`.
 */
export class SidecarProvisioningSource implements ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void {
    let stopped = false;
    const assets = new Map<string, ProvisionAsset>();
    let state: ProvisionState = 'checking';

    const emit = (error?: string): void => {
      if (stopped) return;
      onStatus({ state, error, assets: Array.from(assets.values()) });
    };

    const channel = new Channel<EnsureModelsEvent>();
    channel.onmessage = (ev): void => {
      if (stopped) return;
      if (ev.type === 'progress') {
        assets.set(ev.asset, {
          name: ev.asset,
          phase: ev.phase,
          bytesDone: ev.bytesDone ?? undefined,
          bytesTotal: ev.bytesTotal ?? undefined,
        });
        if (ev.phase === 'downloading') state = 'downloading';
        emit();
      } else if (ev.type === 'done') {
        state = 'ready';
        emit();
      } else {
        state = 'error';
        emit(ev.message);
      }
    };

    void invoke('ensure_models', { onEvent: channel }).catch((err: unknown) => {
      if (stopped) return;
      state = 'error';
      onStatus({ state, error: err instanceof Error ? err.message : String(err), assets: [] });
    });

    return () => {
      stopped = true;
    };
  }
}
