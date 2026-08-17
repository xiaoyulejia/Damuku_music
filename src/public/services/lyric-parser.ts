import type { LyricLine, LyricResult, MusicPlatform, SongId } from '../../types/song.js';

interface ParsedEntry extends LyricLine {
  sourceIndex: number;
  timestampIndex: number;
}

export interface LyricMeta {
  songId?: SongId;
  romanization?: string;
  instrumental?: boolean;
  noLyrics?: boolean;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseTimestamp(value: unknown): number | null {
  const match = String(value ?? '').trim().match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) return null;
  const fraction = (match[3] ?? '').padEnd(3, '0');
  return Math.max(0, minutes * 60_000 + seconds * 1_000 + Number(fraction || 0));
}

export function parseLrc(text: unknown): LyricLine[] {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  let offsetMs = 0;
  const entries: ParsedEntry[] = [];
  source.split(/\r?\n/).forEach((line, lineIndex) => {
    const offsetMatch = line.match(/^\[offset\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\]/i);
    if (offsetMatch) {
      offsetMs = toFiniteNumber(offsetMatch[1], 0);
      return;
    }
    const timestamps: number[] = [];
    line.replace(/\[(\d+:\d{1,2}(?:\.\d{1,3})?)\]/g, (_full, timestamp: string) => {
      const parsed = parseTimestamp(timestamp);
      if (parsed != null) timestamps.push(parsed);
      return '';
    });
    if (!timestamps.length) return;
    const lyricText = line.replace(/^\s*(?:\[\d+:\d{1,2}(?:\.\d{1,3})?\]\s*)+/, '').trim();
    timestamps.forEach((timestamp, timestampIndex) => {
      entries.push({
        timeMs: Math.max(0, Math.round(timestamp + offsetMs)),
        endMs: Infinity,
        text: lyricText,
        translation: '',
        sourceIndex: lineIndex,
        timestampIndex
      });
    });
  });

  entries.sort((a, b) => a.timeMs - b.timeMs || a.sourceIndex - b.sourceIndex || a.timestampIndex - b.timestampIndex);
  return entries.map((entry, index, list) => ({
    timeMs: entry.timeMs,
    endMs: list[index + 1]?.timeMs ?? Infinity,
    text: entry.text,
    translation: ''
  }));
}

export function mergeTranslation(original: LyricLine[], translation: unknown, toleranceMs = 250): LyricLine[] {
  const lines = Array.isArray(original) ? original.map(line => ({ ...line })) : [];
  const translated = parseLrc(translation);
  if (!translated.length) return lines;
  lines.forEach(line => {
    let bestText: string | null = null;
    let bestDistance = toleranceMs + 1;
    translated.forEach(candidate => {
      const distance = Math.abs(candidate.timeMs - line.timeMs);
      if (distance <= toleranceMs && distance < bestDistance) {
        bestText = candidate.text;
        bestDistance = distance;
      }
    });
    if (bestText != null) line.translation = bestText;
  });
  return lines;
}

export function findLineIndex(lines: LyricLine[], timeMs: unknown): number {
  if (!Array.isArray(lines) || !lines.length) return -1;
  const target = Math.max(0, toFiniteNumber(timeMs, 0));
  let low = 0;
  let high = lines.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (Number(lines[middle]?.timeMs) <= target) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return -1;
  return target < Number(lines[candidate]?.endMs ?? Infinity) ? candidate : candidate;
}

export function normalizeLyrics(original: unknown, translation: unknown = '', meta: LyricMeta = {}): LyricResult {
  const lines = parseLrc(original);
  return {
    platform: 'wy' as MusicPlatform,
    songId: String(meta.songId ?? ''),
    original: String(original ?? ''),
    translation: String(translation ?? ''),
    romanization: String(meta.romanization ?? ''),
    instrumental: Boolean(meta.instrumental),
    noLyrics: Boolean(meta.noLyrics || (!lines.length && !meta.instrumental)),
    lines: mergeTranslation(lines, translation)
  };
}
