import { describe, expect, it } from 'vitest';
import { filterTranscriptByCuts } from '../src/transcription';
import type { Transcript } from '../src/types';

function mkSeg(
  id: string,
  start: number,
  end: number,
  text: string,
  words: Array<[string, number, number]>
) {
  return {
    id,
    start,
    end,
    text,
    words: words.map(([w, s, e]) => ({ w, start: s, end: e })),
  };
}

function mkTranscript(segs: ReturnType<typeof mkSeg>[]): Transcript {
  return { language: 'zh', engine: 'whisper-cpp', model: 'base', segments: segs };
}

describe('filterTranscriptByCuts', () => {
  it('drops segments fully inside a cut', () => {
    const t = mkTranscript([
      mkSeg('a', 0, 5, '前面', [['前', 0, 2], ['面', 2, 5]]),
      mkSeg('b', 10, 15, '中间', [['中', 10, 12], ['间', 12, 15]]),
      mkSeg('c', 20, 25, '后面', [['后', 20, 22], ['面', 22, 25]]),
    ]);
    const cuts = [{ start: 9, end: 16 }]; // covers 'b' fully
    const out = filterTranscriptByCuts(t, cuts);
    expect(out.segments.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('keeps segments that do not overlap any cut', () => {
    const t = mkTranscript([
      mkSeg('a', 0, 5, '原文', [['原', 0, 2], ['文', 2, 5]]),
    ]);
    const cuts = [{ start: 100, end: 200 }];
    const out = filterTranscriptByCuts(t, cuts);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('原文');
  });

  it('trims partial-overlap segments at word level — kept words rebuild the seg', () => {
    // Segment spans [0, 10] covering 5 words. A cut [3, 7] removes the
    // middle two words; the resulting seg should span [0, 3] + [7, 10]…
    // wait, our model can't have non-contiguous segs, so the rebuilt
    // seg.start = first kept word.start = 0 and seg.end = last kept = 10.
    // That's a known compromise — the displayed text is "前面后面" without
    // the middle, the time range is the convex hull, but the warning logic
    // only checks for "spans cut", which is the seg-vs-cut overlap. Since
    // we drop only words fully inside cuts, the warning trigger is
    // independent of this.
    const t = mkTranscript([
      mkSeg('a', 0, 10, '前123后', [
        ['前', 0, 2],
        ['1', 3, 4],   // inside cut
        ['2', 4, 5],   // inside cut
        ['3', 5, 6],   // inside cut
        ['后', 8, 10],
      ]),
    ]);
    const cuts = [{ start: 3, end: 7 }];
    const out = filterTranscriptByCuts(t, cuts);
    expect(out.segments).toHaveLength(1);
    const s = out.segments[0];
    expect(s.text).toBe('前后');
    expect(s.words).toHaveLength(2);
    expect(s.words![0].w).toBe('前');
    expect(s.words![1].w).toBe('后');
    // Time range collapses to first/last kept word.
    expect(s.start).toBe(0);
    expect(s.end).toBe(10);
  });

  it('drops a partial-overlap segment when no words survive', () => {
    const t = mkTranscript([
      mkSeg('a', 0, 5, '都被剪了', [
        ['都', 1, 2],
        ['被', 2, 3],
        ['剪', 3, 4],
        ['了', 4, 5],
      ]),
    ]);
    const cuts = [{ start: 0.5, end: 5.5 }]; // every word is inside
    const out = filterTranscriptByCuts(t, cuts);
    expect(out.segments).toHaveLength(0);
  });

  it('handles multiple cuts on a single segment', () => {
    const t = mkTranscript([
      mkSeg('a', 0, 20, '一二三四五六七八', [
        ['一', 0, 2],
        ['二', 3, 5],   // first cut
        ['三', 6, 8],
        ['四', 9, 11],  // second cut
        ['五', 12, 14],
        ['六', 15, 17],
        ['七', 17, 18],
        ['八', 18, 20],
      ]),
    ]);
    const cuts = [
      { start: 2.5, end: 5.5 },   // removes '二'
      { start: 8.5, end: 11.5 },  // removes '四'
    ];
    const out = filterTranscriptByCuts(t, cuts);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('一三五六七八');
    expect(out.segments[0].words).toHaveLength(6);
  });

  it('returns all segments when cutRanges is empty', () => {
    const t = mkTranscript([mkSeg('a', 0, 5, 'x', [['x', 0, 5]])]);
    const out = filterTranscriptByCuts(t, []);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].id).toBe('a');
  });

  it('does not mutate the input transcript', () => {
    const t = mkTranscript([
      mkSeg('a', 0, 10, '前123后', [
        ['前', 0, 2],
        ['1', 3, 4],
        ['后', 8, 10],
      ]),
    ]);
    const before = JSON.stringify(t);
    filterTranscriptByCuts(t, [{ start: 3, end: 7 }]);
    expect(JSON.stringify(t)).toBe(before);
  });
});
