/**
 * Highlight variant lifecycle: generate (LLM) / read / clear / pin /
 * delete / segment-level edit / export-to-video.
 *
 * The export path here is fast-mode-only (stream copy of the variant's
 * keep ranges). Full transcoded export of the rippled timeline lives in
 * `export.ts`.
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import {
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  buildPackagingSystemPrompt,
  buildPackagingUserPrompt,
  buildPreviewPlaylist,
  computeKeepIntervals,
  generatePackagingAss,
  parseHighlightResponse,
  parsePackagingPlanResponse,
  previewCacheKey,
  probeColorMeta,
  renderPackagingPreview,
  transcriptToPromptSegments,
  type AssPlaylistEntry,
  type ExportQuality,
  type ExportResult,
  type HighlightStyle,
  type PackagingPlan,
  type PackagingVibe,
  type PreviewPlaylistEntry,
  type Range,
  type VideoMeta,
} from '@lynlens/core';
import { runOneShotViaCurrentProvider } from '../agent-dispatcher';

/**
 * The encoded mp4's dimensions after the rotation filter in
 * export-service is applied. ASS PlayResX/Y must match these so
 * font sizes + positions land on the actual visible frame.
 */
function outputDimensions(meta: VideoMeta): { w: number; h: number } {
  const r = ((Math.round(meta.rotation ?? 0) % 360) + 360) % 360;
  if (r === 90 || r === 270) return { w: meta.height, h: meta.width };
  return { w: meta.width, h: meta.height };
}

/**
 * Resolve an export output path so a bare filename / relative path
 * lands in ~/Downloads instead of process.cwd() (which in dev is
 * `packages/desktop/`, where users would never look). Absolute paths
 * pass through unchanged.
 *
 * The user reported "I clicked export, it said success, but no file
 * exists where I expected" — the file was there, just under the dev
 * tree because the renderer hadn't called the saveDialog before
 * confirming. This makes the failure mode benign instead of mysterious.
 */
function resolveExportOutputPath(outputPath: string): string {
  if (path.isAbsolute(outputPath)) return outputPath;
  // No directory component → bare filename → Downloads/<name>.
  if (!outputPath.includes(path.sep) && !outputPath.includes('/')) {
    return path.join(app.getPath('downloads'), outputPath);
  }
  // Relative path with directory parts → resolve against home so e.g.
  // "Movies/foo.mp4" lands in $HOME/Movies/foo.mp4 rather than wherever
  // process.cwd() happens to be.
  return path.resolve(app.getPath('home'), outputPath);
}
// NOTE: renderPackagingPlan (Remotion-based export) is staged for v0.6+
// but disabled in v0.5 — preview is pure HTML overlay, export reverts
// to the ffmpeg pipeline (no packaged visuals baked in yet). Keeping
// the file + import path live so v0.6 can re-enable with one line.
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

  /**
   * Inline-rename a variant from the variant card. Empty / whitespace
   * titles are rejected (refuses to wipe the field). Returns the
   * accepted title so the renderer can sync optimistic state.
   */
  /**
   * Copy one segment from an existing variant out into its own new
   * variant. Source variant is untouched. Used by the "→ 新变体"
   * button in each segment row of the variant card. Returns the new
   * variant so the renderer can scroll/select it.
   */
  ipcMain.handle(
    'extract-highlight-segment',
    async (
      _ev,
      projectId: string,
      sourceVariantId: string,
      segmentIdx: number
    ) => {
      const project = engine.projects.get(projectId);
      const created = project.extractHighlightSegmentAsVariant(
        sourceVariantId,
        segmentIdx
      );
      if (!created) {
        throw new Error('无法提取(源变体不存在或段索引越界)');
      }
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return created;
    }
  );

  ipcMain.handle(
    'rename-highlight-variant',
    async (_ev, projectId: string, variantId: string, newTitle: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.renameHighlightVariant(variantId, newTitle);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return ok;
    }
  );

  /**
   * 🪄 enrich — ask Claude to look at the variant's segments + the
   * transcript text inside each one, then propose a punchy variant
   * title + per-segment one-line reason. Used to populate empty /
   * auto-named variants (e.g. "自定义 #1") with meaningful metadata.
   *
   * Throws when there's no transcript (AI has nothing to work with).
   * Otherwise returns the AI's proposal as { title, reasons } so the
   * renderer can show "✓ updated" feedback even if the user wants to
   * undo afterwards.
   */
  ipcMain.handle(
    'enrich-highlight-variant',
    async (_ev, projectId: string, variantId: string) => {
      const {
        buildEnrichSystemPrompt,
        buildEnrichUserPrompt,
        parseEnrichResponse,
      } = await import('@lynlens/core');
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('需要先生成字幕,AI 才有信息推断标题和段落备注。');
      }
      const variant = project.findHighlightVariant(variantId);
      if (!variant) throw new Error(`找不到变体: ${variantId}`);
      if (variant.segments.length === 0) {
        throw new Error('变体没有段落,无法 enrich。');
      }

      // Pull transcript text inside each variant segment so the AI can
      // see what's actually being said. Join word-boundary aware (CJK
      // has no spaces, English does — transcripts already encode this).
      const segInputs = variant.segments.map((s, segmentIdx) => {
        const inside: string[] = [];
        for (const t of project.transcript!.segments) {
          if (t.end <= s.start || t.start >= s.end) continue;
          const txt = t.text.trim();
          if (txt) inside.push(txt);
        }
        return {
          segmentIdx,
          start: s.start,
          end: s.end,
          existingReason: s.reason ?? '',
          transcriptText: inside.join(' '),
        };
      });

      const systemPrompt = buildEnrichSystemPrompt();
      const userPrompt = buildEnrichUserPrompt({
        currentTitle: variant.title,
        totalDurationSec: variant.durationSeconds,
        styleHint: variant.style,
        segments: segInputs,
      });
      const { text } = await runOneShotViaCurrentProvider(systemPrompt, userPrompt);
      const enrich = parseEnrichResponse(text, variant.segments.length);

      // Apply to project state in one shot (single autosave).
      const ok = project.enrichHighlightVariantMeta(
        variantId,
        enrich.title,
        enrich.reasons
      );
      if (!ok) throw new Error('应用 AI 建议失败 (变体已被删除?)');
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return enrich;
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

  /**
   * Add a segment with an EXPLICIT (start, end) range. Used by the
   * highlight timeline's shift+drag gesture so the user can paint a
   * new segment precisely, instead of relying on the 3-second
   * findInsertSlot guess. Source-time inputs (caller should convert
   * from effective via effectiveToSource before calling).
   *
   * Returns the (start, end) added, or null if validation failed
   * (MIN_DUR / out of bounds / variant not found).
   */
  ipcMain.handle(
    'add-highlight-variant-segment-range',
    async (
      _ev,
      projectId: string,
      variantId: string,
      startSec: number,
      endSec: number,
      reason?: string
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.addHighlightVariantSegment(
        variantId,
        startSec,
        endSec,
        reason || 'shift+拖动添加'
      );
      if (!ok) return null;
      if (project.projectPath) {
        await engine.projects.saveProject(projectId).catch(() => {});
      }
      return { start: startSec, end: endSec };
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

  /**
   * Render a continuous preview mp4 of a variant (or the whole source for
   * "整片"), cached by content hash. The 包装 tab plays this mp4 so the
   * timeline is the VARIANT's timeline (no seek-flicker between segments).
   *
   * Returns:
   *   - outputPath: absolute path of the cached preview mp4
   *   - playlist:   source↔preview time mapping so the subtitle overlay
   *                 can look up the right transcript segment by source time
   *   - durationSeconds: total preview duration
   *
   * First call for a new variant takes a few seconds (hardware-accelerated
   * h264_videotoolbox on macOS). Subsequent calls are instant (cache hit).
   * For 整片 with no cuts, this just returns the source path with a single
   * 1:1 playlist entry — no rendering needed.
   */
  ipcMain.handle(
    'prepare-packaging-preview',
    async (
      _ev,
      projectId: string,
      variantId: string | null
    ): Promise<{
      outputPath: string;
      playlist: PreviewPlaylistEntry[];
      durationSeconds: number;
      cached: boolean;
      thumbnails: string[];
    }> => {
      const project = engine.projects.get(projectId);
      const videoPath = project.videoPath;
      const videoMeta = project.videoMeta;

      // Determine the keep ranges. Variant → its segments in playback
      // order. 整片 → no rendering needed, return the source as-is with
      // a 1:1 playlist (subtitle overlay treats currentTime as source
      // time directly).
      let ranges: Range[];
      if (variantId) {
        const variant = project.findHighlightVariant(variantId);
        if (!variant) throw new Error(`找不到高光变体: ${variantId}`);
        if (variant.segments.length === 0) {
          throw new Error('变体没有片段,无法生成预览');
        }
        ranges = variant.segments.map((s) => ({ start: s.start, end: s.end }));
      } else {
        // 整片 mode — skip the render, point the player at the source.
        // No thumbnails returned for 整片 right now (would require an
        // extra ffmpeg pass on the source); v0.6+ can add that lazily.
        return {
          outputPath: videoPath,
          playlist: [
            {
              srcStart: 0,
              srcEnd: videoMeta.duration,
              variantStart: 0,
              variantEnd: videoMeta.duration,
            },
          ],
          durationSeconds: videoMeta.duration,
          cached: true,
          thumbnails: [],
        };
      }

      const cacheKey = previewCacheKey(videoPath, ranges);
      const colorMeta = await probeColorMeta(videoPath, engine.ffmpegPaths);
      const result = await renderPackagingPreview({
        videoPath,
        ranges,
        cacheKey,
        rotation: videoMeta.rotation ?? 0,
        colorMeta,
        ffmpegPaths: engine.ffmpegPaths,
      });
      return {
        outputPath: result.outputPath,
        playlist: buildPreviewPlaylist(ranges),
        durationSeconds: result.durationSeconds,
        cached: result.cached,
        thumbnails: result.thumbnails,
      };
    }
  );

  /**
   * "✓ 预览真实导出" — render the variant WITH subtitles burned in by
   * libass, so the user sees a pixel-accurate preview of what the
   * final export will look like (font, outline, shadow, keyword
   * highlights, position — everything that the HTML overlay only
   * approximates).
   *
   * Same shape as prepare-packaging-preview but additionally:
   *   1. Loads the current PackagingPlan for the variant
   *   2. Generates an ASS file from the plan + transcript + playlist
   *   3. Writes the ASS to a hashed temp path
   *   4. Calls renderPackagingPreview with subtitleBurnIn set
   *   5. cacheKey includes the ASS content hash so editing the plan
   *      invalidates the cached mp4
   *
   * 整片 (variantId=null) not supported — full-video render with
   * burn-in is too slow for an interactive preview. UI hides the
   * button in that case.
   */
  ipcMain.handle(
    'prepare-packaging-verify-preview',
    async (
      _ev,
      projectId: string,
      variantId: string
    ): Promise<{
      outputPath: string;
      playlist: PreviewPlaylistEntry[];
      durationSeconds: number;
      cached: boolean;
      thumbnails: string[];
    }> => {
      if (!variantId) {
        throw new Error('真实预览仅支持高光变体,整片暂不支持');
      }
      const project = engine.projects.get(projectId);
      const variant = project.findHighlightVariant(variantId);
      if (!variant) throw new Error(`找不到高光变体: ${variantId}`);
      if (variant.segments.length === 0) {
        throw new Error('变体没有片段');
      }
      if (!project.transcript) {
        throw new Error('请先生成字幕');
      }
      const plan = project.getPackagingPlan(variantId);
      if (!plan) {
        throw new Error('请先生成包装方案');
      }

      const videoPath = project.videoPath;
      const videoMeta = project.videoMeta;
      const ranges: Range[] = variant.segments.map((s) => ({
        start: s.start,
        end: s.end,
      }));

      // Build playlist (source → preview time mapping) used both by
      // the ASS time-calibration and as the return value.
      const playlist = buildPreviewPlaylist(ranges);
      const dims = outputDimensions(videoMeta);

      // Generate ASS. AssPlaylistEntry has {srcStart, srcEnd, outStart,
      // outEnd} — same shape as PreviewPlaylistEntry's variantStart/
      // variantEnd renamed.
      const assPlaylist: AssPlaylistEntry[] = playlist.map((p) => ({
        srcStart: p.srcStart,
        srcEnd: p.srcEnd,
        outStart: p.variantStart,
        outEnd: p.variantEnd,
      }));
      const assContent = generatePackagingAss({
        transcript: project.transcript,
        plan,
        playlist: assPlaylist,
        videoWidth: dims.w,
        videoHeight: dims.h,
      });

      // Hash ASS content → fold into cacheKey so editing the plan
      // invalidates the cached mp4 automatically.
      const assHash = crypto
        .createHash('sha1')
        .update(assContent)
        .digest('hex')
        .slice(0, 8);
      const assDir = path.join(os.tmpdir(), 'lynlens-packaging-ass');
      await fs.mkdir(assDir, { recursive: true });
      const assPath = path.join(
        assDir,
        `verify-${plan.id}-${assHash}.ass`
      );
      await fs.writeFile(assPath, assContent, 'utf-8');

      const baseKey = previewCacheKey(videoPath, ranges);
      const cacheKey = `verify-${baseKey}-${assHash}`;
      const colorMeta = await probeColorMeta(videoPath, engine.ffmpegPaths);
      const result = await renderPackagingPreview({
        videoPath,
        ranges,
        cacheKey,
        rotation: videoMeta.rotation ?? 0,
        colorMeta,
        ffmpegPaths: engine.ffmpegPaths,
        subtitleBurnIn: { path: assPath },
      });
      return {
        outputPath: result.outputPath,
        playlist,
        durationSeconds: result.durationSeconds,
        cached: result.cached,
        thumbnails: result.thumbnails,
      };
    }
  );

  /**
   * Final export of a packaged variant (or 整片) with花字 burned into the
   * frames. The flow:
   *
   *   1. Resolve keep ranges. variantId set → variant.segments (user
   *      order, repeats allowed). null → rippled-timeline keeps
   *      (computeKeepIntervals over approved deletes + cut ranges).
   *   2. Build a source↔output time playlist from those keeps so the
   *      ASS dialogue events line up with the OUTPUT video's timeline.
   *   3. Render the ASS subtitle file (transcript timings + plan
   *      styling) and write to a temp file ffmpeg can read.
   *   4. Call ExportService.export with both `keepOverride` and
   *      `subtitleBurnIn`; the precise encoder bakes everything into
   *      one final mp4 — preview ↔ export pixel-equivalent.
   *
   * Requires a PackagingPlan for the (project, variantId) — if none
   * exists, throws so the UI can prompt the user to generate one.
   */
  ipcMain.handle(
    'export-packaged',
    async (
      _ev,
      projectId: string,
      variantId: string | null,
      outputPath: string,
      quality: ExportQuality = 'original'
    ): Promise<ExportResult> => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕,然后才能导出带花字的成品');
      }
      const plan = project.getPackagingPlan(variantId);
      if (!plan) {
        throw new Error('当前对象没有包装方案。请在包装 tab 点「一键包装」生成。');
      }
      const absOutputPath = resolveExportOutputPath(outputPath);

      // Build keep ranges. Variant: user-ordered segments (preserves
      // repeats/overlaps). 整片: computed from approved deletes + cuts.
      let ranges: Range[];
      if (variantId) {
        const variant = project.findHighlightVariant(variantId);
        if (!variant) throw new Error(`找不到高光变体: ${variantId}`);
        if (variant.segments.length === 0) {
          throw new Error('变体没有片段,无法导出');
        }
        ranges = variant.segments.map((s) => ({ start: s.start, end: s.end }));
      } else {
        ranges = computeKeepIntervals(
          project.videoMeta.duration,
          project.segments.getApprovedSegments().map((s) => ({
            start: s.start,
            end: s.end,
          })),
          project.cutRanges
        );
        if (ranges.length === 0) {
          throw new Error('整片没有可导出的内容(全部被剪掉了)');
        }
      }

      // Build the source→output playlist for ASS time mapping.
      let acc = 0;
      const playlist: AssPlaylistEntry[] = ranges.map((r) => {
        const dur = Math.max(0, r.end - r.start);
        const entry: AssPlaylistEntry = {
          srcStart: r.start,
          srcEnd: r.end,
          outStart: acc,
          outEnd: acc + dur,
        };
        acc += dur;
        return entry;
      });

      // Render the ASS using OUTPUT (post-rotation) dimensions so font
      // sizes / positions match the encoded frame.
      const dims = outputDimensions(project.videoMeta);
      const assContent = generatePackagingAss({
        transcript: project.transcript,
        plan,
        playlist,
        videoWidth: dims.w,
        videoHeight: dims.h,
      });
      const assDir = path.join(os.tmpdir(), 'lynlens-packaging-ass');
      await fs.mkdir(assDir, { recursive: true });
      // Cache key includes plan id + ranges hash → re-export with same
      // plan reuses the file, regenerated each call to pick up edits.
      const assPath = path.join(
        assDir,
        `${plan.id}-${variantId ?? 'root'}.ass`
      );
      await fs.writeFile(assPath, assContent, 'utf-8');

      // Drive the existing precise export pipeline with both overrides.
      const existing = activeExports.get(projectId);
      if (existing) existing.abort();
      const ac = new AbortController();
      activeExports.set(projectId, ac);
      try {
        return await engine.exports.export(project, {
          outputPath: absOutputPath,
          mode: 'precise',
          quality,
          signal: ac.signal,
          ffmpegPaths: engine.ffmpegPaths,
          keepOverride: ranges,
          subtitleBurnIn: { path: assPath },
        });
      } finally {
        activeExports.delete(projectId);
      }
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

      // v0.5: always use the ffmpeg fast path. PackagingPlan-driven
      // Remotion render is staged for v0.6+ — preview pipeline needs
      // more work (see NativeVideo discussion in commit ac8fd08).
      // Variant export drops any packaging visuals for now; they only
      // show in the live preview tab.
      try {
        const keepOverride = variant.segments.map((s) => ({
          start: s.start,
          end: s.end,
        }));
        return await engine.exports.export(project, {
          outputPath: resolveExportOutputPath(outputPath),
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
