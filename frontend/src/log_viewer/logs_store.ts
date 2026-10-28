import { makeAutoObservable } from 'mobx';

export type LogSource = 'interface' | 'backend';

export class LogsStore {
  source: LogSource = 'interface';
  /** null while loading. */
  lines: readonly string[] | null = null;
  error: string | null = null;

  constructor(readonly sources: readonly LogSource[]) {
    makeAutoObservable(this, { sources: false });
  }

  get text(): string {
    return this.lines?.join('\n') ?? '';
  }
}
