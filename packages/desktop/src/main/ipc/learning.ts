/**
 * Learning memory IPC handlers — surface LynLens's persistent learning state
 * to the renderer (status banner, manage panel) and to MCP-aware agents.
 *
 * Agent-side equivalents live in `agent-tools/learning.ts`. The two layers
 * are intentionally parallel: anything the renderer can do, the agent can
 * also do. UI ↔ agent symmetry is the whole point of the learning system —
 * users get a learning loop whether they click buttons or chat.
 */

import { ipcMain, dialog } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { promises as fsp } from 'node:fs';
import type { IpcContext } from './_context';

/** Default location of the `wilon@subtitle-craft` skill's memory file. */
function defaultSkillMemoryPath(): string {
  return path.join(
    os.homedir(),
    '.claude',
    'skills',
    'wilon@subtitle-craft',
    'learning-memory.json'
  );
}

export function registerLearningIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle('learning-get-snapshot', async () => {
    return engine.learningMemory.snapshot();
  });

  /**
   * Full dump — used by the "manage" dialog so the user can browse + delete
   * individual entries. Snapshot only returns top-5 recents; this returns
   * everything. May get large with heavy use; if it ever becomes a problem
   * add pagination here.
   */
  ipcMain.handle('learning-get-all', async () => {
    return {
      autoCorrections: engine.learningMemory.getAutoCorrections(),
      properNouns: engine.learningMemory.getProperNouns(),
      keepOriginal: engine.learningMemory.getKeepOriginal(),
      correctionLog: engine.learningMemory.getCorrectionLog(),
    };
  });

  ipcMain.handle(
    'learning-forget',
    async (_ev, kind: 'correction' | 'noun' | 'keep', key: string) => {
      return engine.learningMemory.forget(kind, key);
    }
  );

  ipcMain.handle('learning-reset', async () => {
    await engine.learningMemory.reset();
  });

  /**
   * Force-promote a pending correction to auto-correction (skips the
   * count-3 threshold). Backs the "应用" button on each pending row in
   * the learning popover — user has decided this correction is right,
   * they don't want to wait for two more confirmations.
   */
  ipcMain.handle('learning-promote', async (_ev, from: string, to: string) => {
    await engine.learningMemory.addAutoCorrection(from, to);
  });

  /**
   * One-time import from the wilon@subtitle-craft skill's memory file.
   * If `jsonPath` is omitted we try the default skill location; if that
   * doesn't exist we pop a file picker so the user can point us at it.
   *
   * Returns counts of NEW entries actually added (existing keys skipped),
   * or null if the user cancelled the picker.
   */
  ipcMain.handle(
    'learning-import-skill',
    async (
      _ev,
      jsonPath?: string
    ): Promise<{ autoCorrections: number; properNouns: number; keepOriginal: number } | null> => {
      let target = jsonPath;
      if (!target) {
        const defaultPath = defaultSkillMemoryPath();
        try {
          await fsp.access(defaultPath);
          target = defaultPath;
        } catch {
          // Default not found — fall through to file picker.
        }
      }
      if (!target) {
        const result = await dialog.showOpenDialog(ctx.getMainWindow()!, {
          title: '选择 skill 的 learning-memory.json',
          defaultPath: path.join(os.homedir(), '.claude', 'skills'),
          filters: [{ name: 'JSON', extensions: ['json'] }],
          properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        target = result.filePaths[0];
      }
      return engine.learningMemory.importFromSkill(target);
    }
  );
}
