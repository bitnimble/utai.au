import { makeAutoObservable } from 'mobx';
import { toastStore } from 'src/ui/toasts/toasts';
import type { HostPageState, HostPageStore } from './host_page_store';
import { createSession, findSession, recallHostToken } from './session_client';

export type HostTarget =
  | { kind: 'existing'; sessionId: string; apiBase: string }
  | { kind: 'device'; apiBase: () => Promise<string> };

export class HostPagePresenter {
  constructor(
    private readonly store: HostPageStore,
    private readonly target: HostTarget,
  ) {
    makeAutoObservable<this, 'store' | 'target'>(this, { store: false, target: false });
  }

  async start(): Promise<void> {
    const { target } = this;
    if (target.kind === 'existing') {
      this.setState(await this.resolveExisting(target.apiBase, target.sessionId));
      return;
    }
    // Plays straight away; its own backend may take a while to start, and phones can join once it has.
    this.setState({ kind: 'ready', host: undefined });
    try {
      this.setState({ kind: 'ready', host: await createSession(await target.apiBase()) });
    } catch (err) {
      toastStore.showWarning(`Phones can't join as remotes: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async resolveExisting(apiBase: string, sessionId: string): Promise<HostPageState> {
    try {
      const info = await findSession(apiBase, sessionId);
      if (info == null) return { kind: 'missing' };
      const hostToken = recallHostToken(info.id);
      if (hostToken == null) return { kind: 'hostedElsewhere', sessionId: info.id };
      return { kind: 'ready', host: { info, apiBase, hostToken } };
    } catch {
      // Unreachable backend (already toasted): still play locally, just without remotes.
      return { kind: 'ready', host: undefined };
    }
  }

  private setState(state: HostPageState): void {
    this.store.state = state;
  }
}
