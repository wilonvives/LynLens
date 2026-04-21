import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { mkTmpDir, resolveFfmpegPaths, type FfmpegPaths } from './ffmpeg';
import type { Transcript, TranscriptSegment, TranscriptWord } from './types';

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface TranscribeOptions {
  engine?: 'whisper-local' | 'openai-api';
  model?: WhisperModel;
  language?: string;
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
}

export interface TranscriptionService {
  transcribe(audioOrVideoPath: string, options?: TranscribeOptions): Promise<Transcript>;
}

export class NullTranscriptionService implements TranscriptionService {
  async transcribe(): Promise<Transcript> {
    return { language: 'unknown', engine: 'null', model: 'none', segments: [] };
  }
}

// ---------- helpers ----------

/**
 * Convert any video/audio input to 16kHz mono wav (whisper.cpp / OpenAI
 * friendly). Returns the path; caller is responsible for cleanup.
 */
export async function toWav16kMono(
  input: string,
  ffmpegPaths: FfmpegPaths = resolveFfmpegPaths(),
  signal?: AbortSignal
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkTmpDir('lynlens-wav-');
  const wavPath = path.join(dir, 'audio.wav');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      ffmpegPaths.ffmpeg,
      [
        '-v', 'error',
        '-i', input,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        wavPath,
      ],
      { windowsHide: true }
    );
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      if (code !== 0) return reject(new Error(`ffmpeg wav extract failed: ${stderr.slice(0, 400)}`));
      resolve();
    });
  });
  return {
    wavPath,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

// ---------- whisper.cpp local ----------

export interface WhisperLocalOptions {
  /** Path to whisper-cli(.exe). */
  binaryPath: string;
  /** Path to a .bin GGML model file. */
  modelPath: string;
  ffmpegPaths?: FfmpegPaths;
}

export class WhisperLocalService implements TranscriptionService {
  constructor(private readonly opts: WhisperLocalOptions) {}

  async transcribe(input: string, options: TranscribeOptions = {}): Promise<Transcript> {
    await assertExists(this.opts.binaryPath, 'whisper binary');
    await assertExists(this.opts.modelPath, 'whisper model');
    const { wavPath, cleanup } = await toWav16kMono(
      input,
      this.opts.ffmpegPaths ?? resolveFfmpegPaths(),
      options.signal
    );

    try {
      // whisper.cpp CLI produces <output>.json when --output-json-full is passed.
      const outputBase = wavPath.replace(/\.wav$/i, '');
      const args = [
        '-m', this.opts.modelPath,
        '-l', mapLanguage(options.language ?? 'auto'),
        '-f', wavPath,
        '--output-json-full',
        '--output-file', outputBase,
        '--split-on-word',
        '--print-progress',
      ];

      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.opts.binaryPath, args, { windowsHide: true });
        let stderr = '';
        proc.stdout.on('data', (buf: Buffer) => {
          const text = buf.toString();
          const m = text.match(/progress\s*=\s*(\d+)/i);
          if (m) options.onProgress?.(Number(m[1]));
        });
        proc.stderr.on('data', (buf: Buffer) => {
          stderr += buf.toString();
          const m = stderr.match(/progress\s*=\s*(\d+)/i);
          if (m) options.onProgress?.(Number(m[1]));
        });
        const onAbort = () => proc.kill('SIGKILL');
        options.signal?.addEventListener('abort', onAbort, { once: true });
        proc.on('error', reject);
        proc.on('close', (code) => {
          options.signal?.removeEventListener('abort', onAbort);
          if (options.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
          if (code !== 0) return reject(new Error(`whisper-cli failed: ${stderr.slice(0, 400)}`));
          resolve();
        });
      });

      const jsonPath = `${outputBase}.json`;
      const raw = await fs.readFile(jsonPath, 'utf-8');
      const parsed = JSON.parse(raw);
      options.onProgress?.(100);
      return parseWhisperCppJson(parsed, options.model ?? 'base');
    } finally {
      await cleanup();
    }
  }
}

function parseWhisperCppJson(json: unknown, model: string): Transcript {
  const j = json as {
    result?: { language?: string };
    transcription?: Array<{
      timestamps?: { from: string; to: string };
      offsets?: { from: number; to: number };
      text: string;
      tokens?: Array<{ text: string; offsets?: { from: number; to: number } }>;
    }>;
  };
  const segs = (j.transcription ?? []).map((seg): TranscriptSegment => {
    const start = seg.offsets ? seg.offsets.from / 1000 : 0;
    const end = seg.offsets ? seg.offsets.to / 1000 : 0;
    const words: TranscriptWord[] = (seg.tokens ?? [])
      .filter((t) => t.offsets && !t.text.startsWith('['))
      .map((t) => ({
        w: t.text.trim(),
        start: (t.offsets!.from ?? 0) / 1000,
        end: (t.offsets!.to ?? 0) / 1000,
      }))
      .filter((w) => w.w.length > 0);
    return {
      id: `t_${uuid().slice(0, 8)}`,
      start,
      end,
      text: seg.text.trim(),
      words,
    };
  });
  return {
    language: j.result?.language ?? 'unknown',
    engine: 'whisper-cpp',
    model,
    segments: segs,
  };
}

// ---------- OpenAI Whisper API ----------

export interface WhisperApiOptions {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  /** OpenAI model name; default 'whisper-1'. */
  model?: string;
  ffmpegPaths?: FfmpegPaths;
}

export class WhisperApiService implements TranscriptionService {
  constructor(private readonly opts: WhisperApiOptions) {
    if (!opts.apiKey) throw new Error('OpenAI API key required');
  }

  async transcribe(input: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { wavPath, cleanup } = await toWav16kMono(
      input,
      this.opts.ffmpegPaths ?? resolveFfmpegPaths(),
      options.signal
    );

    try {
      const file = await fs.readFile(wavPath);
      const base = this.opts.baseUrl ?? 'https://api.openai.com/v1';
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file)], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', this.opts.model ?? 'whisper-1');
      form.append('response_format', 'verbose_json');
      form.append('timestamp_granularities[]', 'word');
      form.append('timestamp_granularities[]', 'segment');
      if (options.language && options.language !== 'auto') {
        form.append('language', mapLanguage(options.language));
      }

      options.onProgress?.(10);
      const resp = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        body: form,
        signal: options.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`OpenAI API ${resp.status}: ${txt.slice(0, 400)}`);
      }
      const data = (await resp.json()) as OpenAIVerboseJson;
      options.onProgress?.(100);
      return parseOpenAiVerbose(data, this.opts.model ?? 'whisper-1');
    } finally {
      await cleanup();
    }
  }
}

interface OpenAIVerboseJson {
  language?: string;
  segments?: Array<{ id?: number; start: number; end: number; text: string }>;
  words?: Array<{ word: string; start: number; end: number }>;
  text?: string;
}

function parseOpenAiVerbose(data: OpenAIVerboseJson, model: string): Transcript {
  const segments = (data.segments ?? []).map((s): TranscriptSegment => ({
    id: `t_${s.id ?? uuid().slice(0, 8)}`,
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    words: (data.words ?? [])
      .filter((w) => w.start >= s.start && w.end <= s.end)
      .map((w) => ({ w: w.word.trim(), start: w.start, end: w.end })),
  }));
  return {
    language: data.language ?? 'unknown',
    engine: 'openai-api',
    model,
    segments,
  };
}

// ---------- shared ----------

function mapLanguage(lang: string): string {
  if (!lang || lang === 'auto') return 'auto';
  const normalized = lang.toLowerCase();
  if (normalized.startsWith('zh')) return 'zh';
  if (normalized.startsWith('en')) return 'en';
  if (normalized.startsWith('ja')) return 'ja';
  if (normalized.startsWith('ko')) return 'ko';
  return normalized.slice(0, 2);
}

async function assertExists(p: string, label: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    throw new Error(`${label} not found at ${p}`);
  }
}

// ---------- transcript-based heuristics ----------

/**
 * Default filler / hesitation phrases per language. These are full-segment
 * matches (we flag a transcript segment as "filler" only when its text is
 * dominated by these — not when they're embedded in a longer meaningful line).
 */
export const DEFAULT_FILLERS: Record<string, string[]> = {
  zh: ['嗯', '呃', '啊', '呀', '哦', '唉', '嗨', '那个', '就是', '就是说', '然后呢', '所以说', '这个', '那什么', '怎么说呢'],
  en: ['um', 'uh', 'er', 'hmm', 'ah', 'you know', 'i mean', 'like', 'well', 'so yeah', 'anyway'],
};

export interface FillerMatch {
  start: number;
  end: number;
  text: string;
  reason: string;
  confidence: number;
}

/**
 * Detect transcript segments that are dominated by filler/hesitation words.
 * "Dominated" means: after stripping punctuation/whitespace, the remaining
 * characters are a filler phrase (or a short repetition of fillers).
 */
export function detectFillers(
  transcript: Transcript,
  extraFillers?: string[]
): FillerMatch[] {
  const lang = transcript.language?.slice(0, 2) || 'zh';
  const table = DEFAULT_FILLERS[lang] ?? DEFAULT_FILLERS.zh;
  const fillers = new Set((extraFillers ? [...table, ...extraFillers] : table).map((f) => f.toLowerCase()));
  const out: FillerMatch[] = [];
  for (const seg of transcript.segments) {
    const cleaned = seg.text
      .toLowerCase()
      .replace(/[\s，,。.!?！？:：、"'\-]/g, '');
    if (cleaned.length === 0) continue;
    // Full-segment exact-match check first
    if (fillers.has(cleaned)) {
      out.push({
        start: seg.start,
        end: seg.end,
        text: seg.text,
        reason: `语气词「${seg.text.trim()}」`,
        confidence: 0.9,
      });
      continue;
    }
    // Segment is entirely one filler repeated (e.g. "嗯嗯嗯", "uhuh")
    for (const f of fillers) {
      const stripped = cleaned.replaceAll(f, '');
      if (stripped.length === 0 && cleaned.length >= f.length) {
        out.push({
          start: seg.start,
          end: seg.end,
          text: seg.text,
          reason: `语气词「${seg.text.trim()}」`,
          confidence: 0.85,
        });
        break;
      }
    }
  }
  return out;
}

/**
 * Detect near-duplicate consecutive transcript segments (retakes). Each hit is
 * a segment whose normalized text closely matches the PREVIOUS segment.
 */
export function detectRetakes(
  transcript: Transcript,
  minSimilarity = 0.8
): FillerMatch[] {
  const out: FillerMatch[] = [];
  const segs = transcript.segments;
  for (let i = 1; i < segs.length; i++) {
    const a = normalizeText(segs[i - 1].text);
    const b = normalizeText(segs[i].text);
    if (a.length < 4 || b.length < 4) continue;
    const sim = jaccardSimilarity(a, b);
    if (sim >= minSimilarity) {
      // Mark the EARLIER one for deletion (keep the retake)
      out.push({
        start: segs[i - 1].start,
        end: segs[i - 1].end,
        text: segs[i - 1].text,
        reason: `疑似重复/重拍（和下一句相似度 ${(sim * 100).toFixed(0)}%）`,
        confidence: 0.6 + sim * 0.3,
      });
    }
  }
  return out;
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s，,。.!?！？:：、"'\-]/g, '');
}

function jaccardSimilarity(a: string, b: string): number {
  // Bigram Jaccard — cheap and language-agnostic (handles CJK fine).
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const A = grams(a);
  const B = grams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------- silence-based "built-in AI" predictor ----------

/**
 * Detect silent regions from a normalized waveform (Float32Array of peak or rms
 * amplitudes in [0,1]). Returns ranges (seconds) longer than minPauseSec where
 * amplitude stays below silenceThreshold. Powers the in-app "🤖 AI 预标记" button.
 */
export function detectSilences(
  waveform: Float32Array,
  totalDuration: number,
  options: {
    silenceThreshold?: number;
    minPauseSec?: number;
    paddingSec?: number;
  } = {}
): Array<{ start: number; end: number; reason: string }> {
  const threshold = options.silenceThreshold ?? 0.03;
  const minPause = options.minPauseSec ?? 1.0;
  const padding = options.paddingSec ?? 0.1;
  if (waveform.length === 0 || totalDuration <= 0) return [];
  const secPerBucket = totalDuration / waveform.length;
  const out: Array<{ start: number; end: number; reason: string }> = [];
  let silenceStart = -1;
  for (let i = 0; i < waveform.length; i++) {
    const isSilent = waveform[i] < threshold;
    if (isSilent && silenceStart < 0) silenceStart = i;
    if (!isSilent && silenceStart >= 0) {
      const len = (i - silenceStart) * secPerBucket;
      if (len >= minPause) {
        const start = silenceStart * secPerBucket + padding;
        const end = i * secPerBucket - padding;
        if (end > start) out.push({ start, end, reason: `停顿 ${len.toFixed(1)} 秒` });
      }
      silenceStart = -1;
    }
  }
  if (silenceStart >= 0) {
    const len = (waveform.length - silenceStart) * secPerBucket;
    if (len >= minPause) {
      const start = silenceStart * secPerBucket + padding;
      const end = totalDuration - padding;
      if (end > start) out.push({ start, end, reason: `停顿 ${len.toFixed(1)} 秒` });
    }
  }
  return out;
}
