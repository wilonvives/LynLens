import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus';
import { SegmentManager } from '../src/segment-manager';

function mk() {
  const bus = new EventBus();
  return new SegmentManager('p1', bus);
}

describe('SegmentManager', () => {
  it('adds a human segment as approved by default', () => {
    const m = mk();
    const s = m.add({ start: 1, end: 2, source: 'human' });
    expect(s.status).toBe('approved');
    expect(m.list()).toHaveLength(1);
  });

  it('adds an ai segment as pending by default', () => {
    const m = mk();
    const s = m.add({ start: 1, end: 2, source: 'ai', reason: 'pause' });
    expect(s.status).toBe('pending');
  });

  it('merges overlapping segments', () => {
    const m = mk();
    m.add({ start: 1, end: 5, source: 'human' });
    m.add({ start: 4, end: 8, source: 'human' });
    const segs = m.list();
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(1);
    expect(segs[0].end).toBe(8);
  });

  it('merges human with ai, keeping source=human and stronger status', () => {
    const m = mk();
    m.add({ start: 1, end: 5, source: 'ai', reason: 'pause' });
    m.add({ start: 4, end: 8, source: 'human' });
    const segs = m.list();
    expect(segs).toHaveLength(1);
    expect(segs[0].source).toBe('human');
    expect(segs[0].status).toBe('approved');
  });

  it('computes keep segments with approved deletes only', () => {
    const m = mk();
    m.add({ start: 5, end: 10, source: 'human' }); // approved
    m.add({ start: 20, end: 25, source: 'ai', reason: 'pause' }); // pending (ignored)
    const keeps = m.getKeepSegments(30);
    expect(keeps).toEqual([
      { start: 0, end: 5 },
      { start: 10, end: 30 },
    ]);
  });

  it('approve then re-run keep', () => {
    const m = mk();
    const s = m.add({ start: 20, end: 25, source: 'ai', reason: 'pause' });
    m.approve(s.id);
    const keeps = m.getKeepSegments(30);
    expect(keeps).toEqual([
      { start: 0, end: 20 },
      { start: 25, end: 30 },
    ]);
  });

  it('undo/redo add', () => {
    const m = mk();
    m.add({ start: 1, end: 2, source: 'human' });
    expect(m.list()).toHaveLength(1);
    expect(m.undo()).toBe(true);
    expect(m.list()).toHaveLength(0);
    expect(m.redo()).toBe(true);
    expect(m.list()).toHaveLength(1);
  });

  it('undo restores merged-out segments', () => {
    const m = mk();
    const a = m.add({ start: 1, end: 5, source: 'human' });
    const b = m.add({ start: 4, end: 8, source: 'human' });
    // second add should have merged them
    expect(m.list()).toHaveLength(1);
    expect(m.undo()).toBe(true);
    const listAfterUndo = m.list();
    expect(listAfterUndo).toHaveLength(1);
    expect(listAfterUndo[0].id).toBe(a.id);
    expect(b.id).not.toBe(a.id);
  });

  it('rejects invalid ranges', () => {
    const m = mk();
    expect(() => m.add({ start: 5, end: 5, source: 'human' })).toThrow();
    expect(() => m.add({ start: 5, end: 3, source: 'human' })).toThrow();
  });

  it('resize', () => {
    const m = mk();
    const s = m.add({ start: 1, end: 2, source: 'human' });
    m.resize(s.id, 1.5, 3);
    const got = m.find(s.id)!;
    expect(got.start).toBeCloseTo(1.5);
    expect(got.end).toBe(3);
  });

  it('getTotalDeletedDuration sums approved only', () => {
    const m = mk();
    m.add({ start: 0, end: 5, source: 'human' }); // 5
    m.add({ start: 10, end: 12, source: 'ai', reason: 'x' }); // pending, not counted
    expect(m.getTotalDeletedDuration()).toBe(5);
  });

  // Regression guard: erasing a range strictly inside an existing segment
  // must produce TWO halves — the old code read `s.end` after `resize()`
  // had already mutated it, so the back half was silently lost.
  it('eraseRange splits when the range is strictly inside a segment', () => {
    const m = mk();
    m.add({ start: 40, end: 80, source: 'human' });
    m.eraseRange(50, 60);
    const segs = m.list().sort((a, b) => a.start - b.start);
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(40);
    expect(segs[0].end).toBe(50);
    expect(segs[1].start).toBe(60);
    expect(segs[1].end).toBe(80);
  });

  it('eraseRange trims tail when range overlaps back', () => {
    const m = mk();
    m.add({ start: 10, end: 30, source: 'human' });
    m.eraseRange(20, 40);
    const segs = m.list();
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(10);
    expect(segs[0].end).toBe(20);
  });

  it('eraseRange trims head when range overlaps front', () => {
    const m = mk();
    m.add({ start: 20, end: 50, source: 'human' });
    m.eraseRange(10, 30);
    const segs = m.list();
    expect(segs).toHaveLength(1);
    expect(segs[0].start).toBe(30);
    expect(segs[0].end).toBe(50);
  });

  it('eraseRange removes segments fully inside the range', () => {
    const m = mk();
    m.add({ start: 20, end: 30, source: 'human' });
    m.eraseRange(10, 40);
    expect(m.list()).toHaveLength(0);
  });

  it('eraseRange leaves non-overlapping segments untouched', () => {
    const m = mk();
    m.add({ start: 0, end: 10, source: 'human' });
    m.add({ start: 40, end: 50, source: 'human' });
    m.eraseRange(20, 30);
    const segs = m.list().sort((a, b) => a.start - b.start);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: 0, end: 10 });
    expect(segs[1]).toMatchObject({ start: 40, end: 50 });
  });
});
