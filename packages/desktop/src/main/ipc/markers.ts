/**
 * Timeline markers — Premiere-style bookmarks the user places via the
 * M shortcut. CRUD wraps the typed methods on Project; every successful
 * mutation triggers a project autosave so markers survive crashes.
 */

import { ipcMain } from 'electron';
import type { IpcContext } from './_context';

export function registerMarkersIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle('list-markers', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).markers;
  });

  /**
   * Add a marker at the given source-time. Returns the new marker so
   * the renderer can stage optimistic state without re-fetching the
   * full list. Project autosave is async-fire-and-forget for snappy UX.
   */
  ipcMain.handle(
    'add-marker',
    async (
      _ev,
      projectId: string,
      srcSec: number,
      label?: string,
      color?: string
    ) => {
      const project = engine.projects.get(projectId);
      const m = project.addMarker(srcSec, label, color);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return m;
    }
  );

  ipcMain.handle(
    'move-marker',
    async (_ev, projectId: string, id: string, newSrcSec: number) => {
      const project = engine.projects.get(projectId);
      const ok = project.moveMarker(id, newSrcSec);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'remove-marker',
    async (_ev, projectId: string, id: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.removeMarker(id);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'update-marker',
    async (
      _ev,
      projectId: string,
      id: string,
      patch: { label?: string | null; color?: string | null }
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateMarker(id, patch);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );
}
