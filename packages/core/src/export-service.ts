import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EventBus } from './event-bus';
import {
  probeColorMeta,
  resolveFfmpegPaths,
  runFfmpeg,
  type FfmpegPaths,
  type VideoColorMeta,
} from './ffmpeg';
import type { Project } from './project-manager';
import { computeKeepIntervals } from './ripple';
import type { Range } from './types';

/**
 * Export modes — kept as a type for backwards compatibility with callers
 * (renderer ExportRequest, MCP). Both modes now go through the same
 * frame-accurate + color-preserving pipeline; the only practical difference
 * is the CRF (`'fast'` = a slightly higher CRF than `'precise'`).
 *
 * The old "fast = stream copy" behaviour was removed in v0.4.1: it produced
 * frame jumps at every cut (cuts could only land on keyframes) and Windows
 * players showed wrong colors after the concat demuxer rewrote color tags.
 * Both bugs together were unfixable inside the stream-copy approach.
 */
export type ExportMode = 'fast' | 'precise';
export type ExportQuality = 'original' | 'high' | 'medium' | 'low';

export interface ExportOptions {
  outputPath: string;
  mode?: ExportMode;
  quality?: ExportQuality;
  /** MP4 or MOV. Currently both treated identically by the encoder pipeline. */
  format?: 'mp4' | 'mov';
  signal?: AbortSignal;
  ffmpegPaths?: FfmpegPaths;
  /**
   * If set, skip the usual "drop approved + cut segments" computation and
   * use these ranges (source time) as the exact keep list. Used by the
   * highlight tab to export one variant's segments as a standalone video.
   */
  keepOverride?: Range[];
  /**
   * If set, ffmpeg burns the ASS subtitle file into the output video via
   * libass. The ASS event times must already match the OUTPUT timeline
   * (post-concat), not the source video timeline. Used by the 包装 tab
   * to bake花字 into the final mp4.
   */
  subtitleBurnIn?: SubtitleBurnIn;
}

export interface ExportResult {
  outputPath: string;
  durationSeconds: number;
  sizeBytes: number;
  mode: ExportMode;
}

/**
 * CRF table per quality. Mode is collapsed into quality now — picking
 * "fast" through MCP just means "slightly less aggressive CRF" rather
 * than a different code path. CRF 16 is visually transparent for most
 * SDR content; CRF 28 is mediocre but tiny files.
 */
const CRF_BY_QUALITY: Record<ExportQuality, number> = {
  original: 16,
  high: 18,
  medium: 23,
  low: 28,
};

export class ExportService {
  constructor(private readonly eventBus: EventBus) {}

  async export(project: Project, options: ExportOptions): Promise<ExportResult> {
    const mode: ExportMode = options.mode ?? 'precise';
    const { videoPath, videoMeta } = project;
    // Keep list computation:
    //   - Normal flow: drop approved delete segments AND committed ripple
    //     cuts. computeKeepIntervals merges both into the same keep list.
    //   - Variant flow: the caller (highlight tab) provides keepOverride
    //     directly — we just sort+merge to be safe. Everything else (not
    //     in keepOverride) is dropped.
    const keeps: Range[] = options.keepOverride
      ? mergeKeeps(options.keepOverride, videoMeta.duration)
      : computeKeepIntervals(
          videoMeta.duration,
          project.segments.getApprovedSegments().map((s) => ({
            start: s.start,
            end: s.end,
          })),
          project.cutRanges
        );
    const approvedDeletes = options.keepOverride
      ? []
      : project.segments.getApprovedSegments().map((s) => ({
          start: s.start,
          end: s.end,
        }));
    const outputPath = path.resolve(options.outputPath);

    if (path.resolve(videoPath) === outputPath) {
      throw new Error('Output path must differ from source video path');
    }
    if (keeps.length === 0) {
      throw new Error('Nothing to export: all content is marked deleted');
    }

    // Catastrophic-cut safety check only applies to the normal "trim delete
    // segments" flow. For variant export, keeping <20% of the source is
    // normal (that IS the highlight). Skip the check when keepOverride set.
    //
    // Threshold is intentionally lenient (99%): the real LynLens use case
    // is editing long talking-head recordings down to short polished cuts,
    // where keeping <10% of the source is routine. The check only exists
    // to catch bugs like "every segment was approved by mistake" → output
    // is empty / 1 frame. An earlier 80% threshold blocked legitimate
    // aggressive edits and was a real friction point for users.
    if (!options.keepOverride) {
      const totalCut =
        project.cutRanges.reduce((sum, r) => sum + (r.end - r.start), 0) +
        approvedDeletes.reduce((sum, r) => sum + (r.end - r.start), 0);
      const keepDuration = videoMeta.duration - totalCut;
      if (keepDuration < videoMeta.duration * 0.01 || keepDuration < 0.5) {
        const cutPct = ((totalCut / videoMeta.duration) * 100).toFixed(1);
        throw new Error(
          `导出被拒绝：剪掉了 ${cutPct}%，只剩 ${keepDuration.toFixed(2)} 秒可导出。` +
            `如果不是有意为之，请检查"标记段"列表是否有误判后再试。`
        );
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    this.eventBus.emit({
      type: 'export.started',
      projectId: project.id,
      mode,
      outputPath,
    });

    try {
      const colorMeta = await probeColorMeta(videoPath, options.ffmpegPaths);
      await this.exportFrameAccurate(
        project.id,
        videoPath,
        keeps,
        outputPath,
        colorMeta,
        options,
        videoMeta.rotation ?? 0
      );
      const stats = await fs.stat(outputPath);
      const durationSeconds = keeps.reduce((sum, r) => sum + (r.end - r.start), 0);
      this.eventBus.emit({
        type: 'export.completed',
        projectId: project.id,
        outputPath,
        sizeBytes: stats.size,
      });
      return { outputPath, durationSeconds, sizeBytes: stats.size, mode };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.eventBus.emit({ type: 'export.canceled', projectId: project.id });
      } else {
        this.eventBus.emit({
          type: 'export.failed',
          projectId: project.id,
          error: (err as Error).message,
        });
      }
      throw err;
    }
  }

  /**
   * Single export pipeline: frame-accurate cuts via filter_complex +
   * **universally-compatible H.264 8-bit yuv420p** output.
   *
   * Compatibility is the priority. iOS / iPadOS Photos + AirDrop pipeline
   * rejects HEVC Main 10 10-bit even with the `hvc1` FourCC tag on older
   * iPad models. Most users expect "exported video opens on my iPad" as
   * baseline. We sacrifice 10-bit fidelity (talking-head content doesn't
   * care about banding) + ~30% file size (HEVC was smaller for same
   * quality) to gain "plays everywhere Apple has made in the last decade".
   *
   * Two input regimes still differ:
   *   - HDR source (HLG / PQ / Dolby Vision) → tone-map to SDR BT.709 via
   *     zscale + tonemap filters, then encode H.264 8-bit. Otherwise
   *     Windows / browser playback would render BT.2020 as BT.709 and
   *     produce wrong colours.
   *   - SDR source → forward color tags as-is. 10-bit sources get
   *     dithered down to 8-bit at the pix_fmt boundary (free, by ffmpeg).
   *
   * Color tags are still forwarded at both container (-colorspace etc.)
   * and bitstream level (-x264-params) so strict downstream re-encoders
   * pick them up correctly.
   *
   * libx265 was used previously for 10-bit SDR sources. Removed because
   * iPhone-recorded SDR is almost always 10-bit HEVC → re-encode kept it
   * 10-bit HEVC → output worked on Mac / QuickTime but iPad Photos
   * silently rejected it. The `-tag:v hvc1` mitigation helps modern iPads
   * but not older ones; H.264 8-bit is the only universally safe option.
   */
  private async exportFrameAccurate(
    projectId: string,
    videoPath: string,
    keeps: Range[],
    outputPath: string,
    colorMeta: VideoColorMeta,
    options: ExportOptions,
    rotation = 0
  ): Promise<void> {
    const paths = options.ffmpegPaths ?? resolveFfmpegPaths();
    const quality = options.quality ?? (options.mode === 'fast' ? 'high' : 'original');
    const crf = CRF_BY_QUALITY[quality];
    const totalDuration = keeps.reduce((s, r) => s + (r.end - r.start), 0);

    // HDR sources go through the tone-map branch — see method comment.
    // Everything else (incl. 10-bit SDR) preserves bit depth + tags.
    const isHdr = colorMeta.isHdr;
    const hdrTags = isHdr
      ? {
          // Explicit input color tags so zscale doesn't have to guess from
          // frame metadata (which `concat` may have stripped). Without this,
          // the linearize step can mis-interpret HLG as SDR and produce
          // washed-out / shifted output.
          inTransfer: colorMeta.colorTransfer === 'unknown' ? 'arib-std-b67' : colorMeta.colorTransfer,
          inMatrix: colorMeta.colorSpace === 'unknown' ? 'bt2020nc' : colorMeta.colorSpace,
          inPrimaries: colorMeta.colorPrimaries === 'unknown' ? 'bt2020' : colorMeta.colorPrimaries,
          inRange: (colorMeta.colorRange === 'unknown' ? 'tv' : colorMeta.colorRange) as 'tv' | 'pc',
        }
      : false;
    const filter = buildConcatFilter(
      keeps,
      rotation,
      hdrTags,
      options.subtitleBurnIn ?? null
    );

    // Universal-compat output: H.264 8-bit yuv420p for EVERY source. See
    // method comment for why HEVC / 10-bit was dropped.
    const encoder: 'libx264' = 'libx264';
    const outPixFmt = 'yuv420p';
    let colorPrimaries: string;
    let colorTransfer: string;
    let colorSpace: string;
    let colorRange: 'tv' | 'pc';

    if (isHdr) {
      // Tone-mapped output: BT.709 SDR (tonemap filter chain handles colour).
      colorPrimaries = 'bt709';
      colorTransfer = 'bt709';
      colorSpace = 'bt709';
      colorRange = 'tv';
    } else {
      // SDR: forward source tags. "unknown" → BT.709 SDR limited.
      colorPrimaries = colorMeta.colorPrimaries === 'unknown' ? 'bt709' : colorMeta.colorPrimaries;
      colorTransfer = colorMeta.colorTransfer === 'unknown' ? 'bt709' : colorMeta.colorTransfer;
      colorSpace = colorMeta.colorSpace === 'unknown' ? 'bt709' : colorMeta.colorSpace;
      colorRange = colorMeta.colorRange === 'unknown' ? 'tv' : colorMeta.colorRange;
    }

    // Encoder-specific params: x264/x265 each need the same color tags
    // baked into the bitstream (not just in the container) for downstream
    // re-encoders to pick them up correctly.
    const encParam = colorTagsAsEncoderParam(
      encoder,
      colorPrimaries,
      colorTransfer,
      colorSpace
    );

    // Pass the filtergraph via a SCRIPT FILE, not inline on the command line.
    // A project with many cuts produces one trim+concat node per kept segment,
    // so `filter` can be tens of KB — past the OS command-line length cap
    // (Windows ~32KB) → `spawn ENAMETOOLONG`. `-filter_complex_script <file>`
    // reads the graph from disk and removes the limit entirely.
    const filterScriptPath = path.join(
      os.tmpdir(),
      `lynlens-filter-${crypto.randomBytes(6).toString('hex')}.txt`
    );
    await fs.writeFile(filterScriptPath, filter, 'utf-8');

    const args: string[] = [
      '-v', 'error',
      // Disable implicit auto-rotation so our explicit transpose filter is
      // the single source of truth for orientation (avoids double rotation
      // on ffmpeg versions that auto-rotate before filter_complex).
      '-noautorotate',
      '-i', videoPath,
      '-filter_complex_script', filterScriptPath,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', encoder,
      '-preset', 'medium',
      '-crf', String(crf),
      '-pix_fmt', outPixFmt,
      // Container-level color tags
      '-colorspace', colorSpace,
      '-color_primaries', colorPrimaries,
      '-color_trc', colorTransfer,
      '-color_range', colorRange,
    ];
    // Bitstream-level color tags (so the encoder writes them into the SPS).
    if (encParam) args.push(...encParam);
    args.push(
      // High profile + Level 4.1 = the widest "decodes on every iOS device
      // since iPhone 4S" profile. Higher levels (5.1, 5.2) are technically
      // supported on recent iPads but older iPads silently fail decoding
      // — same end result: file lands in Photos but won't play / can't
      // import. Capping at 4.1 keeps the bitstream within every Apple
      // hardware decoder's spec.
      '-profile:v', 'high',
      '-level:v', '4.1',
      '-c:a', 'aac',
      '-b:a', '192k',
      // Force stereo. iPhone "spatial audio" recordings ship as multi-
      // channel (ambisonic / 4ch) which AirDrop'd iPads silently drop —
      // file plays but no sound. Stereo is the universal LCD.
      '-ac', '2',
      // Stable AAC sample rate. iOS strongly prefers 48kHz; some apps
      // refuse non-standard rates.
      '-ar', '48000',
      // Clear any legacy rotate tag / display matrix on the output so
      // players don't try to rotate our already-rotated pixels a second time.
      '-metadata:s:v:0', 'rotate=0',
      // Explicit MP4 brand. ffmpeg's default `isom` works on most devices
      // but `mp42` is what Apple's own exports use and is more strictly
      // recognised by iOS's CMSampleBuffer pipeline.
      '-brand', 'mp42',
      '-movflags', '+faststart',
      '-y',
      outputPath
    );

    try {
      await runFfmpeg({
        ffmpegPath: paths.ffmpeg,
        signal: options.signal,
        args,
        onProgress: ({ outTime }) => {
          const percent = Math.min(99, (outTime / totalDuration) * 99);
          this.eventBus.emit({
            type: 'export.progress',
            projectId,
            percent,
            stage: '编码中',
          });
        },
      });
    } finally {
      await fs.unlink(filterScriptPath).catch(() => {});
    }
    this.eventBus.emit({ type: 'export.progress', projectId, percent: 100, stage: '完成' });
  }
}

/**
 * Convert a normalised rotation (0/90/180/270, as produced by
 * `extractRotation` → `normalizeRotation` on the source's Display Matrix
 * `rotation` field) into an ffmpeg transpose filter that bakes the visual
 * rotation into the pixels — because export runs with `-noautorotate`.
 *
 * The handedness MUST match ffmpeg's own auto-rotation. ffmpeg rotates by
 * `theta = -displayRotation`, i.e. it negates the Display Matrix angle before
 * deciding the transpose. `extractRotation` stores the *un-negated* angle
 * (e.g. an iPhone portrait clip reports display rotation -90 → normalised to
 * 270), so the mapping here has to invert it back:
 *
 *   rotation 270 (display -90, iPhone portrait) → transpose=1 (90° CW)
 *   rotation  90 (display -270 / +90)           → transpose=2 (90° CCW)
 *   rotation 180                                 → double transpose
 *
 * Verified empirically: for a real iPhone clip (display matrix -90 →
 * normalised 270), `transpose=1` produces byte-identical frames to ffmpeg's
 * default auto-rotation. Getting this backwards exports portrait video
 * 180° upside-down (the v0.5.x bug this mapping fixes).
 */
function rotationFilter(rotation: number): string {
  const r = ((Math.round(rotation) % 360) + 360) % 360;
  switch (r) {
    case 90:  return 'transpose=2,';
    case 180: return 'transpose=1,transpose=1,';
    case 270: return 'transpose=1,';
    default:  return '';
  }
}

/**
 * When tone-mapping HDR → SDR, callers pass the source's color tags so
 * zscale's linearize step can interpret HLG / PQ correctly even after
 * `concat` may have stripped the per-frame metadata.
 */
export interface HdrToSdrTags {
  inTransfer: string;
  inMatrix: string;
  inPrimaries: string;
  inRange: 'tv' | 'pc';
}

/**
 * Optional subtitle burn-in. When `path` is set, the filter chain
 * appends `subtitles=...` after the trim+concat (+ tonemap) stages so
 * the ASS subtitle is baked into the output frames. Used by the 包装
 * tab to export with花字 styling visible in the final mp4.
 *
 * `fontsdir` is optional but recommended — without it libass falls back
 * to the system font search, which on macOS resolves CJK fonts fine but
 * on Windows/Linux often picks the wrong glyphs. Caller can point at a
 * dir containing the user's chosen font.
 */
export interface SubtitleBurnIn {
  path: string;
  fontsdir?: string;
}

export function buildConcatFilter(
  keeps: Range[],
  rotation = 0,
  hdrToSdr: HdrToSdrTags | false = false,
  subtitleBurnIn: SubtitleBurnIn | null = null
): string {
  if (keeps.length === 0) throw new Error('keeps is empty');
  const rot = rotationFilter(rotation);
  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach((k, i) => {
    parts.push(`[0:v]${rot}trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  // The pipeline produces a video label step-by-step:
  //   concat → [vConcat]
  //   (HDR only) tonemap → [vTone]
  //   (subs only) burn  → [outv]
  // Pick the final label so we always end in [outv].
  const hasTone = !!hdrToSdr;
  const hasSubs = !!subtitleBurnIn;
  const concatLabel = hasTone || hasSubs ? 'vConcat' : 'outv';
  parts.push(
    `${labels.join('')}concat=n=${keeps.length}:v=1:a=1[${concatLabel}][outa]`
  );
  let lastLabel = concatLabel;
  // When tone-mapping HDR → SDR, route through a Hable curve and bake
  // BT.709 8-bit so the downstream encoder + subs filter operate in a
  // predictable colorspace.
  if (hdrToSdr) {
    const next = hasSubs ? 'vTone' : 'outv';
    const t = hdrToSdr;
    parts.push(
      `[${lastLabel}]` +
        `zscale=tin=${t.inTransfer}:min=${t.inMatrix}:pin=${t.inPrimaries}:rin=${t.inRange}:t=linear:npl=100,` +
        'format=gbrpf32le,' +
        'zscale=p=bt709,' +
        'tonemap=tonemap=hable:desat=0,' +
        'zscale=t=bt709:m=bt709:r=tv,' +
        'format=yuv420p' +
        `[${next}]`
    );
    lastLabel = next;
  }
  if (subtitleBurnIn) {
    // libass needs the path escaped: `\` and `:` and `'` are special inside
    // a filter argument. The ASS file path we write goes under a temp dir
    // with only alphanumerics so the simpler single-quote form is safe.
    const pathArg = escapeFilterPath(subtitleBurnIn.path);
    const fontsArg = subtitleBurnIn.fontsdir
      ? `:fontsdir='${escapeFilterPath(subtitleBurnIn.fontsdir)}'`
      : '';
    parts.push(
      `[${lastLabel}]subtitles='${pathArg}':charenc=UTF-8${fontsArg}[outv]`
    );
  }
  return parts.join(';');
}

/** Escape a path for use inside a ffmpeg filter argument (single-quoted). */
function escapeFilterPath(p: string): string {
  // Inside single quotes ffmpeg filter syntax treats `\` as escape, so
  // we escape backslashes; single quotes themselves need `'\''` style.
  return p.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
}

/**
 * Bake color tags into the encoder's bitstream as well as the container.
 * x264 and x265 take the tags through different param strings; both need
 * a translated "value" map for tags ffmpeg's CLI accepts but the encoder
 * doesn't (e.g. ffmpeg accepts 'smpte170m' for color_primaries but x264
 * wants 'smpte170m' too — they happen to match, so no translation needed
 * for the tags we forward).
 */
function colorTagsAsEncoderParam(
  encoder: 'libx264' | 'libx265',
  colorPrimaries: string,
  colorTransfer: string,
  colorMatrix: string
): string[] | null {
  const params = `colorprim=${colorPrimaries}:transfer=${colorTransfer}:colormatrix=${colorMatrix}`;
  if (encoder === 'libx264') return ['-x264-params', params];
  if (encoder === 'libx265') return ['-x265-params', params];
  return null;
}

/**
 * Normalise a variant's segment list into a safe keep list for export.
 *
 * Preserves the user's order and ALL repetitions/overlaps. ffmpeg's
 * concat filter happily concatenates any sequence — including the same
 * source range twice in a row — so we don't need to dedupe or sort.
 *
 * Previously we sorted by start + merged overlaps which made sense when
 * variants were AI-generated (always sorted, never overlapping). Once
 * the UI started supporting manual reorder + overlap + repeat, the
 * export ignored those edits: segments came out time-sorted instead of
 * playback-order, and a "use clip X twice" pattern collapsed to once.
 *
 * What we still do: clamp each range to [0, duration] and drop empty /
 * NaN ranges so malformed input can't crash ffmpeg.
 */
function mergeKeeps(raw: readonly Range[], duration: number): Range[] {
  const safe: Range[] = [];
  for (const r of raw) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const s = Math.max(0, r.start);
    const e = Math.min(duration, r.end);
    if (e > s) safe.push({ start: s, end: e });
  }
  return safe;
}
