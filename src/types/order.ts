import type { Song } from './song.js';

export interface OrderUser {
  uid: number;
  uname: string;
}

export type OrderSource = 'danmu' | 'idle' | 'manual';

export interface OrderItem extends OrderUser {
  orderId: string;
  song: Song;
  requestedAt: number;
  source: OrderSource;
}
