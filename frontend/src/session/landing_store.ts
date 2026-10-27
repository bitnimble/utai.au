import { makeAutoObservable } from 'mobx';
import { normalizeSessionCode } from './app_route';

export class LandingStore {
  code = '';
  busy: 'create' | 'join' | undefined = undefined;
  error: string | undefined = undefined;

  constructor() {
    makeAutoObservable(this);
  }

  get normalizedCode(): string {
    return normalizeSessionCode(this.code);
  }
}
