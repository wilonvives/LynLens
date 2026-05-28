/**
 * Full-project export (transcoded + ripple-aware) and the waveform
 * extraction the renderer uses to draw the timeline. Highlight-variant
 * fast-mode export lives in `highlights.ts` because it's tied to that
 * domain's data model.
 */

import path from 'node:path';
import { app, ipcMain } from 'electron';
import { extractWaveform } from '@lynlens/core';
import type { ExportRequest } from '../../shared/ipc-types';
import type { IpcContext } from './_context';

/**
 * Resolve a renderer-supplied export path. Bare filenames + relative
 * paths land in ~/Downloads instead of process.cwd() (which in dev is
 * `packages/desktop/` — users would never look there). Absolute paths
 * pass through unchanged.
 */
function resolveExportOutputPath(outputPath: string): string {
  let resolved: string;
  if (path.isAbsolute(outputPath)) {
    resolved = outputPath;
  } else if (!outputPath.includes(path.sep) && !outputPath.includes('/')) {
    resolved = path.join(app.getPath('downloads'), outputPath);
  } else {
    resolved = path.resolve(app.getPath('home'), outputPath);
  }
  // Strip characters illegal in (Windows) filenames from the basename so
  // ffmpeg can always open the output ("?", ":" etc. → space). Directory is
  // left alone (a drive's "C:" is legitimate).
  const dir = path.dirname(resolved);
  const base = path
    .basename(resolved)
    .replace(/[<>:"/\\|?* -]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return path.join(dir, base || 'output.mp4');
}

export function registerExportIpc(ctx: IpcContext): void {
  const { engine, activeExports } = ctx;

  // Expose the OS Downloads dir so the renderer can show a sensible
  // default path before the user picks one — avoids the "exported,
  // but where did it go?" footgun.
  ipcMain.handle('get-downloads-dir', async () => app.getPath('downloads'));

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
        outputPath: resolveExportOutputPath(req.outputPath),
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
