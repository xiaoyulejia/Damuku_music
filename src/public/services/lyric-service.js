import musicServer from './musicServers/music-server.js?v=20260812-18';
import { findLineIndex, mergeTranslation, normalizeLyrics, parseLrc } from './lyric-parser.mjs';

const lyricCache = new Map();
const VALID_TTL = 24 * 60 * 60 * 1000;
const EMPTY_TTL = 60 * 60 * 1000;

class LyricService {
    key(song) {
        return song?.sid == null ? '' : `${song.platform || 'wy'}:${song.sid}`;
    }

    async load(song, { signal } = {}) {
        if (!song?.sid || song.platform !== 'wy') {
            return { status: 'unsupported', lines: [], noLyrics: false };
        }
        const key = this.key(song);
        const cached = lyricCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached.value;
        try {
            const value = await musicServer.getServer('wy').getLyrics(song.sid, { signal });
            const normalized = value?.instrumental
                ? { ...value, lines: [], status: 'instrumental' }
                : value?.noLyrics || !value?.lines?.length
                    ? { ...value, lines: [], status: 'empty' }
                    : { ...value, status: 'ready' };
            lyricCache.set(key, {
                fetchedAt: Date.now(),
                ttl: normalized.status === 'ready' ? VALID_TTL : EMPTY_TTL,
                value: normalized
            });
            return normalized;
        } catch (error) {
            if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') throw error;
            return { status: 'error', lines: [], error };
        }
    }

    parseLrc(text) { return parseLrc(text); }
    mergeTranslation(original, translation, toleranceMs = 250) {
        return mergeTranslation(original, translation, toleranceMs);
    }
    findLineIndex(lines, timeMs) { return findLineIndex(lines, timeMs); }
    clearMemoryCache() { lyricCache.clear(); }
}

export { LyricService, parseLrc, mergeTranslation, findLineIndex, normalizeLyrics };
export default new LyricService();
