/**
 * Agent BrowserWindow lifecycle: open / focus / pin / active-project
 * tracking. The actual window construction lives in `index.ts`
 * (`createAgentWindow`) because it depends on the dev-vs-packaged URL
 * decision; we just expose the IPC surface here.
 */

import { ipcMain } from 'electron';
import type { IpcContext } from './_context';

export function registerAgentWindowIpc(ctx: IpcContext): void {
  const { getAgentWindow, getActiveProjectId, setActiveProjectId, broadcast, createAgentWindow } = ctx;

  ipcMain.handle('open-agent-window', async () => {
    createAgentWindow();
  });

  ipcMain.handle('agent-get-active-project-id', async () => getActiveProjectId());

  ipcMain.handle('agent-set-active-project-id', async (_ev, pid: string | null) => {
    if (getActiveProjectId() === pid) return;
    setActiveProjectId(pid);
    // Broadcast so the popup (or any other window) re-targets its chat.
    broadcast('active-project-changed', pid);
  });

  ipcMain.handle('agent-window-set-pinned', async (_ev, pinned: boolean) => {
    const w = getAgentWindow();
    if (!w || w.isDestroyed()) return;
    // `screen-saver` level keeps the window above most apps including
    // fullscreen ones; plain `true` defaults to `floating` which some
    // macOS full-screen apps can still cover. For a chat popup that
    // should stay visible while the user browses other tools, the extra
    // aggressive level matches the stated intent of "置顶".
    w.setAlwaysOnTop(pinned, 'screen-saver');
  });

  ipcMain.handle('agent-window-get-pinned', async () => {
    const w = getAgentWindow();
    if (!w || w.isDestroyed()) return false;
    return w.isAlwaysOnTop();
  });
}
