/**
 * Project-scoped settings: orientation hint + preview rotation override.
 * Both are persisted immediately so they survive app restarts even if the
 * user never hits Ctrl+S.
 */

import { ipcMain } from 'electron';
import type { IpcContext } from './_context';

export function registerSettingsIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle(
    'set-user-orientation',
    async (_ev, projectId: string, o: 'landscape' | 'portrait' | null) => {
      engine.projects.get(projectId).setUserOrientation(o);
    }
  );

  ipcMain.handle(
    'set-preview-rotation',
    async (_ev, projectId: string, rotation: 0 | 90 | 180 | 270) => {
      const project = engine.projects.get(projectId);
      project.setPreviewRotation(rotation);
      // Persist immediately so the rotation survives app restarts even if
      // the user never hits Ctrl+S.
      if (project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
    }
  );
}
