/**
 * Packaging-tab export via the Remotion `business-explainer` template.
 *
 * SCOPE: packaging tab ONLY. Every other export path (highlights fast
 * export, full-project precise export, ASS/libass burn-in) is untouched —
 * this is an additive, parallel pipeline.
 *
 * Why a separate engine: the template renders effects the ffmpeg+libass
 * path physically cannot (vertical CJK, per-char gradient fades, spring
 * camera punch). Remotion renders React→frames via headless Chromium, then
 * encodes with ffmpeg — preview and export share one renderer (P3 player),
 * killing the preview≠export divergence.
 *
 * Flow:
 *   1. Build keep ranges (variant segments, or 整片 keep-intervals).
 *   2. Render the trimmed, audio-carrying, SDR-tone-mapped base clip via
 *      the existing renderPackagingPreview (reuse — it already does color).
 *   3. Map PackagingPlan + transcript + playlist → BusinessExplainerSpec.
 *   4. Copy the base clip into the remotion package's public/ dir + write a
 *      props JSON, then spawn `node render.mjs --props … --out …`.
 *   5. Parse the child's stdout progress lines → engine `export.progress`
 *      events (the existing UI banner shows them, no renderer change).
 *   6. Color hard rule: Remotion emits BT.709 matrix/range/pixfmt; a fast
 *      `h264_metadata` bitstream pass stamps primaries/transfer too. No
 *      re-encode.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, ipcMain } from 'electron';
import {
  buildPreviewPlaylist,
  buildSpecAuthorLines,
  buildSpecAuthorSystemPrompt,
  buildSpecAuthorUserPrompt,
  computeKeepIntervals,
  emptyPackagingPlan,
  parseSpecAuthorResponse,
  planToSpec,
  previewCacheKey,
  probeColorMeta,
  probeVideo,
  renderPackagingPreview,
  type LynLensEngine,
  type PackagingPlan,
  type Project,
  type Range,
} from '@lynlens/core';
import { runOneShotViaCurrentProvider } from '../agent-dispatcher';
import type { IpcContext } from './_context';

/** Keep ranges for a variant (ordered segments) or 整片 (keep-intervals). */
function keepRangesFor(project: Project, variantId: string | null): Range[] {
  if (variantId) {
    const variant = project.findHighlightVariant(variantId);
    if (!variant) throw new Error(`找不到高光变体: ${variantId}`);
    if (variant.segments.length === 0) throw new Error('变体没有片段');
    return variant.segments.map((s) => ({ start: s.start, end: s.end }));
  }
  const ranges = computeKeepIntervals(
    project.videoMeta.duration,
    project.segments.getApprovedSegments().map((s) => ({ start: s.start, end: s.end })),
    project.cutRanges
  );
  if (ranges.length === 0) throw new Error('整片没有可导出的内容(全部被剪掉了)');
  return ranges;
}

/**
 * Absolute path to the Remotion package (render.mjs + composition + deps).
 * Packaged app: shipped to Resources/remotion via electron-builder
 * extraResources (a pnpm-deployed, symlink-free copy). Dev: resolve the
 * workspace package via require.resolve (CJS global; main compiles to CJS).
 */
function remotionPackageDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'remotion');
  }
  return path.dirname(require.resolve('@lynlens/remotion/package.json'));
}

/** Same Downloads/home resolution as the other export paths. */
function resolveExportOutputPath(outputPath: string): string {
  if (path.isAbsolute(outputPath)) return outputPath;
  if (!outputPath.includes(path.sep) && !outputPath.includes('/')) {
    return path.join(app.getPath('downloads'), outputPath);
  }
  return path.resolve(app.getPath('home'), outputPath);
}

/**
 * Stamp BT.709 primaries/transfer/matrix into the H.264 bitstream without
 * re-encoding (VUI rewrite). Remotion's colorSpace:'bt709' already sets the
 * matrix + tv range + yuv420p, but leaves primaries/transfer unset on some
 * builds — this closes the color hard rule. Best-effort: on any failure we
 * fall back to the Remotion output as-is (already bt709 matrix/range).
 */
async function stampBt709(
  ffmpegBin: string,
  inPath: string,
  outPath: string
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      '-y',
      '-i',
      inPath,
      '-c',
      'copy',
      '-bsf:v',
      'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0',
      outPath,
    ];
    const p = spawn(ffmpegBin, args, { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
}

interface RemotionRenderArgs {
  videoSrc: string; // basename inside remotion public/
  spec: unknown;
  durationInSeconds: number;
  fps: number;
  width: number;
  height: number;
  outPath: string;
  /** Cap rendered frames (preview = first N frames). Omit for full render. */
  frames?: number;
  onProgress: (progress: number) => void;
  /** First-export Chromium download progress (0..1). */
  onBrowserDownload?: (percent: number) => void;
}

/**
 * Where Remotion caches the headless Chromium. It derives the cache from the
 * render process CWD (`<cwd-package-root>/node_modules/.remotion`). In the
 * packaged app the remotion package lives read-only in Resources, so we point
 * CWD at a WRITABLE userData dir (seeded with a package.json) — the browser
 * downloads there on first export. In dev we keep CWD at the package dir so
 * the already-downloaded browser is reused (no re-download).
 */
async function browserCacheCwd(pkgDir: string): Promise<string> {
  if (!app.isPackaged) return pkgDir;
  const dir = path.join(app.getPath('userData'), 'remotion-cache');
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  // getDownloadsCacheDir walks up for a package.json; seed one here.
  await fs
    .writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'lynlens-remotion-cache', private: true }),
      { flag: 'wx' }
    )
    .catch(() => {});
  return dir;
}

/** Spawn the Remotion render child process; resolve on success. */
function spawnRemotionRender(args: RemotionRenderArgs): Promise<void> {
  const pkgDir = remotionPackageDir();
  return new Promise(async (resolve, reject) => {
    const cwd = await browserCacheCwd(pkgDir);
    const propsPath = path.join(
      os.tmpdir(),
      `lynlens-remotion-props-${crypto.randomBytes(6).toString('hex')}.json`
    );
    await fs.writeFile(
      propsPath,
      JSON.stringify({
        videoSrc: args.videoSrc,
        spec: args.spec,
        durationInSeconds: args.durationInSeconds,
        fps: args.fps,
        width: args.width,
        height: args.height,
      }),
      'utf-8'
    );

    // Use Electron's bundled Node (ELECTRON_RUN_AS_NODE) so a packaged app
    // doesn't depend on a system node install.
    const childArgs = [
      path.join(pkgDir, 'src', 'render.mjs'),
      '--props',
      propsPath,
      '--out',
      args.outPath,
      '--colorSpace',
      'bt709',
    ];
    if (args.frames != null) {
      childArgs.push('--frames', String(args.frames));
    }
    const child = spawn(process.execPath, childArgs, {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    let stdoutBuf = '';
    let stderrTail = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as {
            type: string;
            progress?: number;
            percent?: number;
          };
          if (msg.type === 'progress' && typeof msg.progress === 'number') {
            args.onProgress(msg.progress);
          } else if (msg.type === 'browser' && typeof msg.percent === 'number') {
            args.onBrowserDownload?.(msg.percent);
          }
        } catch {
          /* non-JSON stdout — ignore */
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on('error', (err) => {
      void fs.unlink(propsPath).catch(() => {});
      reject(err);
    });
    child.on('exit', (code) => {
      void fs.unlink(propsPath).catch(() => {});
      if (code === 0) resolve();
      else reject(new Error(`Remotion 渲染失败 (exit ${code})\n${stderrTail}`));
    });
  });
}

/**
 * AI-author a BusinessExplainerSpec for the 商务讲解 template + store it on
 * the variant's plan (templateSpec). Shared by the IPC handler and the MCP
 * tool so chat-driven and UI-driven packaging behave identically.
 */
export async function generatePackagingSpecFor(
  engine: LynLensEngine,
  projectId: string,
  variantId: string | null
): Promise<PackagingPlan> {
  const project = engine.projects.get(projectId);
  if (!project.transcript || project.transcript.segments.length === 0) {
    throw new Error('请先生成字幕,然后才能编排模板');
  }
  const ranges = keepRangesFor(project, variantId);
  const playlist = buildPreviewPlaylist(ranges);
  const lines = buildSpecAuthorLines(project.transcript, playlist);
  if (lines.length === 0) throw new Error('该对象内没有可编排的字幕段');
  const totalDurationSec = ranges.reduce((s, r) => s + (r.end - r.start), 0);
  const title = variantId
    ? project.findHighlightVariant(variantId)?.title ?? '高光变体'
    : '整片';

  const systemPrompt = buildSpecAuthorSystemPrompt();
  const userPrompt = buildSpecAuthorUserPrompt({ title, totalDurationSec, lines });
  const { text, model } = await runOneShotViaCurrentProvider(systemPrompt, userPrompt);
  const spec = parseSpecAuthorResponse(text, lines);

  const existing = project.getPackagingPlan(variantId) ?? emptyPackagingPlan(variantId);
  const nextPlan: PackagingPlan = { ...existing, templateSpec: spec, model };
  project.setPackagingPlan(nextPlan);
  return nextPlan;
}

/**
 * Render the packaging tab's final mp4 via Remotion (商务讲解 template).
 * Shared by the IPC handler and the MCP tool. Emits export.* events on the
 * engine bus so the UI progress banner works regardless of trigger. Pass a
 * signal to support cancellation (UI export); the MCP tool omits it.
 */
export async function exportPackagingRemotion(
  engine: LynLensEngine,
  projectId: string,
  variantId: string | null,
  outputPath: string,
  opts: { signal?: AbortSignal } = {}
): Promise<{ outputPath: string; sizeBytes: number }> {
  const project = engine.projects.get(projectId);
  if (!project.transcript || project.transcript.segments.length === 0) {
    throw new Error('请先生成字幕,然后才能用模板导出');
  }
  const plan = project.getPackagingPlan(variantId);
  if (!plan) {
    throw new Error('当前对象没有包装方案。请在包装 tab 点「一键包装」生成。');
  }
  const absOutputPath = resolveExportOutputPath(outputPath);
  const ranges = keepRangesFor(project, variantId);

  engine.eventBus.emit({
    type: 'export.started',
    projectId,
    mode: 'precise',
    outputPath: absOutputPath,
  });

  const pkgDir = remotionPackageDir();
  const stamp = crypto.randomBytes(6).toString('hex');
  const clipName = `lynlens-base-${stamp}.mp4`;
  const clipPublicPath = path.join(pkgDir, 'public', clipName);
  const remotionRawOut = path.join(os.tmpdir(), `lynlens-remotion-raw-${stamp}.mp4`);

  try {
    engine.eventBus.emit({ type: 'export.progress', projectId, percent: 2, stage: '准备素材' });
    const colorMeta = await probeColorMeta(project.videoPath, engine.ffmpegPaths);
    const base = await renderPackagingPreview({
      videoPath: project.videoPath,
      ranges,
      cacheKey: previewCacheKey(project.videoPath, ranges),
      rotation: project.videoMeta.rotation ?? 0,
      colorMeta,
      ffmpegPaths: engine.ffmpegPaths,
    });
    const playlist = buildPreviewPlaylist(ranges);
    const spec =
      plan.templateSpec ?? planToSpec({ transcript: project.transcript, plan, playlist });
    const baseMeta = await probeVideo(base.outputPath, engine.ffmpegPaths);
    await fs.copyFile(base.outputPath, clipPublicPath);
    if (opts.signal?.aborted) throw new Error('已取消');

    await spawnRemotionRender({
      videoSrc: clipName,
      spec,
      durationInSeconds: base.durationSeconds,
      fps: baseMeta.fps,
      width: baseMeta.width,
      height: baseMeta.height,
      outPath: remotionRawOut,
      onProgress: (progress) => {
        const percent = 5 + Math.round(progress * 90);
        engine.eventBus.emit({ type: 'export.progress', projectId, percent, stage: '渲染花字' });
      },
      onBrowserDownload: (pct) => {
        // First-ever export downloads the headless Chromium (~150MB). Keep
        // the bar at the start of the range and label it clearly.
        engine.eventBus.emit({
          type: 'export.progress',
          projectId,
          percent: 3,
          stage: `下载渲染器(首次 ${(pct * 100).toFixed(0)}%)`,
        });
      },
    });

    engine.eventBus.emit({ type: 'export.progress', projectId, percent: 97, stage: '校正色彩' });
    const stamped = await stampBt709(engine.ffmpegPaths.ffmpeg, remotionRawOut, absOutputPath);
    if (!stamped) await fs.copyFile(remotionRawOut, absOutputPath);

    const stat = await fs.stat(absOutputPath);
    engine.eventBus.emit({ type: 'export.progress', projectId, percent: 100, stage: '完成' });
    engine.eventBus.emit({
      type: 'export.completed',
      projectId,
      outputPath: absOutputPath,
      sizeBytes: stat.size,
    });
    return { outputPath: absOutputPath, sizeBytes: stat.size };
  } catch (err) {
    engine.eventBus.emit({ type: 'export.failed', projectId, error: (err as Error).message });
    throw err;
  } finally {
    await fs.unlink(clipPublicPath).catch(() => {});
    await fs.unlink(remotionRawOut).catch(() => {});
  }
}

export function registerPackagingRemotionIpc(ctx: IpcContext): void {
  const { engine, activeExports } = ctx;

  /**
   * Base URL of the localhost media server. The renderer builds player video
   * URLs as `${base}/media?p=<encoded abs path>` — Remotion's <Video> can't
   * load our lynlens-media:// scheme, so the live player streams over HTTP.
   */
  ipcMain.handle('get-media-http-base', async (): Promise<string | null> => {
    return ctx.getMediaHttpBase();
  });

  /**
   * AI-author a BusinessExplainerSpec for the 商务讲解 template and store it
   * on the variant's PackagingPlan (templateSpec). The model decides style /
   * keywords / hero-splits / camera + sound lines; timing + text come from
   * our variant-time skeleton. Returns the updated plan so the renderer can
   * setPlan() uniformly with the keyword-花字 generate path.
   */
  ipcMain.handle(
    'generate-packaging-spec',
    async (_ev, projectId: string, variantId: string | null): Promise<PackagingPlan> =>
      generatePackagingSpecFor(engine, projectId, variantId)
  );

  /**
   * "✓ 预览真实导出" for the 商务讲解 template: render the FIRST ~20s of the
   * variant through the real Remotion pipeline to a temp mp4 and hand back
   * its path. The renderer swaps the preview <video> to it — a pixel-exact
   * preview of the export, without the cost of rendering the whole clip or
   * the risk of embedding the player. Pixel-identical to 导出成品.
   */
  ipcMain.handle(
    'prepare-packaging-verify-remotion',
    async (
      _ev,
      projectId: string,
      variantId: string | null
    ): Promise<{ outputPath: string; durationSeconds: number }> => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕');
      }
      const plan = project.getPackagingPlan(variantId);
      if (!plan) throw new Error('请先一键包装');

      const ranges = keepRangesFor(project, variantId);
      const colorMeta = await probeColorMeta(project.videoPath, engine.ffmpegPaths);
      const base = await renderPackagingPreview({
        videoPath: project.videoPath,
        ranges,
        cacheKey: previewCacheKey(project.videoPath, ranges),
        rotation: project.videoMeta.rotation ?? 0,
        colorMeta,
        ffmpegPaths: engine.ffmpegPaths,
      });
      const playlist = buildPreviewPlaylist(ranges);
      const spec =
        plan.templateSpec ?? planToSpec({ transcript: project.transcript, plan, playlist });
      const baseMeta = await probeVideo(base.outputPath, engine.ffmpegPaths);

      const pkgDir = remotionPackageDir();
      const stamp = crypto.randomBytes(6).toString('hex');
      const clipName = `lynlens-vbase-${stamp}.mp4`;
      const clipPublicPath = path.join(pkgDir, 'public', clipName);
      const outPath = path.join(os.tmpdir(), `lynlens-remotion-verify-${stamp}.mp4`);

      const PREVIEW_SECONDS = 20;
      const previewSeconds = Math.min(PREVIEW_SECONDS, base.durationSeconds);
      const frames = Math.max(1, Math.round(previewSeconds * baseMeta.fps));

      try {
        await fs.copyFile(base.outputPath, clipPublicPath);
        await spawnRemotionRender({
          videoSrc: clipName,
          spec,
          durationInSeconds: base.durationSeconds,
          fps: baseMeta.fps,
          width: baseMeta.width,
          height: baseMeta.height,
          outPath,
          frames,
          onProgress: () => {},
        });
        return { outputPath: outPath, durationSeconds: previewSeconds };
      } finally {
        await fs.unlink(clipPublicPath).catch(() => {});
      }
    }
  );

  ipcMain.handle(
    'export-packaged-remotion',
    async (
      _ev,
      projectId: string,
      variantId: string | null,
      outputPath: string
    ): Promise<{ outputPath: string; sizeBytes: number }> => {
      // Register for cancellation (the shared fn checks the signal).
      const ac = new AbortController();
      const existing = activeExports.get(projectId);
      if (existing) existing.abort();
      activeExports.set(projectId, ac);
      try {
        return await exportPackagingRemotion(engine, projectId, variantId, outputPath, {
          signal: ac.signal,
        });
      } finally {
        activeExports.delete(projectId);
      }
    }
  );
}
