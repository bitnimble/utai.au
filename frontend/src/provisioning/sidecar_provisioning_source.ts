import { Channel, invoke } from '@tauri-apps/api/core';
import { ProvisionAsset, ProvisionState, ProvisionStatus } from './provisioning_store';
import type { ProvisioningSource } from './provisioning_source';

/** One frame from the Rust `check_models` / `download_models` commands: a
 *  per-asset tick, or the terminal done/error. Mirrors `app.pipeline.provision`'s
 *  `--check` / `--progress-json` lines, parsed by the broker. */
type ProvisionEvent =
  | { type: 'progress'; asset: string; phase: string; bytesDone: number | null; bytesTotal: number | null }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Desktop provisioning: `watch` runs the Rust `check_models` command (which syncs
 * the venv if needed, then reports each model as missing, outdated or current)
 * and ends `available` or `ready`; `download` runs `download_models`, ending
 * `ready`. There is no separator-warm phase here (the sidecar loads models per job).
 */
export class SidecarProvisioningSource implements ProvisioningSource {
  watch(onStatus: (status: ProvisionStatus) => void): () => void {
    return stream('check_models', onStatus, (assets) =>
      assets.some((a) => a.phase === 'missing' || a.phase === 'outdated') ? 'available' : 'ready',
    );
  }

  download(onStatus: (status: ProvisionStatus) => void): () => void {
    return stream('download_models', onStatus, () => 'ready');
  }
}

function stream(
  command: string,
  onStatus: (status: ProvisionStatus) => void,
  finalState: (assets: ProvisionAsset[]) => ProvisionState,
): () => void {
  let stopped = false;
  const assets = new Map<string, ProvisionAsset>();
  let state: ProvisionState = 'checking';

  const emit = (error?: string): void => {
    if (stopped) return;
    onStatus({ state, error, assets: Array.from(assets.values()) });
  };

  const channel = new Channel<ProvisionEvent>();
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
      state = finalState(Array.from(assets.values()));
      emit();
    } else {
      state = 'error';
      emit(ev.message);
    }
  };

  void invoke(command, { onEvent: channel }).catch((err: unknown) => {
    if (stopped) return;
    state = 'error';
    emit(err instanceof Error ? err.message : String(err));
  });

  return () => {
    stopped = true;
  };
}
