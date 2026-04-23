import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../src/event-bus';
import { ProjectManager } from '../src/project-manager';

function makeMeta() {
  return { duration: 100, width: 1920, height: 1080, fps: 30, codec: 'h264' };
}

describe('ProjectManager', () => {
  it('opens, saves, reopens a project preserving segments', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);

    const project = await pm.openProject({
      videoPath: 'C:/videos/sample.mp4',
      videoMeta: makeMeta(),
    });
    project.segments.add({ start: 5, end: 10, source: 'human' });
    project.segments.add({ start: 30, end: 35, source: 'ai', reason: '停顿' });

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-test-'));
    const qcpPath = path.join(tmp, 'project.qcp');
    await pm.saveProject(project.id, qcpPath);
    pm.closeProject(project.id);

    const reopened = await pm.openProject({
      videoPath: 'C:/videos/sample.mp4',
      videoMeta: makeMeta(),
      projectPath: qcpPath,
    });
    const segs = reopened.segments.list();
    expect(segs).toHaveLength(2);
    expect(segs[0].start).toBe(5);
    expect(segs[1].reason).toBe('停顿');
    expect(segs[1].status).toBe('pending');
  });

  it('emits project.opened when opening', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const events: string[] = [];
    bus.onAny((e) => events.push(e.type));
    await pm.openProject({ videoPath: 'x', videoMeta: makeMeta() });
    expect(events).toContain('project.opened');
  });

  it('commitRipple flips approved segments to cut status and shrinks effective duration', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x', videoMeta: makeMeta() });

    const a = p.segments.add({ start: 10, end: 20, source: 'human' });           // approved
    const b = p.segments.add({ start: 40, end: 45, source: 'human' });           // approved
    const c = p.segments.add({ start: 70, end: 75, source: 'ai', reason: 'x' }); // pending

    const events: string[] = [];
    bus.onAny((e) => events.push(e.type));

    const result = p.commitRipple();

    expect(result.cutSegmentIds).toHaveLength(2);
    expect(result.totalCutSeconds).toBe(15);
    expect(result.effectiveDuration).toBe(85);
    expect(events).toContain('ripple.committed');
    expect(events).toContain('segment.cut');

    // All three segments still exist; two are now cut, one is still pending.
    const all = p.segments.list();
    expect(all).toHaveLength(3);
    expect(p.segments.find(a.id)!.status).toBe('cut');
    expect(p.segments.find(b.id)!.status).toBe('cut');
    expect(p.segments.find(c.id)!.status).toBe('pending');

    // Derived cutRanges sums to the rippled-out source time.
    expect(p.cutRanges).toEqual([
      { start: 10, end: 20 },
      { start: 40, end: 45 },
    ]);
    expect(p.getEffectiveDuration()).toBe(85);
  });

  it('commitRipple with no approved segments is a no-op', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x', videoMeta: makeMeta() });
    p.segments.add({ start: 10, end: 20, source: 'ai', reason: 'x' }); // pending

    const result = p.commitRipple();
    expect(result.cutSegmentIds).toEqual([]);
    expect(result.totalCutSeconds).toBe(0);
    expect(p.cutRanges).toEqual([]);
    expect(p.segments.list()).toHaveLength(1);
  });

  it('cut status persists across save/reopen and still drives effective duration', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x.mp4', videoMeta: makeMeta() });
    p.segments.add({ start: 10, end: 20, source: 'human' });
    p.commitRipple();

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-ripple-'));
    const qcpPath = path.join(tmp, 'project.qcp');
    await pm.saveProject(p.id, qcpPath);
    pm.closeProject(p.id);

    const reopened = await pm.openProject({
      videoPath: 'x.mp4',
      videoMeta: makeMeta(),
      projectPath: qcpPath,
    });
    const segs = reopened.segments.list();
    expect(segs).toHaveLength(1);
    expect(segs[0].status).toBe('cut');
    expect(reopened.cutRanges).toEqual([{ start: 10, end: 20 }]);
    expect(reopened.getEffectiveDuration()).toBe(90);
  });

  it('revertRipple flips a single cut segment back to approved', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x.mp4', videoMeta: makeMeta() });
    const s = p.segments.add({ start: 10, end: 20, source: 'human' });
    p.commitRipple();
    expect(p.cutRanges).toHaveLength(1);

    const ok = p.revertRipple(s.id);
    expect(ok).toBe(true);
    expect(p.cutRanges).toEqual([]);
    expect(p.getEffectiveDuration()).toBe(100);
    // Segment is back to approved, still visible in the list.
    const seg = p.segments.find(s.id);
    expect(seg).toBeDefined();
    expect(seg!.status).toBe('approved');
  });

  it('revertRipple is a no-op for unknown id or non-cut segment', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x', videoMeta: makeMeta() });
    const s = p.segments.add({ start: 10, end: 20, source: 'human' });
    // Segment is approved but NOT yet cut — revert should fail.
    expect(p.revertRipple(s.id)).toBe(false);
    // Unknown id
    expect(p.revertRipple('bogus')).toBe(false);
  });

  it('migrates legacy cutRanges on open by creating cut-status segments', async () => {
    // Simulate a .qcp written by an older build.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lynlens-migrate-'));
    const qcpPath = path.join(tmp, 'legacy.qcp');
    const now = new Date().toISOString();
    const legacy = {
      version: '2.0',
      videoPath: 'x.mp4',
      videoMeta: makeMeta(),
      transcript: null,
      deleteSegments: [],
      aiMode: 'L2',
      cutRanges: [
        { start: 10, end: 20 },
        { start: 40, end: 45 },
      ],
      createdAt: now,
      modifiedAt: now,
    };
    await fs.writeFile(qcpPath, JSON.stringify(legacy), 'utf-8');

    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({
      videoPath: 'x.mp4',
      videoMeta: makeMeta(),
      projectPath: qcpPath,
    });
    const segs = p.segments.list();
    expect(segs).toHaveLength(2);
    expect(segs.every((s) => s.status === 'cut')).toBe(true);
    expect(p.cutRanges).toHaveLength(2);
    expect(p.getEffectiveDuration()).toBe(85);
  });
});
