import type { OrderItem } from './order.js';
import type { OrderSettings, LoginSettings } from './settings.js';
import type { LyricLine, Song } from './song.js';

export type RoomId = string;
export type PlayerStatus = string;
export type StateRevision = number;

export interface PlaybackState {
  songKey: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  seeking: boolean;
  readyState: number;
  sampledAt: number;
}

export interface PublisherInfo {
  publisherId: string | null;
  instanceId: string;
  generation: number;
  leaseToken: string;
  status: 'active' | 'released' | string;
  heartbeatAt: number;
}

export interface PublisherLease extends PublisherInfo {
  startedAt?: number;
}

export interface RoomLyricsState {
  songKey: string;
  status: string;
  revision: number;
  contentHash: string;
  updatedAt: number;
  lines?: LyricLine[];
}

export interface RoomState {
  queue: OrderItem[];
  currentSong: Song | null;
  currentRequester: string;
  status: PlayerStatus;
  volume: number;
  playback: PlaybackState;
  lyrics: RoomLyricsState;
  idleSongList: OrderItem[];
  idleIndex: number;
  stateRevision: StateRevision;
  queueRevision: number;
  publisher: PublisherInfo;
  publisherId: string | null;
  publisherGeneration: number;
  publisherLeaseToken: string;
  publisherInstanceId: string;
  settings: { order: OrderSettings; login: LoginSettings | null };
  [key: string]: unknown;
}

export type SyncCommandType =
  | 'loadSongList' | 'addOrder' | 'next' | 'play' | 'volume' | 'settings'
  | 'pause' | 'toggle' | 'unlockAudio' | 'promoteNext' | 'reorderQueue'
  | 'removeOrder' | 'seek';

export type SyncCommand = {
  id?: string;
  command: SyncCommandType;
  value?: unknown;
  publisherId?: string;
  generation?: number;
  leaseToken?: string;
};

export interface SyncStateResponse<T> {
  code: number;
  data: T;
  message?: string;
  reason?: string;
}
