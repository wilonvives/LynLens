import { describe, expect, it } from 'vitest';
import {
  buildSpecAuthorLines,
  parseSpecAuthorResponse,
  type SpecAuthorLine,
} from '../src/packaging-spec-author';
import type { PreviewPlaylistEntry } from '../src/preview-render';
import type { Transcript } from '../src/types';

const LINES: SpecAuthorLine[] = [
  { idx: 0, variantStart: 0, text: '目前我们面对的案子' },
  { idx: 1, variantStart: 3, text: '他涉嫌成为钱骡' },
  { idx: 2, variantStart: 6, text: 'he became a money mule' },
  { idx: 3, variantStart: 9, text: '它比破产更恐怖' },
  { idx: 4, variantStart: 20, text: '被银行关闭' },
];

describe('parseSpecAuthorResponse', () => {
  it('defaults unlisted lines to plain', () => {
    const spec = parseSpecAuthorResponse('{"lines":[]}', LINES);
    expect(spec.cues).toHaveLength(5);
    expect(spec.cues.every((c) => c.style === 'plain')).toBe(true);
    expect(spec.cues[0].start).toBe(0);
    expect(spec.cues[1].text).toBe('他涉嫌成为钱骡');
  });

  it('keeps strongWord only with a valid in-text keyword substring', () => {
    const raw = JSON.stringify({
      lines: [
        { idx: 2, style: 'strongWord', highlight: ['money'] }, // valid
        { idx: 1, style: 'strongWord', highlight: ['钱骡'] }, // valid substring
      ],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    const c2 = spec.cues.find((c) => c.text.includes('money'))!;
    expect(c2.style).toBe('strongWord');
    expect(c2.highlight).toEqual(['money']);
    const c1 = spec.cues.find((c) => c.text === '他涉嫌成为钱骡')!;
    expect(c1.style).toBe('strongWord');
    expect(c1.highlight).toEqual(['钱骡']);
  });

  it('downgrades strongWord to strong when the keyword is absent or whole-line', () => {
    const raw = JSON.stringify({
      lines: [
        { idx: 0, style: 'strongWord', highlight: ['不存在的词'] },
        { idx: 1, style: 'strongWord', highlight: ['他涉嫌成为钱骡'] }, // whole line
      ],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    expect(spec.cues[0].style).toBe('strong');
    expect(spec.cues[0].highlight).toBeUndefined();
    expect(spec.cues[1].style).toBe('strong');
  });

  it('accepts sentence/cross only with the right segment count', () => {
    const raw = JSON.stringify({
      lines: [
        { idx: 3, style: 'sentence', segments: ['它', '比破产', '更恐怖'] },
        { idx: 4, style: 'cross', segments: ['被银行', '关闭'] },
      ],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    const s = spec.cues.find((c) => c.text === '它比破产更恐怖')!;
    expect(s.style).toBe('sentence');
    expect(s.segments).toEqual(['它', '比破产', '更恐怖']);
    const x = spec.cues.find((c) => c.text === '被银行关闭')!;
    expect(x.style).toBe('cross');
    expect(x.segments).toEqual(['被银行', '关闭']);
  });

  it('downgrades sentence with wrong segment count to strong', () => {
    const raw = JSON.stringify({
      lines: [{ idx: 3, style: 'sentence', segments: ['它', '比破产更恐怖'] }],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    expect(spec.cues[3].style).toBe('strong');
    expect(spec.cues[3].segments).toBeUndefined();
  });

  it('sorts + de-overlaps effects and validates types', () => {
    const raw = JSON.stringify({
      lines: [],
      effects: [
        { type: 'impactPunch', start: 5, end: 6 },
        { type: 'bogus', start: 0, end: 1 }, // invalid type → dropped
        { type: 'vignetteFocus', start: 0, end: 3.5 },
        { type: 'bottomScrim', start: 3, end: 7 }, // overlaps impactPunch window → dropped
      ],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    expect(spec.effects).toEqual([
      { type: 'vignetteFocus', start: 0, end: 3.5 },
      { type: 'impactPunch', start: 5, end: 6 },
    ]);
  });

  it('drops sounds on plain cues + enforces ≥2.5s spacing', () => {
    const raw = JSON.stringify({
      lines: [{ idx: 1, style: 'strong' }, { idx: 3, style: 'strong' }],
      sounds: [
        { id: 'suspense-boom', start: 0 }, // idx0 plain → dropped
        { id: 'ming-suspense', start: 3 }, // idx1 strong → kept
        { id: 'clang-light', start: 4 }, // <2.5s after 3 → dropped
        { id: 'water-drop', start: 9 }, // idx3 strong → kept
        { id: 'not-a-real-sound', start: 12 }, // invalid id → dropped
      ],
    });
    const spec = parseSpecAuthorResponse(raw, LINES);
    expect(spec.sounds).toEqual([
      { id: 'ming-suspense', start: 3 },
      { id: 'water-drop', start: 9 },
    ]);
  });
});

describe('buildSpecAuthorLines', () => {
  it('rebases in-variant segments to variant time, skips cut ones', () => {
    const t: Transcript = {
      language: 'zh',
      engine: 'whisper-cpp',
      model: 'base',
      segments: [
        { id: 'a', start: 0, end: 2, text: 'A', words: [] },
        { id: 'b', start: 3, end: 5, text: 'B', words: [] },
        { id: 'c', start: 6, end: 8, text: 'C', words: [] },
      ],
    };
    const playlist: PreviewPlaylistEntry[] = [
      { srcStart: 3, srcEnd: 6, variantStart: 0, variantEnd: 3 },
    ];
    const lines = buildSpecAuthorLines(t, playlist);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ idx: 1, variantStart: 0, text: 'B' });
  });
});
