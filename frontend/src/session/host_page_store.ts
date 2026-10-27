import { makeAutoObservable, observable } from 'mobx';
import type { HostSession } from './session_client';

export type HostPageState =
  | { kind: 'loading' }
  /** `host` is undefined when remotes can't join, so this device plays on its own. */
  | { kind: 'ready'; host: HostSession | undefined }
  | { kind: 'missing' }
  /** Another browser created the session, so only it can host. */
  | { kind: 'hostedElsewhere'; sessionId: string };

export class HostPageStore {
  state: HostPageState = { kind: 'loading' };

  constructor() {
    makeAutoObservable(this, { state: observable.ref });
  }
}
