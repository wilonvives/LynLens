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
  buildPackagingSystemPrompt,
  buildPackagingUserPrompt,
  parseHighlightResponse,
  parsePackagingPlanResponse,
  transcriptToPromptSegments,
  type HighlightStyle,
  type PackagingPlan,
  type PackagingVibe,
} from '@lynlens/core';
import { runOneShotViaCurrentProvider } from '../agent-dispatcher';
import { renderPackagingPlan } from '../render/remotion-render';
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

  /**
   * Create a fresh empty variant the user will fill in via the timeline
   * editor. Powers the "自定义" button next to "重新生成" in the highlight
   * header. Seed segment is centred on `hintSec` (typically the current
   * playhead) or starts at 0 if unspecified. Auto-pinned so it survives
   * "重新生成" wiping the AI batch.
   */
  ipcMain.handle(
    'add-blank-highlight-variant',
    async (_ev, projectId: string, hintSec: number | null, title?: string) => {
      const project = engine.projects.get(projectId);
      const variant = project.addBlankHighlightVariant(hintSec, title);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return variant;
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

  /**
   * AI-driven 一键包装. Reads variant (or full transcript when variantId
   * is null) + current vibe, asks Claude to output a PackagingPlan, parses
   * it tolerant-style, stores on the project, auto-saves to .qcp. Returns
   * the new plan for the renderer to apply immediately.
   *
   * The agent counterpart (MCP tool) wraps THIS handler — UI and agent
   * share one implementation so behaviour stays consistent.
   */
  ipcMain.handle(
    'generate-packaging-plan',
    async (
      _ev,
      projectId: string,
      variantId: string | null,
      vibe: PackagingVibe = 'default'
    ): Promise<PackagingPlan> => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕后再做一键包装');
      }
      // Determine which transcript segments to include in the prompt:
      // - variantId === null  → whole transcript (full-video packaging)
      // - variantId provided  → only the segments inside the variant.
      //   variants store source-time ranges, transcript segments also do,
      //   so we filter transcript segments that fall inside ANY variant
      //   segment's [start, end].
      const variant = variantId
        ? project.findHighlightVariant(variantId)
        : null;
      if (variantId && !variant) {
        throw new Error(`找不到高光变体: ${variantId}`);
      }
      let promptSegments: ReturnType<typeof transcriptToPromptSegments>;
      let segmentCount: number;
      if (variant) {
        const indices: number[] = [];
        project.transcript.segments.forEach((seg, i) => {
          for (const v of variant.segments) {
            if (seg.start >= v.start && seg.end <= v.end) {
              indices.push(i);
              break;
            }
          }
        });
        promptSegments = transcriptToPromptSegments(project.transcript, indices);
        segmentCount = project.transcript.segments.length;
      } else {
        promptSegments = transcriptToPromptSegments(project.transcript);
        segmentCount = project.transcript.segments.length;
      }

      const orientation: 'portrait' | 'landscape' | 'unknown' =
        project.userOrientation ?? 'unknown';
      const totalDurationSec = variant
        ? variant.durationSeconds
        : project.videoMeta.duration;
      const title = variant?.title ?? '原片';

      const systemPrompt = buildPackagingSystemPrompt();
      const userPrompt = buildPackagingUserPrompt({
        title,
        totalDurationSec,
        orientation,
        segments: promptSegments,
        vibe,
      });
      const { text, model } = await runOneShotViaCurrentProvider(
        systemPrompt,
        userPrompt
      );
      const plan = parsePackagingPlanResponse(text, variantId, segmentCount, model);
      project.setPackagingPlan(plan);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return plan;
    }
  );

  /** Read the current packaging plan for a variant (or root). */
  ipcMain.handle(
    'get-packaging-plan',
    async (_ev, projectId: string, variantId: string | null) => {
      const project = engine.projects.get(projectId);
      return project.getPackagingPlan(variantId) ?? null;
    }
  );

  /**
   * Replace the packaging plan (used by microedit panel: user changes a
   * color / zoom and we round-trip the modified plan back).
   */
  ipcMain.handle(
    'set-packaging-plan',
    async (_ev, projectId: string, plan: PackagingPlan) => {
      const project = engine.projects.get(projectId);
      project.setPackagingPlan(plan);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
    }
  );

  /** Discard a packaging plan — variant export reverts to ffmpeg fast path. */
  ipcMain.handle(
    'clear-packaging-plan',
    async (_ev, projectId: string, variantId: string | null) => {
      const project = engine.projects.get(projectId);
      const ok = project.clearPackagingPlan(variantId);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  ipcMain.handle(
    'export-highlight',
    async (
      _ev,
      projectId: string,
      variantId: string,
      outputPath: string,
      // Optional — defaults match the v0.4.1 behaviour so existing
      // callers (MCP tools, old renderer code) keep working. New renderer
      // sends the user's pick from the shared ExportDialog so the two
      // tabs encode with the same parameters.
      mode: 'precise' = 'precise',
      quality: 'original' | 'high' | 'medium' | 'low' = 'original'
    ) => {
      const project = engine.projects.get(projectId);
      const variant = project.findHighlightVariant(variantId);
      if (!variant) throw new Error(`Highlight variant not found: ${variantId}`);
      const existing = activeExports.get(projectId);
      if (existing) existing.abort();
      const ac = new AbortController();
      activeExports.set(projectId, ac);

      // Dispatch: does this variant have a packaging plan?
      //   YES → Remotion path (Player-WYSIWYG render, slower, rich visuals)
      //   NO  → existing ffmpeg path (fast cut/concat, no visual effects)
      const plan = project.getPackagingPlan(variantId);
      const startMs = Date.now();
      try {
        if (plan) {
          // Stream progress as 'export.progress' events so the existing
          // ExportDialog progress UI works without changes.
          engine.eventBus.emit({
            type: 'export.started',
            projectId,
            mode: 'precise',
            outputPath,
          });
          // Flatten to per-transcript-line segments so subtitles change
          // at the right cadence (one subtitle per sentence, not "all
          // subtitles in this 35s variant chunk shown at once"). Use the
          // original transcript indices for `segmentIdx` so the recipe
          // lookup in PackagingComposition can find each segment's
          // packaging plan via the transcript-relative index Claude saw.
          const renderSegments: Array<{
            start: number;
            end: number;
            text: string;
            segmentIdx: number;
          }> = [];
          (project.transcript?.segments ?? []).forEach((t, i) => {
            for (const v of variant.segments) {
              if (t.start >= v.start && t.end <= v.end) {
                renderSegments.push({
                  start: t.start,
                  end: t.end,
                  text: t.text,
                  segmentIdx: i,
                });
                break;
              }
            }
          });
          await renderPackagingPlan({
            videoPath: project.videoPath,
            segments: renderSegments,
            plan,
            width: project.videoMeta.width,
            height: project.videoMeta.height,
            fps: project.videoMeta.fps,
            outputPath,
            quality,
            signal: ac.signal,
            onProgress: (frac, stage) => {
              engine.eventBus.emit({
                type: 'export.progress',
                projectId,
                percent: frac * 100,
                stage,
              });
            },
          });
          const { statSync } = await import('node:fs');
          const sizeBytes = (() => {
            try {
              return statSync(outputPath).size;
            } catch {
              return 0;
            }
          })();
          engine.eventBus.emit({
            type: 'export.completed',
            projectId,
            outputPath,
            sizeBytes,
          });
          return {
            outputPath,
            sizeBytes,
            durationMs: Date.now() - startMs,
            mode,
            quality,
          };
        }
        // No plan → fall back to the proven ffmpeg pipeline (unchanged
        // from v0.4.x). Same engine call as precision tab's `export` IPC
        // but with keepOverride for variant segments.
        const keepOverride = variant.segments.map((s) => ({
          start: s.start,
          end: s.end,
        }));
        return await engine.exports.export(project, {
          outputPath,
          mode,
          quality,
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
