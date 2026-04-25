/**
 * Full-project export (transcoded + ripple-aware) and the waveform
 * extraction the renderer uses to draw the timeline. Highlight-variant
 * fast-mode export lives in `highlights.ts` because it's tied to that
 * domain's data model.
 */

import { ipcMain } from 'electron';
import { extractWaveform } from '@lynlens/core';
import type { ExportRequest } from '../../shared/ipc-types';
import type { IpcContext } from './_context';

export function registerExportIpc(ctx: IpcContext): void {
  const { engine, activeExports } = ctx;

  ipcMain.handle('get-waveform', async (_ev, projectId: string, _buckets: number) => {
    const project = engine.projects.get(projectId);
    // Adaptive bucket count: ~500 buckets/sec (2ms precision) for sharp zoom detail.
    // Capped so very long videos stay under ~4 MB of Float32 data.
    const duration = project.videoMeta.duration || 60;
    const buckets = Math.min(1_000_000, Math.max(8000, Math.round(duration * 500)));
    const env = await extractWaveform(project.videoPath, buckets, engine.ffmpegPaths);
    return { peak: Array.from(env.peak), rms: Array.from(env.rms) };
  });

  ipcMain.handle('export', async (_ev, req: ExportRequest) => {
    const project = engine.projects.get(req.projectId);
    const existing = activeExports.get(req.projectId);
    if (existing) existing.abort();
    const ac = new AbortController();
    activeExports.set(req.projectId, ac);
    try {
      const result = await engine.exports.export(project, {
        outputPath: req.outputPath,
        mode: req.mode,
        quality: req.quality,
        signal: ac.signal,
        // CRITICAL: forward the bundled ffmpeg binary. Without this, export
        // tries literal 'ffmpeg' from PATH and ENOENTs on machines without
        // system ffmpeg installed. Probe works even without this because
        // probeVideo already threads engine.ffmpegPaths through its own IPC.
        ffmpegPaths: engine.ffmpegPaths,
      });
      return result;
    } finally {
      activeExports.delete(req.projectId);
    }
  });

  ipcMain.handle('cancel-export', async (_ev, projectId: string) => {
    const ac = activeExports.get(projectId);
    if (ac) ac.abort();
  });
}
