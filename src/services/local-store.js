const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = {
    schemaVersion: 1,
    order: {
        userMaxOrder: 3,
        globalMaxOrder: 15,
        orderMaxDuration: 0,
        overLimitSkip: 0,
        userHistory: [],
        songHistory: [],
        userBlackList: [],
        songBlackList: []
    },
    display: {
        overlayOpacity: 88,
        overlayBlur: 14,
        overlayTheme: 'dark',
        liveShowPlayer: false,
        liveShowControls: false,
        liveShowQueueHeader: true,
        liveShowRequester: true,
        liveShowAlerts: false,
        lyricsEnabled: true,
        lyricsTranslation: true,
        lyricsOffsetMs: 0,
        lyricsFontSize: 22,
        lyricsColor: '#ffffff',
        lyricsOpacity: 100,
        lyricsOverlayLines: 1,
        progressSeekEnabled: true,
        customOverlayCss: ''
    },
    login: null,
    updatedAt: 0,
    revision: 0
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function safeName(value) {
    return String(value || 'default').replace(/[^0-9a-z_-]/gi, '_').slice(0, 120) || 'default';
}

function mergeSettings(input = {}) {
    const result = clone(DEFAULT_SETTINGS);
    const order = input.order || {};
    const display = input.display || {};
    const numeric = (value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) => {
        const n = Number(value);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
    };
    result.order.userMaxOrder = numeric(order.userMaxOrder, result.order.userMaxOrder, 1, 1000);
    result.order.globalMaxOrder = numeric(order.globalMaxOrder, result.order.globalMaxOrder, 1, 10000);
    result.order.orderMaxDuration = numeric(order.orderMaxDuration, 0, 0, 86400);
    result.order.overLimitSkip = numeric(order.overLimitSkip, 0, 0, 86400);
    for (const key of ['userHistory', 'songHistory', 'userBlackList', 'songBlackList']) {
        result.order[key] = Array.isArray(order[key]) ? order[key].slice(-100) : [];
    }
    result.display.overlayOpacity = numeric(display.overlayOpacity, 88, 20, 100);
    result.display.overlayBlur = numeric(display.overlayBlur, 14, 0, 50);
    result.display.overlayTheme = display.overlayTheme === 'light' ? 'light' : 'dark';
    for (const key of ['liveShowPlayer', 'liveShowControls', 'liveShowQueueHeader', 'liveShowRequester', 'liveShowAlerts']) {
        result.display[key] = Boolean(display[key] ?? result.display[key]);
    }
    for (const key of ['lyricsEnabled', 'lyricsTranslation', 'progressSeekEnabled']) {
        result.display[key] = Boolean(display[key] ?? result.display[key]);
    }
    result.display.lyricsOffsetMs = numeric(display.lyricsOffsetMs, 0, -5000, 5000);
    result.display.lyricsFontSize = numeric(display.lyricsFontSize, 22, 12, 64);
    result.display.lyricsColor = /^#[0-9a-f]{6}$/i.test(String(display.lyricsColor || '')) ? String(display.lyricsColor) : '#ffffff';
    result.display.lyricsOpacity = numeric(display.lyricsOpacity, 100, 10, 100);
    result.display.lyricsOverlayLines = numeric(display.lyricsOverlayLines, 1, 0, 3);
    result.display.customOverlayCss = typeof display.customOverlayCss === 'string' ? display.customOverlayCss.slice(0, 20000) : '';
    result.login = input.login && typeof input.login === 'object'
        ? {
            platform: String(input.login.platform || ''),
            songListId: String(input.login.songListId || ''),
            songListHistory: Array.isArray(input.login.songListHistory) ? input.login.songListHistory.slice(-100) : [],
            neteaseLoginStatus: input.login.neteaseLoginStatus || null
        }
        : null;
    result.schemaVersion = 1;
    result.updatedAt = Number(input.updatedAt) || 0;
    result.revision = Number(input.revision) || 0;
    return result;
}

class LocalStore {
    constructor(rootDir = path.resolve(__dirname, '../..')) {
        this.rootDir = rootDir;
        this.dataDir = path.join(rootDir, 'data');
        this.settingsDir = path.join(this.dataDir, 'settings');
        this.roomsDir = path.join(this.settingsDir, 'rooms');
        this.historyDir = path.join(this.dataDir, 'history');
        this.credentialsDir = path.join(this.dataDir, 'credentials');
        this.cacheDir = path.join(rootDir, 'cache', 'order-sync');
        for (const dir of [this.settingsDir, this.roomsDir, this.historyDir, this.credentialsDir, this.cacheDir]) ensureDir(dir);
    }

    read(filePath, fallback) {
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch (error) {
            if (fs.existsSync(filePath)) {
                const corrupt = `${filePath}.corrupt-${Date.now()}`;
                try { fs.renameSync(filePath, corrupt); } catch (_) { /* best effort */ }
            }
            return fallback;
        }
    }

    write(filePath, value) {
        ensureDir(path.dirname(filePath));
        const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(value, null, 2), 'utf8');
        fs.renameSync(tempPath, filePath);
    }

    settingsPath(roomId = null) {
        return roomId == null
            ? path.join(this.settingsDir, 'global.json')
            : path.join(this.roomsDir, `${safeName(roomId)}.json`);
    }

    getSettings(roomId = null) {
        const stored = this.read(this.settingsPath(roomId), {});
        const history = this.read(path.join(this.historyDir, 'order-history.json'), {});
        return mergeSettings({
            ...stored,
            order: { ...(stored.order || {}), ...(roomId == null ? history : {}) }
        });
    }

    updateSettings(roomId, patch, expectedRevision = null) {
        const current = this.getSettings(roomId);
        if (expectedRevision != null && Number(expectedRevision) !== current.revision) {
            return { ok: false, conflict: true, settings: current };
        }
        const next = mergeSettings({
            ...current,
            ...patch,
            order: { ...current.order, ...(patch?.order || {}) },
            display: { ...current.display, ...(patch?.display || {}) },
            login: patch?.login || current.login,
            revision: current.revision + 1,
            updatedAt: Date.now()
        });
        next.revision = current.revision + 1;
        next.updatedAt = Date.now();
        this.write(this.settingsPath(roomId), next);
        const history = {};
        for (const key of ['userHistory', 'songHistory', 'userBlackList', 'songBlackList']) {
            history[key] = next.order[key];
        }
        this.write(path.join(this.historyDir, 'order-history.json'), {
            schemaVersion: 1,
            updatedAt: Date.now(),
            ...history
        });
        return { ok: true, conflict: false, settings: next };
    }

    credentialPath(name = 'netease-cookie.dat') {
        return path.join(this.credentialsDir, name);
    }

    saveNeteaseCookie(cookie) {
        if (typeof cookie !== 'string' || !cookie.trim()) return false;
        // Cookie 不写入 settings、日志或运行缓存。后续可替换为 Windows DPAPI 加密实现。
        this.write(this.credentialPath(), { schemaVersion: 1, updatedAt: Date.now(), cookie });
        try { fs.chmodSync(this.credentialPath(), 0o600); } catch (_) { /* Windows may ignore chmod */ }
        return true;
    }

    getNeteaseCookie() {
        return this.read(this.credentialPath(), {})?.cookie || null;
    }

    hasNeteaseCookie() {
        return Boolean(this.getNeteaseCookie());
    }

    clearNeteaseCookie() {
        const target = this.credentialPath();
        if (fs.existsSync(target)) fs.unlinkSync(target);
    }
}

module.exports = { LocalStore, DEFAULT_SETTINGS, mergeSettings };
