/**
 * Remotion-based renderer for packaged video exports.
 *
 * Flow:
 *   1. First call to renderPackagingPlan() triggers bundle() of the
 *      remotion-entry/Root.tsx file. Bundle is cached in a tmp dir keyed
 *      by the entry file's mtime, so subsequent calls reuse it (no
 *      webpack re-run per export).
 *   2. selectComposition() instantiates the "Packaging" composition with
 *      the actual inputProps, computing durationInFrames / fps via the
 *      composition's calculateMetadata.
 *   3. renderMedia() runs headless Chrome + ffmpeg to produce the MP4.
 *      Progress events go to the supplied onProgress callback.
 *
 * Architecture rationale:
 *   - Main process owns the bundle + render lifecycle. Renderer never
 *     touches @remotion/bundler or @remotion/renderer.
 *   - We share PackagingComposition between Player (renderer) and
 *     renderMedia (main) by importing the same file in both — WYSIWYG
 *     by construction.
 *   - HDR: Remotion's OffthreadVideo uses ffmpeg + zscale + tonemap
 *     internally (since 4.0.117), matching our existing export-service.ts
 *     pipeline. No special HDR handling needed here.
 */

import { bundle } from '@remotion/bundler';
import {
  renderMedia,
  selectComposition,
  type RenderMediaOnProgress,
} from '@remotion/renderer';
import { app } from 'electron';
import { promises as fs, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { PackagingPlan } from '@lynlens/core';

/** Cached bundle location. Invalidated when the entry file mtime changes. */
interface BundleCache {
  serveUrl: string;
  entryMtimeMs: number;
}
let cache: BundleCache | null = null;

/**
 * Resolve the Remotion entry file path. In dev (LYNLENS_DEV=1) it's the
 * TS source file in src/remotion-entry/Root.tsx; in production it ships
 * inside the app bundle.
 */
function resolveEntryPoint(): string {
  // In dev: __dirname is dist/main/main, source is at packages/desktop/src/remotion-entry/Root.tsx
  // In prod: __dirname is asar/dist/main/main, source must be shipped (electron-builder includes it)
  const candidate = path.resolve(
    app.getAppPath(),
    'src',
    'remotion-entry',
    'Root.tsx'
  );
  if (existsSync(candidate)) return candidate;
  // Fallback for build layouts where appPath points at dist/.
  const fallback = path.resolve(
    app.getAppPath(),
    '..',
    'src',
    'remotion-entry',
    'Root.tsx'
  );
  if (existsSync(fallback)) return fallback;
  throw new Error(
    `Remotion entry not found. Tried:\n  ${candidate}\n  ${fallback}\nDid electron-builder include src/remotion-entry/?`
  );
}

/**
 * Get a usable bundle, building one if cache is empty / stale. Bundling
 * is expensive (~5-15s the first time, less subsequently due to webpack
 * cache), so we keep the result for the life of the process.
 */
async function getOrBuildBundle(): Promise<string> {
  const entry = resolveEntryPoint();
  const entryMtimeMs = statSync(entry).mtimeMs;
  if (cache && cache.entryMtimeMs === entryMtimeMs) {
    return cache.serveUrl;
  }
  const outDir = path.join(app.getPath('userData'), 'remotion-bundle');
  await fs.mkdir(outDir, { recursive: true });
  // eslint-disable-next-line no-console
  console.log('[remotion-render] bundling composition from', entry);
  const serveUrl = await bundle({
    entryPoint: entry,
    outDir,
    // Quiet the webpack output — Remotion forwards stdout otherwise and
    // crowds the dev console.
    onProgress: (progress) => {
      if (progress % 10 === 0 || progress >= 95) {
        // eslint-disable-next-line no-console
        console.log(`[remotion-render] bundle ${progress}%`);
      }
    },
  });
  cache = { serveUrl, entryMtimeMs };
  // eslint-disable-next-line no-console
  console.log('[remotion-render] bundle ready at', serveUrl);
  return serveUrl;
}

export interface RenderPackagingArgs {
  /** Absolute filesystem path to the source video. */
  videoPath: string;
  /**
   * Source-time segments to play in order. Each entry is ONE transcript
   * line (single subtitle), NOT a variant chunk. `segmentIdx` is the
   * original transcript index so the composition can look up per-segment
   * recipes from the plan.
   */
  segments: Array<{
    start: number;
    end: number;
    text: string;
    segmentIdx: number;
  }>;
  /** Plan describing per-segment subtitle / camera / watermark. */
  plan: PackagingPlan;
  /** Composition dimensions (typically videoMeta.width/height). */
  width: number;
  height: number;
  /** Frame rate (typically videoMeta.fps). */
  fps: number;
  /** Output MP4 path. */
  outputPath: string;
  /** Quality knob — maps to CRF in libx264. */
  quality: 'original' | 'high' | 'medium' | 'low';
  /** Progress callback (0..1). */
  onProgress?: (frac: number, stage: string) => void;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
}

const QUALITY_CRF: Record<RenderPackagingArgs['quality'], number> = {
  original: 16,
  high: 18,
  medium: 23,
  low: 28,
};

/**
 * Render a packaged variant to MP4. Throws on any failure (caller is
 * responsible for surfacing the error). Cancellation via signal.aborted
 * is checked at each Remotion progress callback — Remotion itself
 * doesn't accept an AbortSignal, but it does abort cleanly when the
 * onProgress throws.
 */
export async function renderPackagingPlan(args: RenderPackagingArgs): Promise<void> {
  const serveUrl = await getOrBuildBundle();
  // file:// URL is what OffthreadVideo expects in headless Chrome (which
  // doesn't have the LynLens app's custom lynlens-media:// protocol handler
  // registered). Strip any other protocol and prepend file://.
  const rawPath = args.videoPath
    .replace(/^lynlens-media:\/\/\/?f\//, '')
    .replace(/^file:\/\//, '');
  // The lynlens-media path component is URL-encoded; decode for filesystem.
  const decodedPath = (() => {
    try {
      return decodeURIComponent(rawPath);
    } catch {
      return rawPath;
    }
  })();
  const videoUrl = `file://${decodedPath.startsWith('/') ? decodedPath : '/' + decodedPath}`;

  const inputProps = {
    videoPath: videoUrl,
    segments: args.segments,
    plan: args.plan,
    width: args.width,
    height: args.height,
    fps: args.fps,
  };

  // eslint-disable-next-line no-console
  console.log('[remotion-render] selecting composition');
  const composition = await selectComposition({
    serveUrl,
    id: 'Packaging',
    inputProps,
  });

  args.onProgress?.(0.05, '准备渲染');

  const onProgress: RenderMediaOnProgress = ({ progress, renderedFrames, encodedFrames }) => {
    if (args.signal?.aborted) {
      throw new Error('AbortError');
    }
    // progress is 0..1 covering both render + encode. Map to 0.1..0.95.
    const overall = 0.1 + progress * 0.85;
    args.onProgress?.(
      overall,
      `渲染中 ${renderedFrames}/${composition.durationInFrames} 帧`
    );
  };

  // eslint-disable-next-line no-console
  console.log('[remotion-render] starting renderMedia →', args.outputPath);
  await renderMedia({
    serveUrl,
    composition,
    inputProps,
    codec: 'h264',
    outputLocation: args.outputPath,
    crf: QUALITY_CRF[args.quality],
    // Use ffmpeg's libx264 for compatibility with current export pipeline.
    // Remotion's default is fine; we just need CRF control.
    onProgress,
  });

  args.onProgress?.(1, '完成');
  // eslint-disable-next-line no-console
  console.log('[remotion-render] renderMedia done →', args.outputPath);
}
