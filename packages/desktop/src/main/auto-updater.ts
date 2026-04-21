/**
 * Auto-update glue.
 *
 * On startup (production builds only), check GitHub Releases for a newer
 * version. When one is found it is downloaded in the background and installed
 * on next quit. The user sees a native dialog confirming the restart.
 *
 * Local dev builds (LYNLENS_DEV=1) skip this entirely — electron-updater
 * requires a signed/published release to function.
 */
import { app, dialog, BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export function setupAutoUpdater(mainWindow: BrowserWindow | null): void {
  if (process.env.LYNLENS_DEV === '1' || !app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[auto-updater]', err);
  });

  autoUpdater.on('update-available', (info) => {
    // eslint-disable-next-line no-console
    console.log('[auto-updater] update available:', info.version);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const res = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['现在重启安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '有新版本可用',
      message: `LynLens ${info.version} 已下载完成`,
      detail: '重启 LynLens 即可安装新版。你的工程不会丢失。',
    });
    if (res.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  // Check immediately on launch, then every 4 hours while the app is running.
  void autoUpdater.checkForUpdates();
  setInterval(() => {
    void autoUpdater.checkForUpdates();
  }, 4 * 60 * 60 * 1000);
}
