export type MusicPlatform = 'wy' | 'qq' | (string & {});
export type SongId = string;

export interface Song {
  platform: MusicPlatform;
  sid: SongId;
  sname: string;
  sartist: string;
  duration: number;
  album?: string;
  pic?: string;
  url?: string;
}

export interface LyricLine {
  timeMs: number;
  endMs: number;
  text: string;
  translation: string;
}

export interface LyricResult {
  platform: MusicPlatform;
  songId: SongId;
  original: string;
  translation: string;
  romanization: string;
  instrumental: boolean;
  noLyrics: boolean;
  lines: LyricLine[];
}

export interface MusicServer {
  search(query: string, options?: unknown): Promise<unknown>;
  getSong(songId: SongId, options?: unknown): Promise<Song>;
  getUrl(songId: SongId, options?: unknown): Promise<string>;
  getLyrics(songId: SongId, options?: { signal?: AbortSignal }): Promise<LyricResult>;
}
