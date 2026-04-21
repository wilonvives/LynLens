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
});
