import { makeAutoObservable } from 'mobx';
import { hostPath, remotePath } from './app_route';
import type { LandingStore } from './landing_store';
import { createSession, findSession } from './session_client';

export class LandingPresenter {
  constructor(
    private readonly store: LandingStore,
    private readonly apiBase: () => string,
    private readonly navigate: (path: string) => void,
  ) {
    makeAutoObservable<this, 'store' | 'apiBase' | 'navigate'>(this, {
      store: false,
      apiBase: false,
      navigate: false,
    });
  }

  setCode(code: string): void {
    this.store.code = code.toUpperCase();
  }

  async create(): Promise<void> {
    await this.run('create', async () => hostPath((await createSession(this.apiBase())).info.id));
  }

  async join(): Promise<void> {
    const code = this.store.normalizedCode;
    if (code.length === 0) return;
    await this.run('join', async () => {
      const session = await findSession(this.apiBase(), code);
      if (session == null) throw new Error('No session with that code. Check it, or ask the host for a new one.');
      return remotePath(session.id);
    });
  }

  private async run(kind: 'create' | 'join', destination: () => Promise<string>): Promise<void> {
    this.setOutcome(kind, undefined);
    try {
      this.navigate(await destination());
    } catch (err) {
      this.setOutcome(undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private setOutcome(busy: LandingStore['busy'], error: string | undefined): void {
    this.store.busy = busy;
    this.store.error = error;
  }
}
