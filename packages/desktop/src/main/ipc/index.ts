/**
 * Single registration entry point. `main/index.ts` calls `registerAllIpc(ctx)`
 * once at app boot; all 71 IPC handlers wire themselves up in here.
 *
 * Adding a new handler:
 *   1. Find the right domain file (or create a new one for a new domain).
 *   2. Add the `ipcMain.handle(...)` call inside `registerXxxIpc`.
 *   3. If a new file: add a `registerXxxIpc(ctx)` call below.
 *
 * Never put `ipcMain.handle` calls back in `main/index.ts`.
 */

import type { IpcContext } from './_context';
import { registerProjectIpc } from './project';
import { registerSegmentsIpc } from './segments';
import { registerTranscriptIpc } from './transcript';
import { registerSpeakersIpc } from './speakers';
import { registerHighlightsIpc } from './highlights';
import { registerSocialIpc } from './social';
import { registerExportIpc } from './export';
import { registerAgentIpc } from './agent';
import { registerAgentWindowIpc } from './agent-window';
import { registerSettingsIpc } from './settings';

export type { IpcContext } from './_context';

export function registerAllIpc(ctx: IpcContext): void {
  registerProjectIpc(ctx);
  registerSegmentsIpc(ctx);
  registerTranscriptIpc(ctx);
  registerSpeakersIpc(ctx);
  registerHighlightsIpc(ctx);
  registerSocialIpc(ctx);
  registerExportIpc(ctx);
  registerAgentIpc(ctx);
  registerAgentWindowIpc(ctx);
  registerSettingsIpc(ctx);
}
