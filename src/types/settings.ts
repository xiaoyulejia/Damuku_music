export type OverlayTheme = 'light' | 'dark';
export type LyricsDisplayMode = 'scroll' | 'wrap';

export interface OrderSettings {
  userMaxOrder: number;
  globalMaxOrder: number;
  orderMaxDuration: number;
  overLimitSkip: number;
  userHistory: string[];
  songHistory: string[];
  userBlackList: string[];
  songBlackList: string[];
}

export interface DisplaySettings {
  overlayOpacity: number;
  overlayBlur: number;
  overlayTheme: OverlayTheme;
  liveShowPlayer: boolean;
  liveShowControls: boolean;
  liveShowQueueHeader: boolean;
  liveShowRequester: boolean;
  liveShowAlerts: boolean;
  lyricsEnabled: boolean;
  lyricsTranslation: boolean;
  lyricsDisplayMode: LyricsDisplayMode;
  lyricsOffsetMs: number;
  lyricsFontSize: number;
  lyricsColor: string;
  lyricsOpacity: number;
  lyricsOverlayLines: number;
  lyricsOverlayWidth: number;
  progressSeekEnabled: boolean;
  multiSceneHandoffEnabled: boolean;
  multiSceneAutoSwitchEnabled: boolean;
  multiSceneHeartbeatThresholdMs: number;
  customOverlayCss: string;
}

export interface LoginSettings {
  platform: string;
  songListId: string;
  songListHistory: string[];
  neteaseLoginStatus: unknown;
}

export interface Settings {
  schemaVersion: number;
  order: OrderSettings;
  display: DisplaySettings;
  login: LoginSettings | null;
  updatedAt: number;
  revision: number;
}

export type SettingsPatch = {
  schemaVersion?: number;
  order?: Partial<OrderSettings>;
  display?: Partial<DisplaySettings>;
  login?: Partial<LoginSettings> | null;
};
