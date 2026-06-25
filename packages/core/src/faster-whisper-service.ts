/**
 * faster-whisper as a drop-in TranscriptionService. It only changes the
 * RECOGNITION step (spawns the user's embedded-Python fw_align.py on GPU); the
 * cut handling and segmentation reuse the exact same shared helpers as the
 * bundled whisper.cpp path (prepareTranscribeAudio + finalizeTranscript), so
 * 粗剪 / agent / Lynscripe all get identically-shaped transcripts.
 *
 * Path resolution (which python.exe, which model snapshot) is electron-specific
 * and lives in the desktop main process; it's injected here via constructor.
 */
import { spawn } from 'node:child_process';
import { v4 as uuid } from 'uuid';
import { resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';
import {
  finalizeTranscript,
  prepareTranscribeAudio,
  type TranscribeOptions,
  type TranscriptionService,
} from './transcription';
import type { Transcript, TranscriptSegment, TranscriptWord } from './types';

export interface FasterWhisperServiceOptions {
  /** Embedded python.exe inside the user's faster-whisper pack. */
  pythonPath: string;
  /** Absolute path to fw_align.py. */
  scriptPath: string;
  /** The CT2 model snapshot directory to load. */
  modelDir: string;
  /** The pack's cuda_dll directory (added to the DLL search path). */
  cudaDll: string;
  ffmpegPaths?: FfmpegPaths;
}

interface FwRawSegment {
  start: number;
  end: number;
  text: string;
  words: Array<{ w: string; start: number; end: number }>;
}
interface FwRaw {
  language: string;
  segments: FwRawSegment[];
}

/** Spawn fw_align.py on the given audio → parsed {language, segments[]}. */
export function runFasterWhisper(
  opts: FasterWhisperServiceOptions,
  audioPath: string,
  language: string,
  signal?: AbortSignal
): Promise<FwRaw> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      opts.pythonPath,
      [
        opts.scriptPath,
        '--model-dir', opts.modelDir,
        '--audio', audioPath,
        '--language', language || 'auto',
        '--cuda-dll', opts.cudaDll,
      ],
      { windowsHide: true }
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (d: Buffer) => (out += d.toString('utf-8')));
    proc.stderr.on('data', (d: Buffer) => (err += d.toString('utf-8')));
    const onAbort = (): void => {
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      if (code !== 0) return reject(new Error(`faster-whisper failed (code ${code}): ${err.slice(-400)}`));
      try {
        const parsed = JSON.parse(out.trim()) as Partial<FwRaw>;
        resolve({
          language: parsed.language ?? 'auto',
          segments: Array.isArray(parsed.segments) ? (parsed.segments as FwRawSegment[]) : [],
        });
      } catch (e) {
        reject(new Error(`faster-whisper output parse failed: ${(e as Error).message}`));
      }
    });
  });
}

/** Build a raw Transcript from faster-whisper segments (pre cut/segmentation). */
export function parseFasterWhisperJson(raw: FwRaw, model: string): Transcript {
  const segments: TranscriptSegment[] = raw.segments
    .map((s) => ({
      id: `fw_${uuid().slice(0, 8)}`,
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text: String(s.text ?? '').trim(),
      words: (Array.isArray(s.words) ? s.words : []).map((w) => ({
        w: String(w.w ?? ''),
        start: Number(w.start) || 0,
        end: Number(w.end) || 0,
      })),
    }))
    .filter((s) => s.text.length > 0);
  return { language: raw.language || 'auto', engine: 'faster-whisper', model, segments };
}

/** Flat word timings (for Lynscripe char-alignment, which needs raw words). */
export async function fasterWhisperWords(
  opts: FasterWhisperServiceOptions,
  audioPath: string,
  language = 'auto',
  signal?: AbortSignal
): Promise<{ words: TranscriptWord[]; language: string }> {
  const raw = await runFasterWhisper(opts, audioPath, language, signal);
  const words: TranscriptWord[] = raw.segments.flatMap((s) =>
    s.words.map((w) => ({ w: w.w, start: w.start, end: w.end }))
  );
  return { words, language: raw.language };
}

export class FasterWhisperLocalService implements TranscriptionService {
  constructor(private readonly opts: FasterWhisperServiceOptions) {}

  async transcribe(input: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const prep = await prepareTranscribeAudio(
      input,
      options,
      this.opts.ffmpegPaths ?? resolveFfmpegPaths()
    );
    try {
      options.onProgress?.(10);
      const raw = await runFasterWhisper(
        this.opts,
        prep.wavPath,
        options.language ?? 'auto',
        options.signal
      );
      options.onProgress?.(100);
      const transcript = parseFasterWhisperJson(raw, options.model ?? 'faster-whisper');
      return finalizeTranscript(transcript, options, prep);
    } finally {
      await prep.cleanup();
    }
  }
}
