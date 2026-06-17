import { describe, expect, it } from 'vitest';
import { adaptiveSilenceThreshold, detectSilences } from '../src/transcription';

describe('detectSilences', () => {
  it('returns empty for empty waveform', () => {
    expect(detectSilences(new Float32Array(0), 10)).toEqual([]);
  });

  it('finds a single silent gap', () => {
    // 10 seconds, 1000 buckets => 100 buckets/sec
    const wf = new Float32Array(1000);
    // speech (loud) from 0-3s
    for (let i = 0; i < 300; i++) wf[i] = 0.5;
    // silence 3-6s
    for (let i = 300; i < 600; i++) wf[i] = 0.001;
    // speech 6-10s
    for (let i = 600; i < 1000; i++) wf[i] = 0.5;
    const silences = detectSilences(wf, 10, { minPauseSec: 1, paddingSec: 0 });
    expect(silences).toHaveLength(1);
    expect(silences[0].start).toBeCloseTo(3, 1);
    expect(silences[0].end).toBeCloseTo(6, 1);
    expect(silences[0].reason).toMatch(/停顿/);
  });

  it('ignores short pauses below minPauseSec', () => {
    const wf = new Float32Array(1000);
    for (let i = 0; i < 300; i++) wf[i] = 0.5;
    // 0.3s silence
    for (let i = 300; i < 330; i++) wf[i] = 0;
    for (let i = 330; i < 1000; i++) wf[i] = 0.5;
    const silences = detectSilences(wf, 10, { minPauseSec: 1 });
    expect(silences).toHaveLength(0);
  });

  it('handles trailing silence', () => {
    const wf = new Float32Array(1000);
    for (let i = 0; i < 500; i++) wf[i] = 0.5;
    // silence 5s-10s
    const silences = detectSilences(wf, 10, { minPauseSec: 1, paddingSec: 0 });
    expect(silences.length).toBe(1);
    expect(silences[0].start).toBeCloseTo(5, 0);
  });

  it('finds pauses on a NOISY recording where a fixed 0.03 would miss them', () => {
    // The reported bug: room tone keeps the "silence" at ~0.06 — above the old
    // fixed 0.03 cut line, so nothing was detected. Speech peaks at 0.4.
    const wf = new Float32Array(1000);
    const fill = (a: number, b: number, v: number) => {
      for (let i = a; i < b; i++) wf[i] = v;
    };
    fill(0, 300, 0.4); // speech
    fill(300, 600, 0.06); // pause WITH room tone (above 0.03!)
    fill(600, 1000, 0.4); // speech

    // Fixed 0.03 → the 0.06 pause never reads as silent → nothing found.
    expect(detectSilences(wf, 10, { silenceThreshold: 0.03, minPauseSec: 1 })).toHaveLength(0);

    // Adaptive (default) measures the 0.06 floor and cuts above it → found.
    const auto = detectSilences(wf, 10, { minPauseSec: 1, paddingSec: 0 });
    expect(auto).toHaveLength(1);
    expect(auto[0].start).toBeCloseTo(3, 1);
    expect(auto[0].end).toBeCloseTo(6, 1);
  });

  it('adaptive threshold sits between room-tone floor and speech', () => {
    const wf = new Float32Array(1000);
    for (let i = 0; i < 400; i++) wf[i] = 0.06; // room tone
    for (let i = 400; i < 1000; i++) wf[i] = 0.4; // speech
    const thr = adaptiveSilenceThreshold(wf, 0.5);
    expect(thr).toBeGreaterThan(0.06); // above room tone (so pauses count)
    expect(thr).toBeLessThan(0.4); // below speech (so talking doesn't)
  });

  it('higher sensitivity raises the cut line (marks more)', () => {
    const wf = new Float32Array(1000);
    for (let i = 0; i < 400; i++) wf[i] = 0.06;
    for (let i = 400; i < 1000; i++) wf[i] = 0.4;
    expect(adaptiveSilenceThreshold(wf, 0.9)).toBeGreaterThan(
      adaptiveSilenceThreshold(wf, 0.1)
    );
  });
});
