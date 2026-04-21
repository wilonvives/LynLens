import { describe, expect, it } from 'vitest';
import { detectSilences } from '../src/transcription';

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
});
