import { promises as fs } from 'node:fs';
import path from 'node:path';
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
   * Single export pipeline: frame-accurate cuts via filter_complex + explicit
   * color metadata forwarding. Two output regimes:
   *
   *   - HDR source (HLG / PQ / Dolby Vision) → tone-map to SDR BT.709 8-bit
   *     via zscale + tonemap filters, encode with libx264. Reason: Windows
   *     native player and most browsers can't decode HDR transfer functions
   *     correctly and render BT.2020 as BT.709, producing visible color
   *     shift (the user reported this with iPhone 15 Pro Dolby Vision
   *     recordings — base layer shows washed-out / wrong color on Windows).
   *     Tone-mapping sacrifices HDR highlight fidelity for universal
   *     compatibility. For talking-head content this is the right tradeoff.
   *
   *   - SDR source (BT.709 / BT.601, 8-bit OR 10-bit but not HDR) → forward
   *     color tags as-is. Encoder picked from bit depth (libx265 for 10-bit
   *     to preserve quality, libx264 otherwise).
   *
   * Color tags (primaries / transfer / matrix / range) are forwarded both
   * at container level (-colorspace etc.) and baked into the bitstream via
   * -x264-params / -x265-params so strict players don't guess.
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
    const filter = isHdr
      ? buildConcatFilter(keeps, rotation, {
          // Explicit input color tags so zscale doesn't have to guess from
          // frame metadata (which `concat` may have stripped). Without this,
          // the linearize step can mis-interpret HLG as SDR and produce
          // washed-out / shifted output.
          inTransfer: colorMeta.colorTransfer === 'unknown' ? 'arib-std-b67' : colorMeta.colorTransfer,
          inMatrix: colorMeta.colorSpace === 'unknown' ? 'bt2020nc' : colorMeta.colorSpace,
          inPrimaries: colorMeta.colorPrimaries === 'unknown' ? 'bt2020' : colorMeta.colorPrimaries,
          inRange: colorMeta.colorRange === 'unknown' ? 'tv' : colorMeta.colorRange,
        })
      : buildConcatFilter(keeps, rotation);

    let encoder: 'libx264' | 'libx265';
    let outPixFmt: string;
    let colorPrimaries: string;
    let colorTransfer: string;
    let colorSpace: string;
    let colorRange: 'tv' | 'pc';

    if (isHdr) {
      // Tone-mapped output: always SDR BT.709 8-bit, libx264 for universality.
      encoder = 'libx264';
      outPixFmt = 'yuv420p';
      colorPrimaries = 'bt709';
      colorTransfer = 'bt709';
      colorSpace = 'bt709';
      colorRange = 'tv';
    } else {
      // SDR passthrough: keep source bit depth, forward tags. "unknown" tags
      // fall back to BT.709 SDR limited (safe default for missing metadata).
      const use10Bit = colorMeta.bitDepth >= 10;
      encoder = use10Bit ? 'libx265' : 'libx264';
      outPixFmt = use10Bit ? 'yuv420p10le' : 'yuv420p';
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

    const args: string[] = [
      '-v', 'error',
      // Disable implicit auto-rotation so our explicit transpose filter is
      // the single source of truth for orientation (avoids double rotation
      // on ffmpeg versions that auto-rotate before filter_complex).
      '-noautorotate',
      '-i', videoPath,
      '-filter_complex', filter,
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
    // Bitstream-level color tags (so the encoder writes them into the SPS/VPS).
    if (encParam) args.push(...encParam);
    args.push(
      '-c:a', 'aac',
      '-b:a', '192k',
      // Clear any legacy rotate tag / display matrix on the output so
      // players don't try to rotate our already-rotated pixels a second time.
      '-metadata:s:v:0', 'rotate=0',
      '-movflags', '+faststart',
      '-y',
      outputPath
    );

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
    this.eventBus.emit({ type: 'export.progress', projectId, percent: 100, stage: '完成' });
  }
}

/**
 * Convert a container-level rotation metadata (0/90/180/270, CW positive in
 * ffprobe 'Display Matrix' side-data terms) to an ffmpeg filter chain that
 * re-applies the visual rotation after decoding.
 *
 * In ffmpeg's Display Matrix convention the rotation reported is the angle
 * the video should be displayed at. So if probe says -90 we need to rotate
 * the raw frames 90° CCW to see them upright (= transpose=2). If it says 90
 * we need 90° CW (= transpose=1). 180 is a double transpose.
 */
function rotationFilter(rotation: number): string {
  const r = ((Math.round(rotation) % 360) + 360) % 360;
  switch (r) {
    case 90:  return 'transpose=1,';
    case 180: return 'transpose=1,transpose=1,';
    case 270: return 'transpose=2,';
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

export function buildConcatFilter(
  keeps: Range[],
  rotation = 0,
  hdrToSdr: HdrToSdrTags | false = false
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
  // When tone-mapping HDR → SDR, route concat output through a tonemap
  // chain before exposing [outv]. Standard Hable curve, no desaturation,
  // primaries → BT.709, transfer → BT.709, output in 8-bit yuv420p so
  // libx264 can encode it. Explicit input tags (tin/min/pin/rin) make
  // the linearize step deterministic regardless of what concat did to
  // the frame metadata.
  if (hdrToSdr) {
    parts.push(`${labels.join('')}concat=n=${keeps.length}:v=1:a=1[outv_pre][outa]`);
    const t = hdrToSdr;
    parts.push(
      '[outv_pre]' +
        `zscale=tin=${t.inTransfer}:min=${t.inMatrix}:pin=${t.inPrimaries}:rin=${t.inRange}:t=linear:npl=100,` +
        'format=gbrpf32le,' +
        'zscale=p=bt709,' +
        'tonemap=tonemap=hable:desat=0,' +
        'zscale=t=bt709:m=bt709:r=tv,' +
        'format=yuv420p' +
        '[outv]'
    );
  } else {
    parts.push(`${labels.join('')}concat=n=${keeps.length}:v=1:a=1[outv][outa]`);
  }
  return parts.join(';');
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
 * Normalise a variant's segment list into a safe keep list: sort, clamp to
 * [0, duration], drop empty ranges, merge overlaps. Reused by highlight
 * variant export so malformed model output can't crash ffmpeg.
 */
function mergeKeeps(raw: readonly Range[], duration: number): Range[] {
  const clamped: Range[] = [];
  for (const r of raw) {
    if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) continue;
    const s = Math.max(0, r.start);
    const e = Math.min(duration, r.end);
    if (e > s) clamped.push({ start: s, end: e });
  }
  clamped.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of clamped) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }
  return merged;
}
