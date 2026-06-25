import { describe, expect, it } from 'vitest';
import {
  getMatchingBlocks,
  alignChars,
  v2ToTranscript,
} from '../src/lynscripe/align';
import {
  parseTranscriptTemplate,
  applyCorrections,
  countPlaceholders,
} from '../src/lynscripe/template';
import type { TranscriptWord } from '../src/types';

describe('getMatchingBlocks (difflib port)', () => {
  it('matches identical sequences as one full block', () => {
    const blocks = getMatchingBlocks([...'abcdef'], [...'abcdef']);
    expect(blocks).toEqual([{ a: 0, b: 0, size: 6 }]);
  });

  it('splits around a deletion in b', () => {
    // a = "abcXYZdef", b = "abcdef" → two blocks: abc and def.
    const blocks = getMatchingBlocks([...'abcXYZdef'], [...'abcdef']);
    expect(blocks).toEqual([
      { a: 0, b: 0, size: 3 },
      { a: 6, b: 3, size: 3 },
    ]);
  });

  it('handles no common chars', () => {
    expect(getMatchingBlocks([...'abc'], [...'xyz'])).toEqual([]);
  });
});

describe('alignChars', () => {
  it('gives cleaned V2 chars the timing of their whisper counterparts', () => {
    // whisper heard a filler 嗯 the model cleaned out.
    const fw: TranscriptWord[] = [
      { w: '你好', start: 0, end: 2 },
      { w: '嗯', start: 2, end: 3 },
      { w: '世界', start: 3, end: 5 },
    ];
    const timed = alignChars('你好世界', fw);
    expect(timed.map((c) => c.ch).join('')).toBe('你好世界');
    expect(timed[0].start).toBeCloseTo(0); // 你
    expect(timed[1].start).toBeCloseTo(1); // 好
    expect(timed[2].start).toBeCloseTo(3); // 世 — jumps past the dropped 嗯
    expect(timed[3].end).toBeCloseTo(5); // 界
  });

  it('forward-fills unmatched chars from the previous timestamp', () => {
    const fw: TranscriptWord[] = [{ w: '你好', start: 0, end: 2 }];
    // V2 has an extra char with no acoustic counterpart.
    const timed = alignChars('你好x', fw);
    expect(timed[2].start).toBeCloseTo(timed[1].end); // x inherits 好's end
  });

  it('returns NaN-free output even with no whisper words', () => {
    const timed = alignChars('你好', []);
    expect(timed.every((c) => Number.isNaN(c.start))).toBe(true);
  });
});

describe('v2ToTranscript', () => {
  it('maps each V2 line to a segment with aligned times', () => {
    const fw: TranscriptWord[] = [
      { w: '你好', start: 0, end: 2 },
      { w: '世界', start: 2, end: 4 },
    ];
    const t = v2ToTranscript('你好\n世界', fw, { language: 'zh' });
    expect(t.engine).toBe('lynscripe');
    expect(t.segments).toHaveLength(2);
    expect(t.segments[0].text).toBe('你好');
    expect(t.segments[0].start).toBeCloseTo(0);
    expect(t.segments[0].end).toBeCloseTo(2);
    expect(t.segments[1].text).toBe('世界');
    expect(t.segments[1].start).toBeCloseTo(2);
    expect(t.segments[1].end).toBeCloseTo(4);
    // per-char words attached
    expect(t.segments[0].words.map((w) => w.w).join('')).toBe('你好');
  });

  it('drops blank lines and guarantees positive segment duration', () => {
    const fw: TranscriptWord[] = [{ w: '一二', start: 1, end: 1 }]; // zero-dur word
    const t = v2ToTranscript('一二\n\n  \n', fw);
    expect(t.segments).toHaveLength(1);
    expect(t.segments[0].end).toBeGreaterThan(t.segments[0].start);
  });
});

describe('parseTranscriptTemplate', () => {
  it('parses template + uncertain terms (snake_case keys)', () => {
    const raw = JSON.stringify({
      transcript_template: '我在{{T1}}园\n又看到{{T1}}',
      uncertain_terms: [
        { id: 'T1', heard: '康桃', guess: '康头', context: '我在康头园', occurrences: 2, category: 'term' },
      ],
    });
    const tpl = parseTranscriptTemplate(raw, 'gemini-test');
    expect(tpl.transcriptTemplate).toContain('{{T1}}');
    expect(tpl.uncertainTerms).toHaveLength(1);
    expect(tpl.uncertainTerms[0].category).toBe('term');
    expect(tpl.model).toBe('gemini-test');
  });

  it('tolerates fences + coerces bad category + dedupes ids', () => {
    const raw =
      '```json\n' +
      JSON.stringify({
        transcript_template: 'x{{T1}}',
        uncertain_terms: [
          { id: 'T1', heard: 'a', guess: 'b', category: 'bogus' },
          { id: 'T1', heard: 'dup', guess: 'dup' },
        ],
      }) +
      '\n```';
    const tpl = parseTranscriptTemplate(raw);
    expect(tpl.uncertainTerms).toHaveLength(1); // dup id dropped
    expect(tpl.uncertainTerms[0].category).toBe('other'); // bogus → other
  });

  it('throws when transcript text is missing', () => {
    expect(() => parseTranscriptTemplate(JSON.stringify({ uncertain_terms: [] }))).toThrow();
  });
});

describe('v2ToTranscript degenerate-cue spreading', () => {
  it('spreads unanchored cue runs across the neighbour gap (no chars/sec blowup)', () => {
    // whisper anchors 你好 @0-1s and 世界 @5-6s; the two English lines between
    // them never match → without repair they collapse onto a single instant.
    const fw: TranscriptWord[] = [
      { w: '你', start: 0, end: 0.5 },
      { w: '好', start: 0.5, end: 1 },
      { w: '世', start: 5, end: 5.5 },
      { w: '界', start: 5.5, end: 6 },
    ];
    const t = v2ToTranscript('你好\nOK\nbut\n世界', fw);
    expect(t.segments.length).toBe(4);
    // No cue collapsed to ~0 duration.
    for (const s of t.segments) expect(s.end - s.start).toBeGreaterThan(0.03);
    // The two unanchored cues are spread inside the (1s, 5s) gap, in order.
    const [, ok, but] = t.segments;
    expect(ok.start).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(but.start).toBeGreaterThan(ok.start);
    expect(but.end).toBeLessThanOrEqual(5 + 1e-6);
  });
});

describe('applyCorrections (zero-error placeholder replace)', () => {
  const tpl = {
    transcriptTemplate: '我在{{T1}}园里看{{T1}}和{{T2}}',
    uncertainTerms: [
      { id: 'T1', heard: '康桃', guess: '康头', context: '', occurrences: 2, category: 'term' as const },
      { id: 'T2', heard: 'ptptn', guess: 'PTPTN', context: '', occurrences: 1, category: 'abbr' as const },
    ],
  };

  it('replaces every occurrence with the user correction, no substring mangling', () => {
    const out = applyCorrections(tpl, { T1: '康头', T2: 'PTPTN' });
    // The "园" after {{T1}} must stay intact (naive replace would have risked it).
    expect(out).toBe('我在康头园里看康头和PTPTN');
  });

  it('falls back to guess when no correction given', () => {
    const out = applyCorrections(tpl, {});
    expect(out).toBe('我在康头园里看康头和PTPTN'); // guesses 康头 / PTPTN
  });

  it('counts placeholders correctly', () => {
    expect(countPlaceholders(tpl.transcriptTemplate)).toEqual({ T1: 2, T2: 1 });
  });

  it('strips subtitle punctuation but keeps line breaks (no-punctuation convention)', () => {
    const punctTpl = {
      transcriptTemplate: '人有興趣聽的。\nOK,啊。\n那就是{{T1}}的第三個眼。',
      uncertainTerms: [
        { id: 'T1', heard: '二郎神', guess: '二郎神', context: '', occurrences: 1, category: 'person' as const },
      ],
    };
    const out = applyCorrections(punctTpl, { T1: '二郎神' });
    expect(out).toBe('人有興趣聽的\nOK啊\n那就是二郎神的第三個眼');
    expect(out).not.toMatch(/[。，？！,.]/);
  });
});
