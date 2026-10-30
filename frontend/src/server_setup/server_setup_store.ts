import { makeAutoObservable } from 'mobx';

export class ServerSetupStore {
  url: string;
  connecting = false;
  error: string | undefined = undefined;

  constructor(url: string) {
    this.url = url;
    makeAutoObservable(this);
  }
}
