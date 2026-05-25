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

// Behaviour (v0.5.x): a cut only DROPS a transcript segment that lies entirely
// inside it. Segments that merely overlap a cut boundary are kept WHOLE — we
// no longer trim them at the word level, because that silently chopped out
// whichever character a cut landed on and produced unreadable, swallowed-word
// subtitles once cuts got dense.
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

  it('drops a segment whose span exactly matches the cut', () => {
    const t = mkTranscript([mkSeg('a', 0, 5, '都被剪了', [['都', 0, 2], ['了', 2, 5]])]);
    const out = filterTranscriptByCuts(t, [{ start: 0, end: 5 }]);
    expect(out.segments).toHaveLength(0);
  });

  it('keeps segments that do not overlap any cut', () => {
    const t = mkTranscript([mkSeg('a', 0, 5, '原文', [['原', 0, 2], ['文', 2, 5]])]);
    const out = filterTranscriptByCuts(t, [{ start: 100, end: 200 }]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('原文');
  });

  it('keeps a partial-overlap segment WHOLE (no mid-word chopping)', () => {
    // A cut lands in the middle of the phrase. The phrase must survive intact —
    // this is the "做 vanished" regression we are protecting against.
    const t = mkTranscript([
      mkSeg('a', 0, 10, '前123后', [
        ['前', 0, 2],
        ['1', 3, 4],
        ['2', 4, 5],
        ['3', 5, 6],
        ['后', 8, 10],
      ]),
    ]);
    const out = filterTranscriptByCuts(t, [{ start: 3, end: 7 }]);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('前123后'); // intact, not "前后"
    expect(out.segments[0].words).toHaveLength(5);
    expect(out.segments[0].start).toBe(0);
    expect(out.segments[0].end).toBe(10);
  });

  it('keeps a segment that a cut almost-but-not-fully covers', () => {
    const t = mkTranscript([mkSeg('a', 0, 5, '没全剪', [['没', 0, 2], ['全', 2, 3], ['剪', 3, 5]])]);
    const out = filterTranscriptByCuts(t, [{ start: 0.5, end: 5.5 }]); // starts after seg
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].text).toBe('没全剪');
  });

  it('returns all segments when cutRanges is empty', () => {
    const t = mkTranscript([mkSeg('a', 0, 5, 'x', [['x', 0, 5]])]);
    const out = filterTranscriptByCuts(t, []);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].id).toBe('a');
  });

  it('does not mutate the input transcript', () => {
    const t = mkTranscript([mkSeg('a', 0, 10, '前123后', [['前', 0, 2], ['1', 3, 4], ['后', 8, 10]])]);
    const before = JSON.stringify(t);
    filterTranscriptByCuts(t, [{ start: 3, end: 7 }]);
    expect(JSON.stringify(t)).toBe(before);
  });
});
