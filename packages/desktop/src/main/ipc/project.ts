/**
 * Project lifecycle: open / save / state / dialogs.
 *
 * Module-private helpers (`toMediaUrl`, `openProjectFromQcpPath`) live here
 * because nothing outside this domain consumes them.
 */

import { dialog, ipcMain } from 'electron';
import path from 'node:path';
import { existsSync, promises as fsp } from 'node:fs';
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

  /**
   * Ask the user to relocate a project's source video when the linked file is
   * gone (moved / renamed / deleted). Returns the newly-picked absolute path,
   * or null if they cancel. Native dialogs so it works before any project
   * state exists.
   */
  async function promptRelinkVideo(missingPath: string): Promise<string | null> {
    const win = getMainWindow();
    if (!win) return null;
    const choice = await dialog.showMessageBox(win, {
      type: 'warning',
      title: '找不到原视频',
      message: '这个项目链接的原视频找不到了',
      detail:
        `项目记录的视频路径:\n${missingPath}\n\n` +
        '可能是文件被移动、改名或删除了。请重新选择这个视频文件来继续打开项目。',
      buttons: ['重新选择视频…', '取消'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice.response !== 0) return null;
    const missingDir = path.dirname(missingPath);
    const picked = await dialog.showOpenDialog(win, {
      title: '选择原视频文件',
      defaultPath: existsSync(missingDir) ? missingDir : undefined,
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return picked.filePaths[0];
  }

  /** Open a .qcp by path — used by both the dialog and drag-and-drop. */
  async function openProjectFromQcpPath(qcpPath: string) {
    const raw = await fsp.readFile(qcpPath, 'utf-8');
    const data = JSON.parse(raw) as { videoPath: string } & Record<string, unknown>;
    let videoPath = data.videoPath;

    // The .qcp stores an ABSOLUTE path to the original video. If that file is
    // gone (the user renamed / moved it), probing it with ffprobe would ENOENT
    // and the open would hard-fail with a raw error. Instead, detect it up front
    // and let the user relocate the file — then persist the new path into the
    // .qcp so the next open just works.
    if (!existsSync(videoPath)) {
      const relinked = await promptRelinkVideo(videoPath);
      if (!relinked) {
        // User cancelled — abort the open cleanly (renderer treats null as no-op).
        return null;
      }
      videoPath = relinked;
      data.videoPath = videoPath;
      // Safe to write before the watcher attaches (it's set up below), so this
      // can't trip the external-change reload.
      await fsp.writeFile(qcpPath, JSON.stringify(data, null, 2), 'utf-8');
    }

    const project = await engine.openFromVideo({ videoPath, projectPath: qcpPath });
    await attachProjectWatcher(project.id, qcpPath);
    return {
      projectId: project.id,
      videoMeta: project.videoMeta,
      videoPath,
      videoUrl: toMediaUrl(videoPath),
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

  /**
   * Folder picker — used by batch export to pick a destination directory.
   * Returns the absolute path, or null if the user cancelled.
   */
  ipcMain.handle('open-directory-dialog', async (_ev, defaultPath?: string) => {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || undefined,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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
