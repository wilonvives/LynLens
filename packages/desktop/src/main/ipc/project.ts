/**
 * Project lifecycle: open / save / state / dialogs.
 *
 * Module-private helpers (`toMediaUrl`, `openProjectFromQcpPath`) live here
 * because nothing outside this domain consumes them.
 */

import { dialog, ipcMain } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { IpcContext } from './_context';

/**
 * Build the custom-protocol URL that the renderer's `<video>` reads. We
 * percent-encode the whole absolute path so Chromium treats it as opaque
 * (otherwise "C:" gets parsed as host:port on Windows).
 */
function toMediaUrl(absPath: string): string {
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

export function registerProjectIpc(ctx: IpcContext): void {
  const { engine, getMainWindow, qcpPathForVideo, attachProjectWatcher, markInternalSave } = ctx;

  /** Open a .qcp by path — used by both the dialog and drag-and-drop. */
  async function openProjectFromQcpPath(qcpPath: string) {
    const raw = await fsp.readFile(qcpPath, 'utf-8');
    const parsed = JSON.parse(raw) as { videoPath: string };
    const project = await engine.openFromVideo({
      videoPath: parsed.videoPath,
      projectPath: qcpPath,
    });
    await attachProjectWatcher(project.id, qcpPath);
    return {
      projectId: project.id,
      videoMeta: project.videoMeta,
      videoPath: parsed.videoPath,
      videoUrl: toMediaUrl(parsed.videoPath),
    };
  }

  ipcMain.handle('open-video-dialog', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const videoPath = result.filePaths[0];
    // Detect existing <video>.qcp sidecar and load it if present
    const qcpPath = qcpPathForVideo(videoPath);
    let existingQcp: string | undefined;
    try {
      await fsp.access(qcpPath);
      existingQcp = qcpPath;
    } catch { /* no existing sidecar */ }
    const project = await engine.openFromVideo({ videoPath, projectPath: existingQcp });
    await attachProjectWatcher(project.id, qcpPath);
    return {
      projectId: project.id,
      videoMeta: project.videoMeta,
      videoPath,
      videoUrl: toMediaUrl(videoPath),
    };
  });

  ipcMain.handle('open-video-by-path', async (_ev, videoPath: string) => {
    const qcpPath = qcpPathForVideo(videoPath);
    let existingQcp: string | undefined;
    try {
      await fsp.access(qcpPath);
      existingQcp = qcpPath;
    } catch { /* no existing sidecar */ }
    const project = await engine.openFromVideo({ videoPath, projectPath: existingQcp });
    await attachProjectWatcher(project.id, qcpPath);
    return {
      projectId: project.id,
      videoMeta: project.videoMeta,
      videoPath,
      videoUrl: toMediaUrl(videoPath),
    };
  });

  ipcMain.handle('open-project-dialog', async () => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openFile'],
      filters: [{ name: 'LynLens Project', extensions: ['qcp'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return openProjectFromQcpPath(result.filePaths[0]);
  });

  ipcMain.handle('open-project-by-path', async (_ev, qcpPath: string) => {
    // Used by drag-and-drop: user dropped a .qcp file onto the app. Same code
    // path as the menu dialog, just skips the native file picker.
    return openProjectFromQcpPath(qcpPath);
  });

  ipcMain.handle('save-dialog', async (_ev, defaultName: string) => {
    const result = await dialog.showSaveDialog(getMainWindow()!, {
      defaultPath: defaultName,
      filters: [{ name: 'Video', extensions: ['mp4', 'mov'] }],
    });
    if (result.canceled || !result.filePath) return null;
    return result.filePath;
  });

  ipcMain.handle('get-state', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).toQcp();
  });

  ipcMain.handle('save-project', async (_ev, projectId: string, outputPath?: string) => {
    let target = outputPath;
    if (!target) {
      const project = engine.projects.get(projectId);
      const defaultName =
        path.basename(project.videoPath, path.extname(project.videoPath)) + '.qcp';
      const result = await dialog.showSaveDialog(getMainWindow()!, {
        defaultPath: defaultName,
        filters: [{ name: 'LynLens Project', extensions: ['qcp'] }],
      });
      if (result.canceled || !result.filePath) throw new Error('Save canceled');
      target = result.filePath;
    }
    markInternalSave(projectId);
    return engine.projects.saveProject(projectId, target);
  });

  /**
   * Forwards the conventional .qcp path for the current project so the UI can
   * build a "copy-paste to Claude Code" command referencing it.
   */
  ipcMain.handle('get-qcp-path', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    return project.projectPath ?? qcpPathForVideo(project.videoPath);
  });

  /**
   * Ensure the current project is persisted to its .qcp sidecar (so Claude /
   * MCP can read it). Used by the UI's "交给 Claude" button.
   */
  ipcMain.handle('flush-project', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    const target = project.projectPath ?? qcpPathForVideo(project.videoPath);
    markInternalSave(projectId);
    await engine.projects.saveProject(projectId, target);
    return target;
  });
}
