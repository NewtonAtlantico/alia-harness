import type { AliaApi } from '../shared/ipc';

declare global {
  interface Window {
    alia: AliaApi;
  }
}

export {};
