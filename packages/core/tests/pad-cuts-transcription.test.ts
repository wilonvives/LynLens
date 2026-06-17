import { describe, expect, it } from 'vitest';
import { padCutsForTranscription } from '../src/transcription';

/**
 * Edited-scope transcription clips the boundary syllable because atrim slices
 * exactly at the cut edges. padCutsForTranscription shrinks each cut inward so
 * the kept audio keeps a lead-in/lead-out — recovering the "句子前后缺一个字".
 */
describe('padCutsForTranscription', () => {
  it('shrinks a large cut by the full pad on each side', () => {
    // 5s removed sentence, pad 0.15 → [10.15, 14.85].
    expect(padCutsForTranscription([{ start: 10, end: 15 }], 0.15)).toEqual([
      { start: 10.15, end: 14.85 },
    ]);
  });

  it('never consumes more than 40% of a cut (tiny filler stays mostly removed)', () => {
    // 0.2s filler: 0.4*0.2 = 0.08 < 0.15 → pad clamped to 0.08 each side.
    // Cut stays [10.08, 10.12] = 0.04s still removed (not re-transcribed whole).
    const [c] = padCutsForTranscription([{ start: 10, end: 10.2 }], 0.15);
    expect(c.start).toBeCloseTo(10.08);
    expect(c.end).toBeCloseTo(10.12);
    expect(c.end - c.start).toBeGreaterThan(0); // never fully closes
  });

  it('keeps the kept ranges wider than the raw cuts (recovers boundary audio)', () => {
    // The shrunk cut is strictly inside the original → the inverse keeps extend
    // INTO where the original cut was, on both sides.
    const orig = { start: 10, end: 12 };
    const [padded] = padCutsForTranscription([orig], 0.15);
    expect(padded.start).toBeGreaterThan(orig.start);
    expect(padded.end).toBeLessThan(orig.end);
  });

  it('drops degenerate (zero/negative) cuts', () => {
    expect(padCutsForTranscription([{ start: 5, end: 5 }], 0.15)).toEqual([]);
    expect(padCutsForTranscription([{ start: 5, end: 4 }], 0.15)).toEqual([]);
  });

  it('handles multiple cuts independently', () => {
    const out = padCutsForTranscription(
      [
        { start: 10, end: 15 },
        { start: 30, end: 30.2 },
      ],
      0.15
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ start: 10.15, end: 14.85 });
    expect(out[1].end - out[1].start).toBeGreaterThan(0);
  });
});
