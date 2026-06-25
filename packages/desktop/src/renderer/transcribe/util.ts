import type { UncertainTerm } from '../core-browser';

export const CAT_LABEL: Record<UncertainTerm['category'], string> = {
  person: '人名',
  brand: '品牌',
  place: '地名',
  org: '机构',
  term: '术语',
  abbr: '缩写',
  other: '其他',
};

export function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export function stem(p: string): string {
  return baseName(p).replace(/\.[^.]+$/, '');
}

/** Aegisub-style timecode H:MM:SS.cc (centiseconds), matching the user's ref. */
export function fmtTimecode(sec: number): string {
  const t = Math.max(0, sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cc = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
}

/** Characters-per-second (CJK counts as 1 char). Returns null for a degenerate
 *  (near-zero) duration, where CPS is meaningless — caller shows '—'. */
export function charsPerSecond(text: string, durSec: number): number | null {
  if (durSec < 0.05) return null;
  const chars = [...text.replace(/\s+/g, '')].length;
  return Math.round(chars / durSec);
}

/** The custom-protocol URL the renderer's <audio>/<video> reads for a local
 *  path (same scheme as the project video — a generic ranged file server). */
export function mediaUrl(absPath: string): string {
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

/** Parse a timecode (H:MM:SS.cc / MM:SS.cc / plain seconds) → seconds, or null. */
export function parseTimecode(tc: string): number | null {
  const s = tc.trim();
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(s);
  if (!m) {
    const plain = Number(s);
    return Number.isFinite(plain) ? plain : null;
  }
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const frac = m[4] ? Number((m[4] + '000').slice(0, 3)) / 1000 : 0;
  return h * 3600 + min * 60 + sec + frac;
}

/** Build a single regex matching any of the corrected term spellings (longest
 *  first so longer terms win). Null if there's nothing to highlight. */
export function buildTermRegex(values: string[]): RegExp | null {
  const uniq = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  if (uniq.length === 0) return null;
  const escaped = uniq
    .sort((a, b) => b.length - a.length)
    .map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(${escaped.join('|')})`, 'g');
}
