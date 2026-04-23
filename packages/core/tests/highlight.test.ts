import { describe, expect, it } from 'vitest';
import {
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  formatTranscriptEffective,
} from '../src/highlight-prompts';
import { parseHighlightResponse } from '../src/highlight-parser';
import type { Transcript } from '../src/types';

function mkTranscript(segments: Array<{ start: number; end: number; text: string }>): Transcript {
  return {
    language: 'zh',
    engine: 'test',
    model: 'test',
    segments: segments.map((s, i) => ({
      id: `seg_${i}`,
      start: s.start,
      end: s.end,
      text: s.text,
      words: [],
    })),
  };
}

describe('formatTranscriptEffective', () => {
  it('lists transcript lines in effective MM:SS.s time', () => {
    const t = mkTranscript([
      { start: 0, end: 5, text: 'hello' },
      { start: 5, end: 10, text: 'world' },
    ]);
    const out = formatTranscriptEffective(t, []);
    expect(out).toContain('[00:00.0 - 00:05.0] hello');
    expect(out).toContain('[00:05.0 - 00:10.0] world');
  });

  it('drops transcript segments fully inside a cut range', () => {
    const t = mkTranscript([
      { start: 0, end: 5, text: 'keep' },
      { start: 10, end: 15, text: 'gone' },   // fully inside cut [10,20]
      { start: 30, end: 35, text: 'keep too' },
    ]);
    const out = formatTranscriptEffective(t, [{ start: 10, end: 20 }]);
    expect(out).toContain('keep');
    expect(out).toContain('keep too');
    expect(out).not.toContain('gone');
  });

  it('shows effective-time range for segments that survive cuts', () => {
    const t = mkTranscript([{ start: 30, end: 35, text: 'after cut' }]);
    const out = formatTranscriptEffective(t, [{ start: 10, end: 20 }]);
    // source 30 -> effective 20; source 35 -> effective 25
    expect(out).toMatch(/\[00:20\.0 - 00:25\.0\] after cut/);
  });
});

describe('buildHighlightUserPrompt', () => {
  it('includes style, count, target seconds and the transcript', () => {
    const t = mkTranscript([{ start: 0, end: 10, text: 'alpha' }]);
    const prompt = buildHighlightUserPrompt({
      transcript: t,
      cutRanges: [],
      effectiveDuration: 120,
      style: 'hero',
      count: 3,
      targetSeconds: 30,
    });
    expect(prompt).toContain('120.0');
    expect(prompt).toContain('目标变体数量: 3');
    expect(prompt).toContain('30 秒');
    expect(prompt).toContain('片头风格');
    expect(prompt).toContain('alpha');
  });
});

describe('buildHighlightSystemPrompt', () => {
  it('demands JSON-only output and forbids prose', () => {
    const sys = buildHighlightSystemPrompt();
    expect(sys).toContain('JSON');
    expect(sys).toContain('不要任何前后解释');
  });
});

describe('parseHighlightResponse', () => {
  it('parses a clean JSON response into variants', () => {
    const raw = JSON.stringify({
      variants: [
        {
          title: 'Hook 变体',
          style: 'hero',
          segments: [
            { start: 0, end: 5, reason: '开场' },
            { start: 20, end: 30, reason: '点题' },
          ],
        },
      ],
    });
    const result = parseHighlightResponse(raw, [], 'claude-test');
    expect(result).toHaveLength(1);
    const v = result[0];
    expect(v.title).toBe('Hook 变体');
    expect(v.style).toBe('hero');
    expect(v.segments).toHaveLength(2);
    expect(v.durationSeconds).toBe(15);
    expect(v.model).toBe('claude-test');
  });

  it('converts effective-time segments back to source time via cutRanges', () => {
    const raw = JSON.stringify({
      variants: [
        {
          title: 'After cut',
          style: 'default',
          segments: [{ start: 15, end: 25, reason: 'x' }],
        },
      ],
    });
    // Cut [10, 20] in source time means effective 15 -> source 25, eff 25 -> src 35
    const result = parseHighlightResponse(raw, [{ start: 10, end: 20 }]);
    expect(result[0].segments[0].start).toBeCloseTo(25);
    expect(result[0].segments[0].end).toBeCloseTo(35);
  });

  it('coerces unknown style to default', () => {
    const raw = JSON.stringify({
      variants: [
        {
          title: 'odd',
          style: 'made-up',
          segments: [{ start: 0, end: 5, reason: 'x' }],
        },
      ],
    });
    expect(parseHighlightResponse(raw, [])[0].style).toBe('default');
  });

  it('extracts JSON from prose-wrapped response', () => {
    const raw = "Sure, here's what I came up with:\n" + JSON.stringify({
      variants: [{ title: 't', style: 'default', segments: [{ start: 0, end: 5, reason: 'x' }] }],
    }) + '\nLet me know what you think!';
    const result = parseHighlightResponse(raw, []);
    expect(result).toHaveLength(1);
  });

  it('drops segments with invalid ranges', () => {
    const raw = JSON.stringify({
      variants: [
        {
          title: 't',
          style: 'default',
          segments: [
            { start: 0, end: 5, reason: 'good' },
            { start: 10, end: 10, reason: 'zero-length' },
            { start: 'bad' as unknown as number, end: 20, reason: 'non-numeric' },
          ],
        },
      ],
    });
    const result = parseHighlightResponse(raw, []);
    expect(result[0].segments).toHaveLength(1);
  });

  it('throws on non-JSON response', () => {
    expect(() => parseHighlightResponse('not a json at all', [])).toThrow(/JSON/);
  });

  it('throws when variants array is missing', () => {
    expect(() => parseHighlightResponse(JSON.stringify({ foo: 'bar' }), [])).toThrow(
      /variants/
    );
  });
});
