/**
 * Segment lifecycle: add / remove / erase / resize / approve / reject /
 * undo / redo / approve-all / reject-all / commit-ripple / revert-ripple /
 * AI mark-silence (the only handler in this group that touches ffmpeg —
 * kept here because the resulting segments live in this domain).
 */

import { ipcMain } from 'electron';
import {
  detectFillers,
  detectRetakes,
  detectSilences,
  extractWaveform,
} from '@lynlens/core';
import type { AddSegmentRequest } from '../../shared/ipc-types';
import type { IpcContext } from './_context';

export function registerSegmentsIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle('add-segment', async (_ev, req: AddSegmentRequest) => {
    const project = engine.projects.get(req.projectId);
    return project.segments.add({
      start: req.start,
      end: req.end,
      source: req.source,
      reason: req.reason ?? null,
      confidence: req.confidence,
      aiModel: req.aiModel,
    });
  });

  ipcMain.handle('remove-segment', async (_ev, projectId: string, segmentId: string) => {
    const project = engine.projects.get(projectId);
    project.segments.remove(segmentId);
  });

  ipcMain.handle('erase-range', async (_ev, projectId: string, start: number, end: number) => {
    const project = engine.projects.get(projectId);
    project.segments.eraseRange(start, end);
  });

  ipcMain.handle(
    'resize-segment',
    async (_ev, projectId: string, segmentId: string, start: number, end: number) => {
      const project = engine.projects.get(projectId);
      return project.segments.resize(segmentId, start, end);
    }
  );

  ipcMain.handle('approve-segment', async (_ev, projectId: string, segmentId: string) => {
    engine.projects.get(projectId).segments.approve(segmentId);
  });

  ipcMain.handle('reject-segment', async (_ev, projectId: string, segmentId: string) => {
    engine.projects.get(projectId).segments.reject(segmentId);
  });

  ipcMain.handle('undo', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).segments.undo();
  });

  ipcMain.handle('redo', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).segments.redo();
  });

  ipcMain.handle(
    'ai-mark-silence',
    async (_ev, projectId: string, opts: { minPauseSec: number; silenceThreshold: number }) => {
      const project = engine.projects.get(projectId);
      const env = await extractWaveform(project.videoPath, 4000, engine.ffmpegPaths);
      const silences = detectSilences(env.peak, project.videoMeta.duration, opts);
      const ids: string[] = [];

      for (const s of silences) {
        const seg = project.segments.add({
          start: s.start,
          end: s.end,
          source: 'ai',
          reason: s.reason,
          confidence: 0.75,
          aiModel: 'builtin-silence-detector',
        });
        ids.push(seg.id);
      }

      // If the project has a transcript, also flag filler/hesitation words and
      // near-duplicate retakes. These complement the pure silence heuristic.
      let fillerCount = 0;
      let retakeCount = 0;
      if (project.transcript) {
        for (const f of detectFillers(project.transcript)) {
          const seg = project.segments.add({
            start: f.start,
            end: f.end,
            source: 'ai',
            reason: f.reason,
            confidence: f.confidence,
            aiModel: 'builtin-filler-detector',
          });
          ids.push(seg.id);
          fillerCount += 1;
        }
        for (const r of detectRetakes(project.transcript)) {
          const seg = project.segments.add({
            start: r.start,
            end: r.end,
            source: 'ai',
            reason: r.reason,
            confidence: r.confidence,
            aiModel: 'builtin-retake-detector',
          });
          ids.push(seg.id);
          retakeCount += 1;
        }
      }

      return {
        added: ids.length,
        segmentIds: ids,
        breakdown: {
          silences: silences.length,
          fillers: fillerCount,
          retakes: retakeCount,
        },
      };
    }
  );

  ipcMain.handle('approve-all-pending', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    const pending = project.segments.list().filter((s) => s.status === 'pending');
    for (const s of pending) project.segments.approve(s.id, 'human');
    return pending.length;
  });

  ipcMain.handle('reject-all-pending', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    const pending = project.segments.list().filter((s) => s.status === 'pending');
    for (const s of pending) project.segments.reject(s.id, 'human');
    return pending.length;
  });

  ipcMain.handle('commit-ripple', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    return project.commitRipple();
  });

  ipcMain.handle(
    'revert-ripple',
    async (_ev, projectId: string, segmentId: string) => {
      const project = engine.projects.get(projectId);
      return project.revertRipple(segmentId);
    }
  );
}
