/**
 * Packaging preview renderer.
 *
 * Why this exists: the 包装 tab needs to play a variant as a continuous
 * reel (no seek-flicker between segments). The export pipeline does this
 * but is too slow for an interactive preview — CRF 16 / preset medium /
 * tone-mapping takes minutes for a few-minute variant. The preview path
 * trades quality for speed:
 *
 *   - Hardware encoder (h264_videotoolbox on macOS, falls back to libx264
 *     `ultrafast` if HW init fails). 0.05x–0.15x realtime on Apple silicon.
 *   - Single CBR bitrate (3M), audio 128k aac.
 *   - Same trim+concat filter chain as the real export → frame-accurate
 *     boundaries (subtitles line up correctly).
 *   - Output goes to a cached path under the OS tmp dir. The cache key
 *     includes the source path + ranges so re-selecting a variant is
 *     instant after the first render.
 *
 * The actual export still goes through the precise pipeline — this is
 * preview-only.
 */
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { buildConcatFilter, type HdrToSdrTags } from './export-service';
import { resolveFfmpegPaths, runFfmpeg, type FfmpegPaths, type VideoColorMeta } from './ffmpeg';
import type { Range } from './types';

export interface PreviewRenderOptions {
  videoPath: string;
  /** Source-time keep ranges, in playback order. */
  ranges: Range[];
  /** Stable identity for the variant (variant.id + segments fingerprint). */
  cacheKey: string;
  /** Source video rotation in degrees (for portrait videos). */
  rotation?: number;
  /** Source color metadata — needed for HDR tone-mapping branch. */
  colorMeta: VideoColorMeta;
  ffmpegPaths?: FfmpegPaths;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface PreviewRenderResult {
  /** Absolute path of the rendered preview mp4 (cached). */
  outputPath: string;
  /** Whether the file was reused from cache (skipped ffmpeg). */
  cached: boolean;
  /** Total preview duration in seconds (sum of range durations). */
  durationSeconds: number;
  /**
   * Absolute paths of N thumbnail jpgs evenly spaced across the preview
   * mp4's timeline. Empty array when extraction fails / is skipped.
   * Used by the 包装 tab to render a visual scrubber strip.
   */
  thumbnails: string[];
}

/**
 * One playlist entry maps a slice of the preview mp4's timeline back to
 * the original source video's timeline. Renderer uses this to look up
 * the active transcript segment by source time when the user scrubs in
 * preview time.
 */
export interface PreviewPlaylistEntry {
  /** Source-time range (where this clip lives in the original video). */
  srcStart: number;
  srcEnd: number;
  /** Preview-mp4 timeline range (where this clip is in the rendered file). */
  variantStart: number;
  variantEnd: number;
}

/** Build the source↔preview time playlist from a set of keep ranges. */
export function buildPreviewPlaylist(ranges: Range[]): PreviewPlaylistEntry[] {
  let acc = 0;
  return ranges.map((r) => {
    const dur = Math.max(0, r.end - r.start);
    const entry: PreviewPlaylistEntry = {
      srcStart: r.start,
      srcEnd: r.end,
      variantStart: acc,
      variantEnd: acc + dur,
    };
    acc += dur;
    return entry;
  });
}

/**
 * Compute a stable cache key for a (source, ranges) pair. Caller can
 * combine this with the variant id if they want per-variant cache
 * invalidation; this version is content-addressed (same ranges + same
 * source → same key, even across variants).
 */
export function previewCacheKey(videoPath: string, ranges: Range[]): string {
  const h = crypto.createHash('sha1');
  h.update(videoPath);
  for (const r of ranges) {
    h.update(`|${r.start.toFixed(3)}-${r.end.toFixed(3)}`);
  }
  return h.digest('hex').slice(0, 16);
}

/**
 * Render a preview mp4 from a list of keep ranges. Returns the cached
 * path on subsequent calls with the same cacheKey — no re-encode.
 */
export async function renderPackagingPreview(
  opts: PreviewRenderOptions
): Promise<PreviewRenderResult> {
  const { videoPath, ranges, cacheKey, colorMeta } = opts;
  if (ranges.length === 0) {
    throw new Error('renderPackagingPreview: ranges must be non-empty');
  }
  const rotation = opts.rotation ?? 0;
  const paths = opts.ffmpegPaths ?? resolveFfmpegPaths();
  const totalDuration = ranges.reduce((s, r) => s + (r.end - r.start), 0);

  const tmpRoot = path.join(os.tmpdir(), 'lynlens-packaging-preview');
  await fs.mkdir(tmpRoot, { recursive: true });
  const outputPath = path.join(tmpRoot, `${cacheKey}.mp4`);

  // Cache hit — return immediately. Stat instead of access so we also
  // sanity-check the file isn't empty (a previous run that crashed mid-
  // encode could leave a 0-byte file behind).
  try {
    const stat = await fs.stat(outputPath);
    if (stat.size > 1024) {
      const thumbnails = await ensureThumbnails(
        outputPath,
        totalDuration,
        cacheKey,
        tmpRoot,
        paths
      );
      return { outputPath, cached: true, durationSeconds: totalDuration, thumbnails };
    }
    // Stale empty file — fall through and re-encode.
    await fs.unlink(outputPath).catch(() => {});
  } catch {
    /* not cached — render fresh */
  }

  // HDR sources get tone-mapped the same way the real export does, so
  // preview color roughly matches what the user will get on export.
  const isHdr = colorMeta.isHdr;
  const hdrTags: HdrToSdrTags | false = isHdr
    ? {
        inTransfer: colorMeta.colorTransfer === 'unknown' ? 'arib-std-b67' : colorMeta.colorTransfer,
        inMatrix: colorMeta.colorSpace === 'unknown' ? 'bt2020nc' : colorMeta.colorSpace,
        inPrimaries: colorMeta.colorPrimaries === 'unknown' ? 'bt2020' : colorMeta.colorPrimaries,
        inRange: colorMeta.colorRange === 'unknown' ? 'tv' : colorMeta.colorRange,
      }
    : false;
  const filter = buildConcatFilter(ranges, rotation, hdrTags);

  // Try hardware encoder first; if it fails (no VideoToolbox, weird
  // codec/profile mismatch), fall back to libx264 ultrafast which is
  // still much faster than the real export pipeline.
  const tryEncoders: Array<{ codec: string; extraArgs: string[] }> = [
    {
      codec: 'h264_videotoolbox',
      extraArgs: ['-b:v', '3M', '-allow_sw', '1'],
    },
    {
      codec: 'libx264',
      extraArgs: ['-preset', 'ultrafast', '-crf', '28'],
    },
  ];

  let lastErr: Error | null = null;
  for (const enc of tryEncoders) {
    try {
      await runOneEncode(
        paths,
        videoPath,
        filter,
        enc.codec,
        enc.extraArgs,
        outputPath,
        totalDuration,
        opts.signal,
        opts.onProgress
      );
      // Verify the output is non-trivial.
      const stat = await fs.stat(outputPath);
      if (stat.size < 1024) {
        throw new Error(`Preview output too small (${stat.size} bytes)`);
      }
      const thumbnails = await ensureThumbnails(
        outputPath,
        totalDuration,
        cacheKey,
        tmpRoot,
        paths
      );
      return { outputPath, cached: false, durationSeconds: totalDuration, thumbnails };
    } catch (err) {
      lastErr = err as Error;
      // Clean up partial file before trying next encoder.
      await fs.unlink(outputPath).catch(() => {});
      if ((err as Error).name === 'AbortError') throw err;
      // Continue to next encoder.
    }
  }
  throw new Error(
    `Preview render failed for all encoders: ${lastErr?.message ?? 'unknown'}`
  );
}

async function runOneEncode(
  paths: FfmpegPaths,
  videoPath: string,
  filter: string,
  codec: string,
  extraArgs: string[],
  outputPath: string,
  totalDuration: number,
  signal: AbortSignal | undefined,
  onProgress: ((percent: number) => void) | undefined
): Promise<void> {
  const args: string[] = [
    '-v', 'error',
    '-noautorotate',
    '-i', videoPath,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-map', '[outa]',
    '-c:v', codec,
    ...extraArgs,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-y',
    outputPath,
  ];
  await runFfmpeg({
    ffmpegPath: paths.ffmpeg,
    signal,
    args,
    onProgress: ({ outTime }) => {
      if (onProgress && totalDuration > 0) {
        const pct = Math.min(99, (outTime / totalDuration) * 99);
        onProgress(pct);
      }
    },
  });
  if (onProgress) onProgress(100);
}

/**
 * Number of thumbnails per preview clip. 24 gives the 包装 tab's
 * timeline strip a decent visual density without bloating extraction
 * time. Caller can change later if needed.
 */
const THUMBNAIL_COUNT = 24;

/**
 * Make sure thumbnails for `videoPath` exist in tmpRoot under the
 * cache key. Returns absolute paths in chronological order. If
 * extraction fails for any reason returns [] (caller renders without
 * the strip — non-essential UX).
 */
async function ensureThumbnails(
  videoPath: string,
  durationSeconds: number,
  cacheKey: string,
  tmpRoot: string,
  paths: FfmpegPaths
): Promise<string[]> {
  if (durationSeconds <= 0) return [];
  const count = THUMBNAIL_COUNT;
  const expected: string[] = [];
  for (let i = 0; i < count; i++) {
    expected.push(path.join(tmpRoot, `${cacheKey}_thumb_${String(i).padStart(3, '0')}.jpg`));
  }
  // Cache hit: every expected thumb exists + non-empty.
  const allExist = await Promise.all(
    expected.map(async (p) => {
      try {
        const st = await fs.stat(p);
        return st.size > 256;
      } catch {
        return false;
      }
    })
  );
  if (allExist.every(Boolean)) return expected;

  // Extract using a single ffmpeg pass: fps filter at count/duration
  // gives us roughly evenly-spaced frames. Output to thumbnail_NNN.jpg.
  // Scaled to 160px wide preserving aspect (keeps the strip lightweight).
  try {
    const fps = count / durationSeconds;
    const pattern = path.join(tmpRoot, `${cacheKey}_thumb_%03d.jpg`);
    // Delete any partial leftovers first so the new pass writes the
    // exact set we expect.
    await Promise.all(
      expected.map((p) => fs.unlink(p).catch(() => {}))
    );
    await runFfmpeg({
      ffmpegPath: paths.ffmpeg,
      args: [
        '-v', 'error',
        '-noautorotate',
        '-i', videoPath,
        '-vf', `fps=${fps.toFixed(6)},scale=160:-1`,
        '-frames:v', String(count),
        '-vsync', '0',
        '-q:v', '5',
        '-y',
        pattern,
      ],
    });
    // ffmpeg uses 1-based numbering with %03d so files are
    // <key>_thumb_001.jpg .. <key>_thumb_024.jpg. We expected 0-based.
    // Rename to our 0-based convention so the cache check above matches.
    for (let i = 0; i < count; i++) {
      const src = path.join(tmpRoot, `${cacheKey}_thumb_${String(i + 1).padStart(3, '0')}.jpg`);
      const dst = expected[i];
      try {
        await fs.rename(src, dst);
      } catch {
        // ffmpeg might have produced fewer frames than expected on
        // very short clips — return whatever exists.
      }
    }
    const surviving: string[] = [];
    for (const p of expected) {
      try {
        const st = await fs.stat(p);
        if (st.size > 256) surviving.push(p);
      } catch {
        /* missing — skip */
      }
    }
    return surviving;
  } catch {
    // Best-effort feature; if extraction fails the strip just shows
    // an empty placeholder. Don't block preview availability.
    return [];
  }
}

/**
 * Best-effort cleanup of stale preview files (older than 24h). Caller
 * can run this on app start so the OS tmp doesn't grow unbounded across
 * many editing sessions.
 */
export async function cleanupStalePreviewCache(maxAgeMs = 24 * 3600 * 1000): Promise<void> {
  const tmpRoot = path.join(os.tmpdir(), 'lynlens-packaging-preview');
  try {
    const entries = await fs.readdir(tmpRoot);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(
      entries.map(async (name) => {
        const p = path.join(tmpRoot, name);
        try {
          const stat = await fs.stat(p);
          if (stat.mtimeMs < cutoff) {
            await fs.unlink(p);
          }
        } catch {
          /* ignore */
        }
      })
    );
  } catch {
    /* tmp dir doesn't exist yet — nothing to clean */
  }
}

