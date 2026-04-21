import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VideoMeta } from './types';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * Resolve ffmpeg/ffprobe binaries. Caller (desktop/cli) can override by passing paths.
 * Defaults to `ffmpeg` / `ffprobe` on PATH.
 */
export function resolveFfmpegPaths(override?: Partial<FfmpegPaths>): FfmpegPaths {
  return {
    ffmpeg: override?.ffmpeg ?? process.env.LYNLENS_FFMPEG ?? 'ffmpeg',
    ffprobe: override?.ffprobe ?? process.env.LYNLENS_FFPROBE ?? 'ffprobe',
  };
}

interface ProbeFormat {
  duration?: string;
  format_name?: string;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  tags?: Record<string, string>;
  side_data_list?: Array<{
    side_data_type?: string;
    rotation?: number;
  }>;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: ProbeFormat;
}

export async function probeVideo(videoPath: string, paths = resolveFfmpegPaths()): Promise<VideoMeta> {
  // Prefer ffprobe (clean JSON). If unavailable, fall back to parsing `ffmpeg -i` stderr.
  try {
    return await probeWithFfprobe(videoPath, paths);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = (err as Error).message ?? '';
    if (code === 'ENOENT' || /ENOENT|not found|not recognized/i.test(message)) {
      return probeWithFfmpeg(videoPath, paths);
    }
    throw err;
  }
}

async function probeWithFfprobe(videoPath: string, paths: FfmpegPaths): Promise<VideoMeta> {
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    videoPath,
  ];
  const out = await runAndCollect(paths.ffprobe, args);
  let parsed: ProbeResult;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    throw new Error(`ffprobe did not return JSON: ${out.stdout.slice(0, 200)}`);
  }
  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  if (!videoStream) throw new Error(`No video stream found in ${videoPath}`);
  const fps = parseRatio(videoStream.avg_frame_rate ?? videoStream.r_frame_rate ?? '30/1') || 30;
  return {
    duration: Number(parsed.format?.duration ?? 0),
    width: videoStream.width ?? 0,
    height: videoStream.height ?? 0,
    fps,
    codec: videoStream.codec_name ?? 'unknown',
    rotation: extractRotation(videoStream),
  };
}

/**
 * Normalise rotation to 0 / 90 / 180 / 270. Side-data uses signed degrees
 * (typically -90 for "portrait recorded with phone rotated CCW" etc.); legacy
 * MP4 tags use `rotate` with positive CW degrees.
 */
function extractRotation(stream: ProbeStream): number {
  const fromSide = stream.side_data_list?.find((s) => s.side_data_type === 'Display Matrix');
  if (fromSide && Number.isFinite(fromSide.rotation)) {
    return normalizeRotation(fromSide.rotation as number);
  }
  const legacy = stream.tags?.rotate;
  if (legacy != null) return normalizeRotation(Number(legacy));
  return 0;
}

function normalizeRotation(deg: number): number {
  const n = ((Math.round(deg) % 360) + 360) % 360;
  return n;
}

/**
 * Fallback probe using `ffmpeg -i`, which writes metadata to stderr. We parse
 * Duration / Stream lines. Slower than ffprobe but works without it.
 */
async function probeWithFfmpeg(videoPath: string, paths: FfmpegPaths): Promise<VideoMeta> {
  return new Promise<VideoMeta>((resolve, reject) => {
    const proc = spawn(paths.ffmpeg, ['-hide_banner', '-i', videoPath], { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', () => {
      try {
        const duration = parseDurationLine(stderr);
        const videoStream = parseVideoStreamLine(stderr);
        if (!videoStream) return reject(new Error(`No video stream found in ${videoPath}`));
        // ffmpeg 7 prints: "    displaymatrix: rotation of -90.00 degrees"
        const rotMatch = stderr.match(/displaymatrix:\s*rotation of\s*(-?\d+(?:\.\d+)?)\s*degrees/i)
          ?? stderr.match(/rotate\s*:\s*(-?\d+)/i);
        const rotation = rotMatch ? normalizeRotation(Number(rotMatch[1])) : 0;
        resolve({
          duration,
          width: videoStream.width,
          height: videoStream.height,
          fps: videoStream.fps || 30,
          codec: videoStream.codec || 'unknown',
          rotation,
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

function parseDurationLine(stderr: string): number {
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseVideoStreamLine(
  stderr: string
): { width: number; height: number; fps: number; codec: string } | null {
  // Find the full "Stream #...: Video: ..." line (pixel format may contain
  // commas inside parens like yuv420p10le(tv, bt2020nc/bt2020/arib-std-b67),
  // so we can't rely on comma splits).
  const lineMatch = stderr.match(/Stream #\d+:\d+.*?: Video:[^\n]*/);
  if (!lineMatch) return null;
  const line = lineMatch[0];
  // Codec name is the first word after "Video: "
  const codecMatch = line.match(/Video:\s*([^\s,(]+)/);
  const codec = codecMatch ? codecMatch[1] : 'unknown';
  // Resolution: first NxN group with 3-5 digits on each side.
  const resMatch = line.match(/\b(\d{3,5})x(\d{3,5})\b/);
  if (!resMatch) return null;
  const width = Number(resMatch[1]);
  const height = Number(resMatch[2]);
  // fps: look for "<number> fps" first, then "<number> tbr"
  const fpsMatch = line.match(/(\d+(?:\.\d+)?)\s*fps/) ?? line.match(/(\d+(?:\.\d+)?)\s*tbr/);
  const fps = Number(fpsMatch?.[1] ?? 30);
  return { width, height, fps, codec };
}

function parseRatio(s: string): number {
  const [num, den] = s.split('/').map(Number);
  if (!den) return num || 0;
  return num / den;
}

async function runAndCollect(
  cmd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => (stdout += d.toString()));
    proc.stderr?.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

export interface RunProgress {
  /** Current time in seconds being processed in the output. */
  outTime: number;
  /** Raw progress line (keyword=value form). */
  raw: string;
}

export interface RunFfmpegOptions {
  args: string[];
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
  /** Total output duration in seconds; used to compute percent externally. */
  ffmpegPath?: string;
}

/**
 * Run ffmpeg with progress via -progress pipe:1.
 * Returns when process exits cleanly, rejects on non-zero exit or abort.
 */
export function runFfmpeg(options: RunFfmpegOptions): Promise<void> {
  const ffmpeg = options.ffmpegPath ?? resolveFfmpegPaths().ffmpeg;
  const args = ['-progress', 'pipe:1', '-nostats', '-hide_banner', ...options.args];
  return new Promise<void>((resolve, reject) => {
    const proc: ChildProcess = spawn(ffmpeg, args, { windowsHide: true });
    let stderrTail = '';
    const MAX_TAIL = 4000;

    proc.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        // Lines look like: key=value
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          const micro = Number(value);
          if (Number.isFinite(micro) && micro >= 0) {
            const seconds = key === 'out_time_us' ? micro / 1_000_000 : micro / 1_000_000;
            options.onProgress?.({ outTime: seconds, raw: line });
          }
        }
      }
    });
    proc.stderr?.on('data', (buf: Buffer) => {
      stderrTail += buf.toString();
      if (stderrTail.length > MAX_TAIL) stderrTail = stderrTail.slice(-MAX_TAIL);
    });

    const onAbort = () => {
      if (!proc.killed) {
        // ffmpeg responds to 'q' on stdin for a graceful quit; fallback to SIGKILL.
        try {
          proc.stdin?.write('q');
        } catch {
          /* noop */
        }
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 500);
      }
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort);
      if (options.signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code=${code} signal=${signal}: ${stderrTail}`));
    });
  });
}

export interface WaveformEnvelope {
  /** Peak amplitude per bucket, 0..1 */
  peak: Float32Array;
  /** RMS amplitude per bucket, 0..1 */
  rms: Float32Array;
}

/**
 * Extract a mono 16kHz PCM s16le audio stream and down-sample into `buckets`
 * evenly-spaced envelope values. Returns BOTH peak and RMS arrays per bucket —
 * peak is for outer envelope, rms is for inner "body" envelope (cleaner look).
 */
export async function extractWaveform(
  videoPath: string,
  buckets: number,
  paths = resolveFfmpegPaths(),
  signal?: AbortSignal
): Promise<WaveformEnvelope> {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-i', videoPath,
      '-ac', '1',
      '-ar', '16000',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      'pipe:1',
    ];
    const proc = spawn(paths.ffmpeg, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const onAbort = () => {
      if (!proc.killed) proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      if (code !== 0) return reject(new Error(`ffmpeg wave extract failed: ${stderr}`));
      const all = Buffer.concat(chunks);
      const samples = new Int16Array(all.buffer, all.byteOffset, all.byteLength / 2);
      const peak = new Float32Array(buckets);
      const rms = new Float32Array(buckets);
      if (samples.length === 0) return resolve({ peak, rms });
      const perBucket = samples.length / buckets;
      for (let i = 0; i < buckets; i++) {
        const start = Math.floor(i * perBucket);
        const end = Math.min(samples.length, Math.floor((i + 1) * perBucket));
        let localPeak = 0;
        let sumSq = 0;
        const count = Math.max(1, end - start);
        for (let j = start; j < end; j++) {
          const s = samples[j];
          const a = s < 0 ? -s : s;
          if (a > localPeak) localPeak = a;
          sumSq += s * s;
        }
        peak[i] = localPeak / 32768;
        rms[i] = Math.sqrt(sumSq / count) / 32768;
      }
      resolve({ peak, rms });
    });
  });
}

export async function mkTmpDir(prefix = 'lynlens-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
