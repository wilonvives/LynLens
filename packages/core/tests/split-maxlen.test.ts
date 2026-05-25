import { describe, expect, it } from 'vitest';
import { mergeIntoUtterances, splitSegmentsToMaxLen } from '../src/transcription';
import type { Transcript, TranscriptWord } from '../src/types';

// Subtitle re-segmentation must be human-readable: break at punctuation and at
// dictionary-word boundaries, never mid-word (投/資, 再/做), and stay within the
// per-orientation char cap. Timing flows from the per-word array.

/** One word per code point with sequential 0.5s timings (mimics whisper tokens). */
const perChar = (text: string): TranscriptWord[] =>
  [...text].map((ch, i) => ({ w: ch, start: i * 0.5, end: i * 0.5 + 0.5 }));

const seg = (text: string, words: TranscriptWord[], lang = 'zh'): Transcript => ({
  language: lang,
  engine: 'whisper-cpp',
  model: 'base',
  segments: [{ id: 'a', start: words[0]?.start ?? 0, end: words.at(-1)?.end ?? 0, text, words }],
});

describe('splitSegmentsToMaxLen — readable re-segmentation', () => {
  it('never splits inside a dictionary word, stays within the cap', () => {
    const text = '不要再做詐騙老倫家的非法詐騙投資'; // 16 chars, no punctuation
    const out = splitSegmentsToMaxLen(seg(text, perChar(text)), 12);
    expect(out.segments.length).toBeGreaterThan(1);
    for (const s of out.segments) expect([...s.text].length).toBeLessThanOrEqual(12);
    // No characters lost or reordered.
    expect(out.segments.map((s) => s.text).join('')).toBe(text);
    // Key words stay whole — this is the whole point.
    expect(out.segments.some((s) => s.text.includes('投資'))).toBe(true);
    expect(out.segments.some((s) => s.text.includes('非法'))).toBe(true);
    expect(out.segments.some((s) => s.text.includes('再做'))).toBe(true);
    // None of these may be split across a line boundary.
    for (const w of ['投資', '非法', '再做', '詐騙']) {
      const splitAcross = out.segments.some(
        (s, i) =>
          i < out.segments.length - 1 &&
          s.text.endsWith(w[0]) &&
          out.segments[i + 1].text.startsWith(w[1])
      );
      expect(splitAcross, `"${w}" must not be split across lines`).toBe(false);
    }
  });

  it('packs a long comma-separated line into balanced ≤cap cards (no tiny orphans)', () => {
    // The cost model prefers fuller, balanced cards broken at comma boundaries
    // over one-tiny-card-per-comma — the professional "don't make lines flash"
    // / "balance lines" principle.
    const text = '他的唐妹,有位民眾,他一直勸他的唐妹,不要再做';
    const out = splitSegmentsToMaxLen(seg(text, perChar(text)), 12);
    expect(out.segments.length).toBeGreaterThan(1);
    for (const s of out.segments) {
      expect([...s.text].length).toBeLessThanOrEqual(12);
      expect(s.text).not.toMatch(/[，,]/); // punctuation stripped from display
    }
    // No characters lost (only the commas are removed).
    expect(out.segments.map((s) => s.text).join('')).toBe('他的唐妹有位民眾他一直勸他的唐妹不要再做');
  });

  it('never orphans a trailing word — breaks earlier to balance instead', () => {
    // Greedy "fill to 12" would produce 詐騙老人家的那個非法詐騙 / 投資 (orphan).
    const text = '詐騙老人家的那個非法詐騙投資';
    const out = splitSegmentsToMaxLen(seg(text, perChar(text)), 12);
    // 投資 must not be alone, and must stay whole.
    expect(out.segments.some((s) => s.text === '投資')).toBe(false);
    expect(out.segments.some((s) => s.text.includes('投資'))).toBe(true);
    for (const s of out.segments) expect([...s.text].length).toBeLessThanOrEqual(12);
    expect(out.segments.map((s) => s.text).join('')).toBe(text);
  });

  it('keeps a short segment as one line (just strips punctuation)', () => {
    const out = splitSegmentsToMaxLen(seg('你好，世界', perChar('你好，世界')), 12);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('你好世界');
  });

  it('timing flows from the words and stays ordered', () => {
    const text = '不要再做詐騙老倫家的非法詐騙投資';
    const out = splitSegmentsToMaxLen(seg(text, perChar(text)), 12);
    expect(out.segments[0].start).toBe(0);
    for (let i = 1; i < out.segments.length; i++) {
      expect(out.segments[i].start).toBeGreaterThanOrEqual(out.segments[i - 1].start);
    }
  });

  it('measures by visual width (中12/英45) — short English stays on one line', () => {
    // 24 Latin chars ≈ width 6.4 ≤ 12 → must NOT be split (it fits a 英45 line).
    const out = splitSegmentsToMaxLen(seg('hello world this is fine', perChar('hello world this is fine'), 'en'), 12);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('hello world this is fine');
  });

  it('splits a genuinely long English line at word boundaries (no broken words)', () => {
    const text = 'this is a fairly long english sentence about balance and investment';
    const out = splitSegmentsToMaxLen(seg(text, perChar(text), 'en'), 12);
    expect(out.segments.length).toBeGreaterThan(1);
    for (const s of out.segments) {
      expect(s.text.length).toBeLessThanOrEqual(45); // 英45 width cap
      expect(s.text).not.toMatch(/\b(balanc|investmen|sentenc)\b/); // whole words only
    }
    expect(out.segments.map((s) => s.text).join(' ')).toBe(text);
  });

  it('keeps mixed CJK+English words/numbers whole (width-aware, the real bug)', () => {
    // Each of these is >12 code points but ≤12 visual width — must stay on ONE
    // line, never splitting an English word, "all in", or a number+unit.
    const cases: Array<[string, string]> = [
      ['連一個signboard都沒有的', 'signboard'],
      ['投資把他們那一邊all in', 'all in'],
      ['我每個月的收入1萬5到2萬', '2萬'],
      ['一定要achieve一個balance', 'balance'],
    ];
    for (const [text, mustStayWhole] of cases) {
      const out = splitSegmentsToMaxLen(seg(text, perChar(text)), 12);
      expect(out.segments, `"${text}" should stay one line`).toHaveLength(1);
      expect(out.segments[0].text).toContain(mustStayWhole);
    }
  });

  it('reunites English split across whisper segments, but leaves CJK boundaries alone', () => {
    const seg2 = (text: string, s: number, e: number): TranscriptWord[] =>
      [...text].map((w, i) => ({ w, start: s + ((e - s) * i) / text.length, end: s + ((e - s) * (i + 1)) / text.length }));
    // English seam (Latin↔Latin, no pause) → merge into "all in".
    const eng: Transcript = {
      language: 'zh', engine: 'whisper-cpp', model: 'base',
      segments: [
        { id: 'a', start: 3, end: 3.3, text: '投資那一邊all', words: seg2('投資那一邊all', 3, 3.3) },
        { id: 'b', start: 3.3, end: 3.6, text: 'in沒有人問', words: seg2('in沒有人問', 3.3, 3.6) },
      ],
    };
    const m = mergeIntoUtterances(eng);
    expect(m.segments).toHaveLength(1);
    expect(m.segments[0].text).toBe('投資那一邊all in沒有人問'); // space inserted at the Latin seam

    // CJK↔CJK boundary → NOT merged (whisper's pause boundary is meaningful).
    const cjk: Transcript = {
      language: 'zh', engine: 'whisper-cpp', model: 'base',
      segments: [
        { id: 'a', start: 4, end: 6, text: '我每个晚上很好睡', words: seg2('我每个晚上很好睡', 4, 6) },
        { id: 'b', start: 6, end: 9, text: '昨天我们谈到一样东西', words: seg2('昨天我们谈到一样东西', 6, 9) },
      ],
    };
    const m2 = mergeIntoUtterances(cjk);
    expect(m2.segments).toHaveLength(2);
    expect(m2.segments[0].text).toBe('我每个晚上很好睡');
  });

  it('is a no-op when maxLen <= 0', () => {
    const text = '很长很长很长很长很长很长很长';
    expect(splitSegmentsToMaxLen(seg(text, perChar(text)), 0).segments).toHaveLength(1);
  });

  it('uses seg.text as the source of truth even if words disagree (no swallowing)', () => {
    // The word array is missing "做" that IS present in seg.text. The output
    // must follow seg.text — rebuilding from tokens is exactly what dropped
    // characters ("做" vanished, "fighting" → "ighting") in the wild.
    const t: Transcript = {
      language: 'zh',
      engine: 'whisper-cpp',
      model: 'base',
      segments: [
        {
          id: 'a',
          start: 0,
          end: 5,
          text: '所以一定要去做一个败人子', // 12 chars, authoritative
          words: [...'所以一定要去一个败人子'].map((w, i) => ({ w, start: i * 0.4, end: i * 0.4 + 0.4 })), // missing 做
        },
      ],
    };
    const out = splitSegmentsToMaxLen(t, 12);
    expect(out.segments.map((s) => s.text).join('')).toBe('所以一定要去做一个败人子');
  });
});
