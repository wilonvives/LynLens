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

  it('commitRipple moves approved segments into cutRanges and shrinks effective duration', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x', videoMeta: makeMeta() });

    p.segments.add({ start: 10, end: 20, source: 'human' });          // approved
    p.segments.add({ start: 40, end: 45, source: 'human' });          // approved
    p.segments.add({ start: 70, end: 75, source: 'ai', reason: 'x' }); // pending (not cut)

    const events: string[] = [];
    bus.onAny((e) => events.push(e.type));

    const result = p.commitRipple();

    expect(result.cutSegmentIds).toHaveLength(2);
    expect(result.totalCutSeconds).toBe(15);
    expect(result.effectiveDuration).toBe(85);
    expect(events).toContain('ripple.committed');

    // Approved segments are gone from the list; pending is preserved.
    const remaining = p.segments.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe('pending');

    // cutRanges holds the source-time ranges.
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
    expect(result.addedCutRange).toBeNull();
    expect(result.cutSegmentIds).toEqual([]);
    expect(p.cutRanges).toEqual([]);
    expect(p.segments.list()).toHaveLength(1);
  });

  it('persists cutRanges across save/reopen', async () => {
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
    expect(reopened.cutRanges).toEqual([{ start: 10, end: 20 }]);
    expect(reopened.getEffectiveDuration()).toBe(90);
  });

  it('revertRipple removes a cut and restores effective duration', async () => {
    const bus = new EventBus();
    const pm = new ProjectManager(bus);
    const p = await pm.openProject({ videoPath: 'x.mp4', videoMeta: makeMeta() });
    p.segments.add({ start: 10, end: 20, source: 'human' });
    p.commitRipple();
    expect(p.cutRanges).toHaveLength(1);

    const ok = p.revertRipple(10, 20);
    expect(ok).toBe(true);
    expect(p.cutRanges).toEqual([]);
    expect(p.getEffectiveDuration()).toBe(100);
  });
});
