/**
 * Social copywriter (文案 tab): generate / read / edit / delete copies +
 * style-note / style-preset CRUD.
 *
 * The two private helpers below assemble the source text the copywriter
 * prompts feed on. They live here (not in core) because we want to keep
 * the engine free of file-system concerns and the assembly format is
 * UI-policy, not domain logic.
 */

import { ipcMain } from 'electron';
import { type SocialPlatform } from '@lynlens/core';
import { runCopywriterViaCurrentProvider } from '../agent-dispatcher';
import type { IpcContext } from './_context';

/**
 * Assemble transcript text for a given source. We keep the two
 * helpers private to this handler so core stays pure and the
 * file-system-free shape of the engine isn't disturbed.
 */
function assembleRippledSourceText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  cutRanges: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const t of transcriptSegs) {
    const fullyInCut = cutRanges.some((c) => t.start >= c.start && t.end <= c.end);
    if (fullyInCut) continue;
    const txt = t.text.trim();
    if (txt) lines.push(txt);
  }
  return lines.join('\n');
}

function assembleVariantSourceText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  variantSegs: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const v of variantSegs) {
    for (const t of transcriptSegs) {
      if (t.end <= v.start || t.start >= v.end) continue;
      const txt = t.text.trim();
      if (txt) lines.push(txt);
    }
  }
  return lines.join('\n');
}

export function registerSocialIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle(
    'generate-social-copies',
    async (
      _ev,
      projectId: string,
      opts: {
        sourceType: 'rippled' | 'variant';
        sourceVariantId?: string;
        platforms: SocialPlatform[];
        userStyleNote?: string;
      }
    ) => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕后再生成文案');
      }

      let sourceTitle: string;
      let sourceText: string;
      if (opts.sourceType === 'variant') {
        if (!opts.sourceVariantId) {
          throw new Error('sourceType=variant 时必须提供 sourceVariantId');
        }
        const variant = project.findHighlightVariant(opts.sourceVariantId);
        if (!variant) {
          throw new Error(`找不到变体 ${opts.sourceVariantId}`);
        }
        sourceTitle = `高光变体：${variant.title}`;
        sourceText = assembleVariantSourceText(project.transcript.segments, variant.segments);
      } else {
        sourceTitle = '粗剪完整版';
        sourceText = assembleRippledSourceText(project.transcript.segments, project.cutRanges);
      }

      if (!sourceText.trim()) {
        throw new Error('拼装出来的源文本为空,请先完成字幕和剪辑');
      }

      // Per-platform calls in parallel. allSettled lets us surface partial
      // successes — one platform hiccup shouldn't wipe out the others.
      const results = await Promise.allSettled(
        opts.platforms.map((platform) =>
          runCopywriterViaCurrentProvider({
            sourceTitle,
            sourceText,
            platform,
            userStyleNote: opts.userStyleNote ?? project.socialStyleNote ?? undefined,
          })
        )
      );

      const copies: Array<{
        id: string;
        platform: string;
        title: string;
        body: string;
        hashtags: string[];
      }> = [];
      const failures: Array<{ platform: SocialPlatform; error: string }> = [];
      let model: string | undefined;

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          if (r.value.model) model = r.value.model;
          copies.push({
            id: r.value.copy.id,
            platform: r.value.copy.platform,
            title: r.value.copy.title,
            body: r.value.copy.body,
            hashtags: r.value.copy.hashtags,
          });
        } else {
          failures.push({
            platform: opts.platforms[i],
            error: (r.reason as Error).message,
          });
        }
      }

      if (copies.length === 0) {
        throw new Error(
          '全部平台都生成失败:\n' +
            failures.map((f) => `${f.platform}: ${f.error}`).join('\n')
        );
      }

      const setId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const createdAt = new Date().toISOString();
      project.addSocialCopySet({
        id: setId,
        sourceType: opts.sourceType,
        sourceVariantId: opts.sourceVariantId,
        sourceTitle,
        sourceText,
        userStyleNote: opts.userStyleNote ?? null,
        copies,
        createdAt,
        model,
      });

      // Persist immediately so a crash before Ctrl+S doesn't lose the copy.
      if (project.projectPath) {
        await engine.projects.saveProject(projectId);
      }

      return {
        setId,
        copies,
        failures,
      };
    }
  );

  ipcMain.handle('get-social-copies', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).socialCopies;
  });

  ipcMain.handle(
    'update-social-copy',
    async (
      _ev,
      projectId: string,
      setId: string,
      copyId: string,
      patch: { title?: string; body?: string; hashtags?: string[] }
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateSocialCopy(setId, copyId, patch);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'delete-social-copy',
    async (_ev, projectId: string, setId: string, copyId: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.deleteSocialCopy(setId, copyId);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'delete-social-copy-set',
    async (_ev, projectId: string, setId: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.deleteSocialCopySet(setId);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'set-social-style-note',
    async (_ev, projectId: string, note: string | null) => {
      const project = engine.projects.get(projectId);
      project.setSocialStyleNote(note);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
    }
  );

  ipcMain.handle(
    'add-social-style-preset',
    async (_ev, projectId: string, name: string, content: string) => {
      const project = engine.projects.get(projectId);
      const preset = project.addSocialStylePreset(name, content);
      if (project.projectPath) await engine.projects.saveProject(projectId);
      return preset;
    }
  );

  ipcMain.handle(
    'update-social-style-preset',
    async (
      _ev,
      projectId: string,
      presetId: string,
      patch: { name?: string; content?: string }
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateSocialStylePreset(presetId, patch);
      if (ok && project.projectPath) await engine.projects.saveProject(projectId);
      return ok;
    }
  );

  ipcMain.handle(
    'delete-social-style-preset',
    async (_ev, projectId: string, presetId: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.deleteSocialStylePreset(presetId);
      if (ok && project.projectPath) await engine.projects.saveProject(projectId);
      return ok;
    }
  );

  ipcMain.handle('get-social-style-presets', async (_ev, projectId: string) => {
    return engine.projects.get(projectId).socialStylePresets;
  });
}
