import musicServer from './musicServers/music-server.js?v=20260812-22';
import { findLineIndex, mergeTranslation, normalizeLyrics, parseLrc } from './lyric-parser.mjs';

const lyricCache = new Map();
const lyricInflight = new Map();
const PARSER_VERSION = 1;
const VALID_TTL = 24 * 60 * 60 * 1000;
const EMPTY_TTL = 60 * 60 * 1000;

class LyricService {
    key(song) {
        return song?.sid == null ? '' : `${song.platform || 'wy'}:${song.sid}:parser-${PARSER_VERSION}`;
    }

    async load(song, { signal } = {}) {
        if (!song?.sid || song.platform !== 'wy') {
            return { status: 'unsupported', lines: [], noLyrics: false };
        }
        const key = this.key(song);
        const cached = lyricCache.get(key);
        if (cached && Date.now() - cached.fetchedAt < cached.ttl) {
            return {
                ...cached.value,
                lines: Array.isArray(cached.value.lines) ? cached.value.lines.map(line => ({ ...line })) : []
            };
        }
        let request = lyricInflight.get(key);
        if (!request) {
            request = (async () => {
                const value = await musicServer.getServer('wy').getLyrics(song.sid, { signal });
                const normalized = value?.instrumental
                    ? { ...value, lines: [], status: 'instrumental', parserVersion: PARSER_VERSION }
                    : value?.noLyrics || !value?.lines?.length
                        ? { ...value, lines: [], status: 'empty', parserVersion: PARSER_VERSION }
                        : { ...value, status: 'ready', parserVersion: PARSER_VERSION };
                lyricCache.set(key, {
                    fetchedAt: Date.now(),
                    ttl: normalized.status === 'ready' ? VALID_TTL : EMPTY_TTL,
                    value: normalized
                });
                return normalized;
            })().finally(() => lyricInflight.delete(key));
            lyricInflight.set(key, request);
        }
        try {
            const value = await request;
            return { ...value, lines: Array.isArray(value.lines) ? value.lines.map(line => ({ ...line })) : [] };
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
    clearMemoryCache() { lyricCache.clear(); lyricInflight.clear(); }
}

export { LyricService, parseLrc, mergeTranslation, findLineIndex, normalizeLyrics };
export default new LyricService();
