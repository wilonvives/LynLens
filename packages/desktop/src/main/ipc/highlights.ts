/**
 * Highlight variant lifecycle: generate (LLM) / read / clear / pin /
 * delete / segment-level edit / export-to-video.
 *
 * The export path here is fast-mode-only (stream copy of the variant's
 * keep ranges). Full transcoded export of the rippled timeline lives in
 * `export.ts`.
 */

import { ipcMain } from 'electron';
import {
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  parseHighlightResponse,
  type HighlightStyle,
} from '@lynlens/core';
import { runOneShotViaCurrentProvider } from '../agent-dispatcher';
import type { IpcContext } from './_context';

export function registerHighlightsIpc(ctx: IpcContext): void {
  const { engine, activeExports } = ctx;

  ipcMain.handle(
    'generate-highlights',
    async (
      _ev,
      projectId: string,
      opts: { style: HighlightStyle; count: number; targetSeconds: number }
    ) => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕后再生成高光变体');
      }
      const effectiveDuration = project.getEffectiveDuration();
      const systemPrompt = buildHighlightSystemPrompt();
      const userPrompt = buildHighlightUserPrompt({
        transcript: project.transcript,
        cutRanges: project.cutRanges,
        effectiveDuration,
        style: opts.style,
        count: Math.max(1, Math.min(5, Math.floor(opts.count || 1))),
        targetSeconds: Math.max(5, Math.floor(opts.targetSeconds || 30)),
      });
      const { text, model } = await runOneShotViaCurrentProvider(systemPrompt, userPrompt);
      // Force every variant's style to the user-selected one — matches the
      // UX contract (one style in, N variants all in that style out).
      const variants = parseHighlightResponse(text, project.cutRanges, model, opts.style);
      // setHighlightVariants preserves pinned variants from the previous
      // batch and stamps a sourceSnapshot onto each new variant. Auto-save
      // so the .qcp on disk stays in sync (user may crash before manual save).
      project.setHighlightVariants(variants);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return project.highlightVariants;
    }
  );

  ipcMain.handle('get-highlights', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    return project.highlightVariants;
  });

  ipcMain.handle('clear-highlights', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    project.clearHighlightVariants();
    if (project.projectPath) {
      await engine.projects.saveProject(projectId).catch(() => {});
    }
  });

  ipcMain.handle(
    'set-highlight-pinned',
    async (_ev, projectId: string, variantId: string, pinned: boolean) => {
      const project = engine.projects.get(projectId);
      const ok = project.setHighlightVariantPinned(variantId, pinned);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'delete-highlight-variant',
    async (_ev, projectId: string, variantId: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.deleteHighlightVariant(variantId);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'update-highlight-variant-segment',
    async (
      _ev,
      projectId: string,
      variantId: string,
      segmentIdx: number,
      newStart: number,
      newEnd: number,
      newReason?: string
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateHighlightVariantSegment(
        variantId,
        segmentIdx,
        newStart,
        newEnd,
        newReason
      );
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'reorder-highlight-variant-segment',
    async (_ev, projectId: string, variantId: string, fromIdx: number, toIdx: number) => {
      const project = engine.projects.get(projectId);
      const ok = project.reorderHighlightVariantSegment(variantId, fromIdx, toIdx);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'add-highlight-variant-segment',
    async (_ev, projectId: string, variantId: string, hintSec: number | null) => {
      const project = engine.projects.get(projectId);
      const slot = project.findHighlightInsertSlot(
        variantId,
        hintSec ?? undefined
      );
      if (!slot) return null;
      const ok = project.addHighlightVariantSegment(
        variantId,
        slot.start,
        slot.end
      );
      if (!ok) return null;
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return slot;
    }
  );

  ipcMain.handle(
    'delete-highlight-variant-segment',
    async (_ev, projectId: string, variantId: string, segmentIdx: number) => {
      const project = engine.projects.get(projectId);
      const ok = project.deleteHighlightVariantSegment(variantId, segmentIdx);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'export-highlight',
    async (_ev, projectId: string, variantId: string, outputPath: string) => {
      const project = engine.projects.get(projectId);
      const variant = project.findHighlightVariant(variantId);
      if (!variant) throw new Error(`Highlight variant not found: ${variantId}`);
      const keepOverride = variant.segments.map((s) => ({ start: s.start, end: s.end }));
      const existing = activeExports.get(projectId);
      if (existing) existing.abort();
      const ac = new AbortController();
      activeExports.set(projectId, ac);
      try {
        // Single export pipeline now: frame-accurate cuts + color preserved.
        // The previous mode: 'fast' (stream copy) was removed in v0.4.1 —
        // it caused frame jumps at every cut and color shift on Windows.
        return await engine.exports.export(project, {
          outputPath,
          mode: 'precise',
          quality: 'original',
          signal: ac.signal,
          ffmpegPaths: engine.ffmpegPaths,
          keepOverride,
        });
      } finally {
        activeExports.delete(projectId);
      }
    }
  );
}
