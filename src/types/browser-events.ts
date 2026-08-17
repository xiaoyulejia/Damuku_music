import type { RoomState, SyncCommand } from './sync.js';

export interface BrowserEventDetailMap {
  'damuku:room-state': { roomId: string; state: RoomState };
  'damuku:sync-command': { roomId: string; command: SyncCommand };
}

declare global {
  interface Window {
    API_CONFIG?: {
      BASE_PATH?: string;
      bili_api?: string;
      netease_api?: string;
      qqmusic_api?: string;
    };
    __DAMUKU_PRODUCT_VERSION?: string;
    __DAMUKU_FRONTEND_BUILD_ID?: string;
  }

  interface DocumentEventMap {
    'damuku:room-state': CustomEvent<BrowserEventDetailMap['damuku:room-state']>;
    'damuku:sync-command': CustomEvent<BrowserEventDetailMap['damuku:sync-command']>;
  }
}

export {};
