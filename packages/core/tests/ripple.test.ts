import { describe, expect, it } from 'vitest';
import {
  addCutRange,
  computeKeepIntervals,
  effectiveToSource,
  getEffectiveDuration,
  mapRangeToEffective,
  normalizeCuts,
  sourceToEffective,
} from '../src/ripple';

describe('normalizeCuts', () => {
  it('returns empty for empty input', () => {
    expect(normalizeCuts([])).toEqual([]);
  });

  it('drops zero-length ranges', () => {
    expect(normalizeCuts([{ start: 5, end: 5 }])).toEqual([]);
  });

  it('sorts by start', () => {
    expect(normalizeCuts([
      { start: 30, end: 40 },
      { start: 10, end: 20 },
    ])).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('merges overlapping ranges', () => {
    expect(normalizeCuts([
      { start: 10, end: 20 },
      { start: 15, end: 25 },
    ])).toEqual([{ start: 10, end: 25 }]);
  });

  it('merges touching ranges (end === start)', () => {
    expect(normalizeCuts([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ])).toEqual([{ start: 10, end: 30 }]);
  });

  it('clamps to totalDuration when provided', () => {
    expect(normalizeCuts([{ start: 5, end: 100 }], 50)).toEqual([{ start: 5, end: 50 }]);
  });
});

describe('addCutRange', () => {
  it('is a no-op for invalid range', () => {
    const cuts = [{ start: 0, end: 10 }];
    expect(addCutRange(cuts, { start: 5, end: 5 })).toEqual(cuts);
  });

  it('appends and merges', () => {
    expect(addCutRange([{ start: 0, end: 10 }], { start: 8, end: 15 }))
      .toEqual([{ start: 0, end: 15 }]);
  });
});

describe('getEffectiveDuration', () => {
  it('equals totalDuration when no cuts', () => {
    expect(getEffectiveDuration(100, [])).toBe(100);
  });

  it('subtracts cut total', () => {
    expect(getEffectiveDuration(100, [
      { start: 10, end: 20 },
      { start: 40, end: 45 },
    ])).toBe(85);
  });

  it('never negative', () => {
    expect(getEffectiveDuration(10, [{ start: 0, end: 100 }])).toBe(0);
  });
});

describe('sourceToEffective', () => {
  it('identity when no cuts', () => {
    expect(sourceToEffective(42, [])).toBe(42);
  });

  it('subtracts cuts before the source point', () => {
    expect(sourceToEffective(50, [{ start: 10, end: 20 }])).toBe(40);
  });

  it('collapses points inside a cut to the boundary', () => {
    expect(sourceToEffective(15, [{ start: 10, end: 20 }])).toBe(10);
  });

  it('handles multiple cuts', () => {
    const cuts = [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ];
    expect(sourceToEffective(5, cuts)).toBe(5);   // before any cut
    expect(sourceToEffective(25, cuts)).toBe(15); // between cuts
    expect(sourceToEffective(60, cuts)).toBe(40); // after both cuts
  });

  it('clamps negatives to 0', () => {
    expect(sourceToEffective(-5, [])).toBe(0);
  });
});

describe('effectiveToSource', () => {
  it('identity when no cuts', () => {
    expect(effectiveToSource(42, [])).toBe(42);
  });

  it('adds back cuts before the effective point', () => {
    expect(effectiveToSource(40, [{ start: 10, end: 20 }])).toBe(50);
  });

  it('inside the first kept region returns directly', () => {
    expect(effectiveToSource(5, [{ start: 10, end: 20 }])).toBe(5);
  });

  it('is monotonic across cuts', () => {
    const cuts = [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ];
    // effective: keep [0,10], [20,40], [50, ...]  → lengths 10, 20, ...
    expect(effectiveToSource(0, cuts)).toBe(0);
    expect(effectiveToSource(10, cuts)).toBe(20);
    expect(effectiveToSource(30, cuts)).toBe(50);
    expect(effectiveToSource(40, cuts)).toBe(60);
  });

  it('inverse of sourceToEffective for points outside cuts', () => {
    const cuts = [
      { start: 10, end: 20 },
      { start: 40, end: 50 },
    ];
    for (const src of [0, 5, 25, 39, 51, 100]) {
      expect(effectiveToSource(sourceToEffective(src, cuts), cuts)).toBeCloseTo(src);
    }
  });
});

describe('mapRangeToEffective', () => {
  it('returns the range unchanged when no cuts', () => {
    expect(mapRangeToEffective({ start: 10, end: 20 }, [])).toEqual([
      { start: 10, end: 20 },
    ]);
  });

  it('empty when range is fully inside a cut', () => {
    expect(mapRangeToEffective({ start: 12, end: 18 }, [{ start: 10, end: 20 }])).toEqual([]);
  });

  it('splits when a range straddles a cut', () => {
    const cuts = [{ start: 20, end: 30 }];
    const pieces = mapRangeToEffective({ start: 10, end: 40 }, cuts);
    // Kept source pieces: [10,20] → eff [10,20], [30,40] → eff [20,30]
    expect(pieces).toEqual([
      { start: 10, end: 20 },
      { start: 20, end: 30 },
    ]);
  });

  it('trims when a range overlaps the front of a cut', () => {
    const cuts = [{ start: 20, end: 30 }];
    // Source [15, 25] → kept part [15, 20] → eff [15, 20]
    expect(mapRangeToEffective({ start: 15, end: 25 }, cuts))
      .toEqual([{ start: 15, end: 20 }]);
  });

  it('trims when a range overlaps the back of a cut', () => {
    const cuts = [{ start: 20, end: 30 }];
    // Source [25, 40] → kept part [30, 40] → eff [20, 30]
    expect(mapRangeToEffective({ start: 25, end: 40 }, cuts))
      .toEqual([{ start: 20, end: 30 }]);
  });
});

describe('computeKeepIntervals', () => {
  it('returns whole duration when nothing dropped', () => {
    expect(computeKeepIntervals(100, [], [])).toEqual([{ start: 0, end: 100 }]);
  });

  it('merges approved deletes and cuts', () => {
    expect(computeKeepIntervals(
      100,
      [{ start: 10, end: 20 }],
      [{ start: 40, end: 60 }]
    )).toEqual([
      { start: 0, end: 10 },
      { start: 20, end: 40 },
      { start: 60, end: 100 },
    ]);
  });

  it('merges overlapping deletes and cuts', () => {
    expect(computeKeepIntervals(
      100,
      [{ start: 10, end: 30 }],
      [{ start: 20, end: 40 }]
    )).toEqual([
      { start: 0, end: 10 },
      { start: 40, end: 100 },
    ]);
  });

  it('drops out-of-range deletes', () => {
    expect(computeKeepIntervals(
      50,
      [{ start: 60, end: 70 }],
      []
    )).toEqual([{ start: 0, end: 50 }]);
  });
});
