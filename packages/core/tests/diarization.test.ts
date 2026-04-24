import { describe, expect, it } from 'vitest';
import {
  applySpeakersToTranscript,
  clearTranscriptSpeakers,
  listSpeakers,
  MockDiarizationEngine,
  runMockDiarization,
  type DiarizationResult,
} from '../src/diarization';
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

describe('applySpeakersToTranscript', () => {
  it('labels each segment by the speaker whose range covers its midpoint', () => {
    const t = mkTranscript([
      { start: 0, end: 5, text: 'a' },
      { start: 5, end: 10, text: 'b' },
      { start: 10, end: 15, text: 'c' },
    ]);
    const diar: DiarizationResult = {
      engine: 'mock',
      speakers: ['S1', 'S2'],
      segments: [
        { start: 0, end: 6, speaker: 'S1' },
        { start: 6, end: 20, speaker: 'S2' },
      ],
    };
    const out = applySpeakersToTranscript(t, diar);
    expect(out.segments[0].speaker).toBe('S1'); // mid 2.5 → S1
    expect(out.segments[1].speaker).toBe('S2'); // mid 7.5 → S2
    expect(out.segments[2].speaker).toBe('S2'); // mid 12.5 → S2
  });

  it('leaves segments without a matching range unlabeled', () => {
    const t = mkTranscript([{ start: 100, end: 110, text: 'orphan' }]);
    const out = applySpeakersToTranscript(t, {
      engine: 'mock',
      speakers: ['S1'],
      segments: [{ start: 0, end: 10, speaker: 'S1' }],
    });
    expect(out.segments[0].speaker).toBeUndefined();
  });

  it('does not mutate the input transcript', () => {
    const t = mkTranscript([{ start: 0, end: 5, text: 'a' }]);
    const original = JSON.stringify(t);
    applySpeakersToTranscript(t, {
      engine: 'mock',
      speakers: ['S1'],
      segments: [{ start: 0, end: 5, speaker: 'S1' }],
    });
    expect(JSON.stringify(t)).toBe(original);
  });

  it('preserves existing speaker when new diarization has no match', () => {
    const t: Transcript = mkTranscript([{ start: 100, end: 110, text: 'x' }]);
    t.segments[0].speaker = 'S2';
    const out = applySpeakersToTranscript(t, {
      engine: 'mock',
      speakers: ['S1'],
      segments: [{ start: 0, end: 50, speaker: 'S1' }],
    });
    expect(out.segments[0].speaker).toBe('S2');
  });
});

describe('clearTranscriptSpeakers', () => {
  it('removes every speaker field', () => {
    const t: Transcript = mkTranscript([
      { start: 0, end: 5, text: 'a' },
      { start: 5, end: 10, text: 'b' },
    ]);
    t.segments[0].speaker = 'S1';
    t.segments[1].speaker = 'S2';
    const out = clearTranscriptSpeakers(t);
    expect(out.segments.every((s) => s.speaker === undefined)).toBe(true);
  });

  it('leaves non-speaker fields intact', () => {
    const t: Transcript = mkTranscript([{ start: 0, end: 5, text: 'alpha' }]);
    t.segments[0].speaker = 'S1';
    const out = clearTranscriptSpeakers(t);
    expect(out.segments[0].text).toBe('alpha');
    expect(out.segments[0].id).toBe('seg_0');
  });
});

describe('listSpeakers', () => {
  it('returns empty for null / empty transcript', () => {
    expect(listSpeakers(null)).toEqual([]);
    expect(listSpeakers(mkTranscript([]))).toEqual([]);
  });

  it('returns distinct sorted IDs', () => {
    const t: Transcript = mkTranscript([
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
      { start: 2, end: 3, text: 'c' },
    ]);
    t.segments[0].speaker = 'S2';
    t.segments[1].speaker = 'S1';
    t.segments[2].speaker = 'S2';
    expect(listSpeakers(t)).toEqual(['S1', 'S2']);
  });
});

describe('runMockDiarization', () => {
  it('assigns at least one speaker for non-empty transcripts', () => {
    const t = mkTranscript([
      { start: 0, end: 5, text: 'a' },
      { start: 5, end: 10, text: 'b' },
    ]);
    const out = runMockDiarization(t);
    expect(out.engine).toBe('mock');
    expect(out.segments.length).toBeGreaterThan(0);
    expect(out.speakers.length).toBeGreaterThan(0);
  });

  it('honours speakerCount option', () => {
    const t = mkTranscript(
      Array.from({ length: 20 }, (_, i) => ({ start: i, end: i + 1, text: 'x' }))
    );
    const out = runMockDiarization(t, { speakerCount: 3 });
    // All speakers should be from the S1-S3 set (mock might not hit all 3 on
    // short inputs, but must never produce a speaker outside the range).
    for (const s of out.speakers) {
      expect(['S1', 'S2', 'S3']).toContain(s);
    }
  });

  it('empty transcript yields empty result without throwing', () => {
    const out = runMockDiarization(mkTranscript([]));
    expect(out.segments).toEqual([]);
    expect(out.speakers).toEqual([]);
  });
});

describe('MockDiarizationEngine', () => {
  it('returns mock-tagged results', async () => {
    const t = mkTranscript([{ start: 0, end: 5, text: 'a' }]);
    const engine = new MockDiarizationEngine(() => t);
    const out = await engine.diarize('any/path.wav');
    expect(out.engine).toBe('mock');
  });

  it('tolerates missing transcript by returning empty', async () => {
    const engine = new MockDiarizationEngine(() => null);
    const out = await engine.diarize('x.wav');
    expect(out.segments).toEqual([]);
  });
});
