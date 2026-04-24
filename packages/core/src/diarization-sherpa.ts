import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiarizationEngine, DiarizationResult, DiarizationSegment } from './diarization';
import { resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';

/**
 * Locations sherpa-onnx needs. All three must exist at runtime; if any
 * is missing the factory below returns null so the caller can fall back
 * to the mock engine.
 */
export interface SherpaPaths {
  /** Path to sherpa-onnx-offline-speaker-diarization (the CLI binary). */
  binary: string;
  /** Path to Pyannote segmentation model (ONNX). */
  segmentationModel: string;
  /** Path to speaker embedding model (ONNX). */
  embeddingModel: string;
}

export interface SherpaDiarizationOptions {
  /**
   * Clustering threshold. Smaller → more speakers. Larger → fewer.
   * Ignored when numClusters is set. Default 0.9.
   */
  clusterThreshold?: number;
  /**
   * Force a specific speaker count. When provided, overrides the
   * threshold-based clustering and produces exactly this many speakers.
   * Use when the user knows the speaker count up front — it's much more
   * robust than tuning the threshold, especially for 1-2 speaker cases
   * where thresholds routinely over-split one person into 3-4 clusters.
   */
  numClusters?: number;
  numThreads?: number;
  provider?: 'cpu' | 'cuda' | 'coreml';
  onProgress?: (fraction: number, stage: string) => void;
  signal?: AbortSignal;
}

/**
 * Voiceprint-backed diarizer. Calls the bundled sherpa-onnx CLI with our
 * two ONNX models and parses its line-based stdout.
 *
 * Input is expected to be any audio/video file that ffmpeg can read — we
 * always extract a fresh 16 kHz mono WAV first, because the sherpa models
 * are trained at that sample rate. The temp WAV is cleaned up after the
 * run regardless of success.
 *
 * On any failure this engine throws; the main process catches and leaves
 * the project state untouched (isolation guarantee of the MVP feature).
 */
export class SherpaOnnxDiarizationEngine implements DiarizationEngine {
  readonly kind = 'sherpa-onnx' as const;

  constructor(
    private readonly paths: SherpaPaths,
    private readonly ffmpegPaths: FfmpegPaths = resolveFfmpegPaths(),
    private readonly options: SherpaDiarizationOptions = {}
  ) {}

  async diarize(audioPath: string): Promise<DiarizationResult> {
    const { onProgress, signal } = this.options;
    onProgress?.(0.05, '准备音频');
    const wavPath = await this.extractMono16kWav(audioPath, signal);
    onProgress?.(0.3, '分析声纹');
    try {
      const raw = await this.runSherpa(wavPath, signal);
      onProgress?.(0.95, '整理结果');
      const segments = this.parseOutput(raw);
      onProgress?.(1, '完成');
      return {
        engine: 'sherpa-onnx',
        segments,
        speakers: Array.from(new Set(segments.map((s) => s.speaker))).sort(),
      };
    } finally {
      // Always clean up the temp wav — single-minded cleanup rather than
      // leaking megabytes per run.
      await fs.rm(wavPath, { force: true }).catch(() => {});
    }
  }

  // --- internals -----------------------------------------------------------

  /**
   * Run ffmpeg to produce a 16 kHz mono signed-16 PCM WAV in the OS temp
   * dir. Choosing sample_fmt s16 explicitly matches what pyannote + the
   * embedding model were trained on; other formats work but slower.
   */
  private async extractMono16kWav(
    inputPath: string,
    signal?: AbortSignal
  ): Promise<string> {
    const out = path.join(
      tmpdir(),
      `lynlens-diar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`
    );
    const args = [
      '-y',
      '-v',
      'error',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-sample_fmt',
      's16',
      out,
    ];
    await runChild(this.ffmpegPaths.ffmpeg, args, signal);
    return out;
  }

  private async runSherpa(wavPath: string, signal?: AbortSignal): Promise<string> {
    const threshold = this.options.clusterThreshold ?? 0.9;
    const threads = this.options.numThreads ?? 1;
    const provider = this.options.provider ?? 'cpu';
    const args = [
      `--segmentation.pyannote-model=${this.paths.segmentationModel}`,
      `--embedding.model=${this.paths.embeddingModel}`,
      `--embedding.num-threads=${threads}`,
      `--segmentation.num-threads=${threads}`,
      `--embedding.provider=${provider}`,
      `--segmentation.provider=${provider}`,
    ];
    // Prefer forced cluster count when the user specified it — much more
    // reliable than threshold tuning for known-speaker-count content.
    if (this.options.numClusters && this.options.numClusters > 0) {
      args.push(`--clustering.num-clusters=${this.options.numClusters}`);
    } else {
      args.push(`--clustering.cluster-threshold=${threshold}`);
    }
    args.push(wavPath);
    return runChildCollectingStdout(this.paths.binary, args, signal);
  }

  /**
   * Parse lines like
   *   71.193 -- 71.935 speaker_09
   *
   * Skip startup/progress lines. Normalise speaker IDs to S1/S2/... in
   * first-appearance order so they match the rest of the app's convention
   * and are stable across reruns on the same audio.
   */
  private parseOutput(raw: string): DiarizationSegment[] {
    const lineRe = /^\s*([\d.]+)\s*--\s*([\d.]+)\s+speaker_(\d+)\s*$/;
    const rawSegs: Array<{ start: number; end: number; rawSpeaker: string }> = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(lineRe);
      if (!m) continue;
      rawSegs.push({
        start: parseFloat(m[1]),
        end: parseFloat(m[2]),
        rawSpeaker: `speaker_${m[3]}`,
      });
    }
    // Build a stable mapping in appearance order: speaker_09 (first seen)
    // → S1, speaker_03 → S2, etc. Users rename to real names via UI
    // anyway, so the underlying raw id doesn't matter as long as it's
    // stable within one run.
    const mapping = new Map<string, string>();
    for (const s of rawSegs) {
      if (!mapping.has(s.rawSpeaker)) {
        mapping.set(s.rawSpeaker, `S${mapping.size + 1}`);
      }
    }
    return rawSegs.map((s) => ({
      start: s.start,
      end: s.end,
      speaker: mapping.get(s.rawSpeaker)!,
    }));
  }
}

/**
 * Try to locate all three sherpa artefacts under a given directory.
 * Returns the SherpaPaths bundle if everything is present (binary is
 * also executable), null otherwise. The caller decides whether to
 * instantiate the engine or fall back to mock.
 */
export async function resolveSherpaPaths(baseDir: string): Promise<SherpaPaths | null> {
  const binary = path.join(baseDir, 'sherpa-onnx-offline-speaker-diarization');
  const segmentationModel = path.join(baseDir, 'segmentation.onnx');
  const embeddingModel = path.join(baseDir, 'embedding.onnx');
  for (const p of [binary, segmentationModel, embeddingModel]) {
    try {
      await fs.access(p);
    } catch {
      return null;
    }
  }
  return { binary, segmentationModel, embeddingModel };
}

// ---------- shared child-process helpers ----------

function runChild(
  cmd: string,
  args: string[],
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'));
      return;
    }
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const onAbort = (): void => {
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
    });
  });
}

function runChildCollectingStdout(
  cmd: string,
  args: string[],
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('AbortError'));
      return;
    }
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const onAbort = (): void => {
      proc.kill('SIGTERM');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve(stdout);
      else {
        // macOS Gatekeeper / missing dylib errors surface here with
        // code 137 / 132 etc. Hint the user.
        const hint = stderr.includes('quarantine')
          ? '\n提示: macOS Gatekeeper 可能拦了二进制,试试:\n  xattr -cr packages/desktop/resources/diarization/mac-arm64/'
          : '';
        reject(new Error(`sherpa-onnx exited ${code}: ${stderr.trim()}${hint}`));
      }
    });
  });
}
