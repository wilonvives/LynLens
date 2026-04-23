import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EventBus } from './event-bus';
import { mkTmpDir, resolveFfmpegPaths, runFfmpeg, type FfmpegPaths } from './ffmpeg';
import type { Project } from './project-manager';
import { computeKeepIntervals } from './ripple';
import type { Range } from './types';

export type ExportMode = 'fast' | 'precise';
export type ExportQuality = 'original' | 'high' | 'medium' | 'low';

export interface ExportOptions {
  outputPath: string;
  mode?: ExportMode;
  quality?: ExportQuality;
  /** MP4 or MOV. Only relevant for precise mode. */
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

    // 80%-deleted safety check only applies to the normal "trim delete
    // segments" flow. For variant export, keeping <20% of the source is
    // normal (that IS the highlight). Skip the check when keepOverride set.
    if (!options.keepOverride) {
      const totalCut =
        project.cutRanges.reduce((sum, r) => sum + (r.end - r.start), 0) +
        approvedDeletes.reduce((sum, r) => sum + (r.end - r.start), 0);
      if (totalCut > videoMeta.duration * 0.8) {
        throw new Error(
          `Refusing to export: removed ${totalCut.toFixed(2)}s exceeds 80% of total ${videoMeta.duration.toFixed(2)}s`
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
      if (mode === 'fast') {
        await this.exportFast(project.id, videoPath, keeps, outputPath, options);
      } else {
        await this.exportPrecise(
          project.id,
          videoPath,
          keeps,
          outputPath,
          options,
          videoMeta.rotation ?? 0
        );
      }
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

  /** Fast: cut with -c copy per segment, then concat demuxer. Keyframe-bound precision. */
  private async exportFast(
    projectId: string,
    videoPath: string,
    keeps: Range[],
    outputPath: string,
    options: ExportOptions
  ): Promise<void> {
    const paths = options.ffmpegPaths ?? resolveFfmpegPaths();
    const tmp = await mkTmpDir('lynlens-fast-');
    const partPaths: string[] = [];
    const totalDuration = keeps.reduce((s, r) => s + (r.end - r.start), 0);
    let processed = 0;

    try {
      const ext = path.extname(videoPath) || '.mp4';
      for (let i = 0; i < keeps.length; i++) {
        const k = keeps[i];
        const part = path.join(tmp, `part_${String(i).padStart(4, '0')}${ext}`);
        partPaths.push(part);
        const segDuration = k.end - k.start;
        const baseProcessed = processed;
        await runFfmpeg({
          ffmpegPath: paths.ffmpeg,
          signal: options.signal,
          args: [
            '-v', 'error',
            '-ss', String(k.start),
            '-to', String(k.end),
            '-i', videoPath,
            '-c', 'copy',
            '-avoid_negative_ts', 'make_zero',
            '-y',
            part,
          ],
          onProgress: ({ outTime }) => {
            const done = Math.min(outTime, segDuration);
            const percent = Math.min(99, ((baseProcessed + done) / totalDuration) * 80);
            this.eventBus.emit({
              type: 'export.progress',
              projectId,
              percent,
              stage: `切片 ${i + 1}/${keeps.length}`,
            });
          },
        });
        processed += segDuration;
      }

      // concat list file
      const listPath = path.join(tmp, 'list.txt');
      await fs.writeFile(
        listPath,
        partPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'),
        'utf-8'
      );

      await runFfmpeg({
        ffmpegPath: paths.ffmpeg,
        signal: options.signal,
        args: [
          '-v', 'error',
          '-f', 'concat',
          '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          '-y',
          outputPath,
        ],
        onProgress: ({ outTime }) => {
          const percent = 80 + Math.min(19, (outTime / totalDuration) * 19);
          this.eventBus.emit({
            type: 'export.progress',
            projectId,
            percent,
            stage: '合并',
          });
        },
      });
    } finally {
      await rmrf(tmp);
    }
    this.eventBus.emit({ type: 'export.progress', projectId, percent: 100, stage: '完成' });
  }

  /** Precise: single ffmpeg call with filter_complex, re-encodes. Frame-accurate. */
  private async exportPrecise(
    projectId: string,
    videoPath: string,
    keeps: Range[],
    outputPath: string,
    options: ExportOptions,
    rotation = 0
  ): Promise<void> {
    const paths = options.ffmpegPaths ?? resolveFfmpegPaths();
    const quality = options.quality ?? 'high';
    const crf = CRF_BY_QUALITY[quality];
    const filter = buildConcatFilter(keeps, rotation);
    const totalDuration = keeps.reduce((s, r) => s + (r.end - r.start), 0);

    await runFfmpeg({
      ffmpegPath: paths.ffmpeg,
      signal: options.signal,
      args: [
        '-v', 'error',
        // Disable implicit auto-rotation so our explicit transpose filter is
        // the single source of truth for orientation (avoids double rotation
        // on ffmpeg versions that auto-rotate before filter_complex).
        '-noautorotate',
        '-i', videoPath,
        '-filter_complex', filter,
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', String(crf),
        '-c:a', 'aac',
        '-b:a', '192k',
        // Clear any legacy rotate tag / display matrix on the output so
        // players don't try to rotate our already-rotated pixels a second time.
        '-metadata:s:v:0', 'rotate=0',
        '-movflags', '+faststart',
        '-y',
        outputPath,
      ],
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

export function buildConcatFilter(keeps: Range[], rotation = 0): string {
  if (keeps.length === 0) throw new Error('keeps is empty');
  const rot = rotationFilter(rotation);
  const parts: string[] = [];
  const labels: string[] = [];
  keeps.forEach((k, i) => {
    parts.push(`[0:v]${rot}trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`[0:a]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`);
    labels.push(`[v${i}][a${i}]`);
  });
  parts.push(`${labels.join('')}concat=n=${keeps.length}:v=1:a=1[outv][outa]`);
  return parts.join(';');
}

async function rmrf(p: string): Promise<void> {
  try {
    await fs.rm(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
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
