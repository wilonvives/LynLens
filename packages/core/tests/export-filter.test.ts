import { describe, expect, it } from 'vitest';
import { buildConcatFilter } from '../src/export-service';

describe('buildConcatFilter', () => {
  it('builds a single-range filter', () => {
    const f = buildConcatFilter([{ start: 0, end: 5 }]);
    expect(f).toContain('trim=start=0:end=5');
    expect(f).toContain('atrim=start=0:end=5');
    expect(f).toContain('concat=n=1:v=1:a=1[outv][outa]');
  });

  it('builds a multi-range filter', () => {
    const f = buildConcatFilter([
      { start: 0, end: 5.2 },
      { start: 10.1, end: 20.5 },
      { start: 25.8, end: 30 },
    ]);
    expect(f).toContain('concat=n=3:v=1:a=1[outv][outa]');
    expect(f).toContain('[v0][a0][v1][a1][v2][a2]concat');
  });

  it('throws on empty input', () => {
    expect(() => buildConcatFilter([])).toThrow();
  });

  // Regression for highlight-export bug: variant segments must be played
  // in array order (not time-sorted) AND duplicate ranges must be kept
  // as duplicates (so "use clip X twice" actually plays twice).
  it('preserves out-of-order ranges (no implicit sort)', () => {
    const f = buildConcatFilter([
      { start: 60, end: 65 }, // #1 — picked from late in the video
      { start: 5, end: 10 }, // #2 — early
      { start: 30, end: 35 }, // #3 — middle
    ]);
    // [v0] / [a0] correspond to the FIRST input range (start=60), so
    // they must reference start=60.
    expect(f).toContain('trim=start=60:end=65,setpts=PTS-STARTPTS[v0]');
    expect(f).toContain('trim=start=5:end=10,setpts=PTS-STARTPTS[v1]');
    expect(f).toContain('trim=start=30:end=35,setpts=PTS-STARTPTS[v2]');
    // Final concat sequence preserves the order: [v0][a0][v1][a1][v2][a2]
    expect(f).toContain('[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1');
  });

  it('preserves duplicate ranges (concat=n counts each occurrence)', () => {
    const f = buildConcatFilter([
      { start: 10, end: 15 },
      { start: 10, end: 15 }, // same range twice — must export as two clips
    ]);
    expect(f).toContain('concat=n=2:v=1:a=1[outv][outa]');
    // Two distinct VIDEO trim nodes pointing at the same source range
    // (the matching atrim audio nodes would double this if we matched both)
    const videoMatches = f.match(/\[0:v\]trim=start=10:end=15/g);
    expect(videoMatches?.length).toBe(2);
  });
});

// Orientation regression (v0.5.x): iPhone portrait clips store LANDSCAPE
// frames + a Display Matrix rotation. extractRotation() normalises that
// signed angle to 0/90/180/270. The transpose direction MUST match ffmpeg's
// own auto-rotation (which uses theta = -displayRotation), NOT the raw
// display-matrix sign — otherwise portrait videos export 180° upside-down.
//
// Ground truth verified by extracting frames from a real iPhone clip
// (Display Matrix rotation -90 → normalised 270) and SHA1-comparing against
// `ffmpeg` default auto-rotation:
//   rotation 270  →  transpose=1  (90° CW)   == autorotate output (identical bytes)
//   rotation  90  →  transpose=2  (90° CCW)
describe('buildConcatFilter rotation', () => {
  it('emits no transpose when rotation is 0', () => {
    const f = buildConcatFilter([{ start: 0, end: 5 }], 0);
    expect(f).not.toContain('transpose');
  });

  it('rotation 270 (iPhone portrait, display matrix -90) uses transpose=1 (CW)', () => {
    const f = buildConcatFilter([{ start: 0, end: 5 }], 270);
    expect(f).toContain('[0:v]transpose=1,trim=');
    expect(f).not.toContain('transpose=2');
  });

  it('rotation 90 uses transpose=2 (CCW)', () => {
    const f = buildConcatFilter([{ start: 0, end: 5 }], 90);
    expect(f).toContain('[0:v]transpose=2,trim=');
  });

  it('rotation 180 uses a double transpose', () => {
    const f = buildConcatFilter([{ start: 0, end: 5 }], 180);
    expect(f).toContain('transpose=1,transpose=1,trim=');
  });
});
