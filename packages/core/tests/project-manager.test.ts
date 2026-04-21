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
});
