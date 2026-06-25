/**
 * Stage 1 — Gemini Flash text provider. Decoupled behind TranscriptTextProvider
 * so a future local/multimodal model can replace it without touching callers.
 *
 * No SDK (doc §4): plain REST via global fetch (Electron main / Node 18+). Flow:
 *   1. ffmpeg → 16k mono WAV (small, universal codec; speech-grade).
 *   2. Gemini Files API resumable upload → file_uri.
 *   3. generateContent(audio + prompt, responseMimeType=json) → template JSON.
 *   4. DELETE the uploaded file (doc §6.4 — leaked files burn quota).
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { mkTmpDir, resolveFfmpegPaths, type FfmpegPaths } from '../ffmpeg';
import { parseTranscriptTemplate } from './template';
import { buildTranscribeSystemPrompt, buildTranscribeUserPrompt } from './prompt';
import type { TranscriptTemplate, TranscriptTextProvider, VocabEntry } from './types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

export interface GeminiProviderOptions {
  apiKey: string;
  /** e.g. 'gemini-2.5-flash'. */
  model?: string;
  ffmpegPaths?: FfmpegPaths;
}

/** Extract a 16k mono WAV from any media file (speech-grade, codec always present). */
async function extractWav(
  input: string,
  ffmpeg: string,
  signal?: AbortSignal
): Promise<{ wavPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkTmpDir('lynscripe-audio-');
  const wavPath = path.join(dir, 'audio.wav');
  const args = ['-v', 'error', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', wavPath];
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { windowsHide: true });
    const onAbort = (): void => {
      proc.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
      if (code !== 0) return reject(new Error(`ffmpeg audio extract failed: ${stderr.slice(0, 300)}`));
      resolve();
    });
  });
  return {
    wavPath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/** Resumable upload of a local file to the Gemini Files API → its file URI. */
async function uploadFile(
  wavPath: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<{ uri: string; name: string }> {
  const bytes = await fs.readFile(wavPath);
  const displayName = 'lynscripe-audio';
  // 1) Start a resumable session.
  const startRes = await fetch(`${GEMINI_BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    signal,
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(bytes.length),
      'X-Goog-Upload-Header-Content-Type': 'audio/wav',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName } }),
  });
  if (!startRes.ok) {
    throw new Error(`Gemini upload start failed (${startRes.status}): ${await safeText(startRes)}`);
  }
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini upload start: missing upload URL header');
  // 2) Upload bytes + finalize.
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    signal,
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Length': String(bytes.length),
    },
    body: bytes,
  });
  if (!upRes.ok) {
    throw new Error(`Gemini upload failed (${upRes.status}): ${await safeText(upRes)}`);
  }
  const json = (await upRes.json()) as { file?: { uri?: string; name?: string; state?: string } };
  const uri = json.file?.uri;
  const name = json.file?.name;
  if (!uri || !name) throw new Error('Gemini upload: response missing file uri/name');
  // 3) Wait until the file is ACTIVE (audio is usually instant; poll briefly).
  let state = json.file?.state ?? 'PROCESSING';
  for (let i = 0; i < 30 && state !== 'ACTIVE'; i++) {
    if (state === 'FAILED') throw new Error('Gemini file processing FAILED');
    await delay(1000, signal);
    const poll = await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${apiKey}`, { signal });
    if (poll.ok) {
      const pj = (await poll.json()) as { state?: string };
      state = pj.state ?? state;
    }
  }
  return { uri, name };
}

async function deleteFile(name: string, apiKey: string): Promise<void> {
  await fetch(`${GEMINI_BASE}/v1beta/${name}?key=${apiKey}`, { method: 'DELETE' }).catch(() => {});
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '<no body>';
  }
}

export class GeminiTranscribeProvider implements TranscriptTextProvider {
  readonly id: string;
  readonly label = 'Gemini Flash';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly ffmpeg: string;

  constructor(opts: GeminiProviderOptions) {
    if (!opts.apiKey) throw new Error('Gemini provider requires an API key');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gemini-2.5-flash';
    this.id = this.model;
    this.ffmpeg = (opts.ffmpegPaths ?? resolveFfmpegPaths()).ffmpeg;
  }

  async transcribeToTemplate(opts: {
    audioPath: string;
    vocab: VocabEntry[];
    language?: string;
    signal?: AbortSignal;
  }): Promise<TranscriptTemplate> {
    const { wavPath, cleanup } = await extractWav(opts.audioPath, this.ffmpeg, opts.signal);
    let uploaded: { uri: string; name: string } | null = null;
    try {
      uploaded = await uploadFile(wavPath, this.apiKey, opts.signal);
      const systemPrompt = buildTranscribeSystemPrompt();
      const userPrompt = buildTranscribeUserPrompt({ vocab: opts.vocab, language: opts.language });
      const res = await fetch(
        `${GEMINI_BASE}/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        {
          method: 'POST',
          signal: opts.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [
              {
                role: 'user',
                parts: [
                  { file_data: { mime_type: 'audio/wav', file_uri: uploaded.uri } },
                  { text: userPrompt },
                ],
              },
            ],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.2,
              // A long transcript is a lot of output tokens — give it room so the
              // JSON isn't truncated mid-stream.
              maxOutputTokens: 65536,
              // gemini-2.5-flash THINKS by default, and thinking tokens are drawn
              // from the SAME output budget. On a long audio the model can spend
              // the whole budget thinking and return ZERO visible text (the
              // "empty transcription" symptom). Transcription needs no reasoning,
              // so disable thinking — faster, cheaper, and always yields text.
              thinkingConfig: { thinkingBudget: 0 },
            },
            // We're transcribing real speech verbatim, so the safety filters must
            // not redact it. Set every configurable category to the most
            // permissive threshold — without this, ordinary speech (slang,
            // banter) can be false-flagged and the whole transcript is dropped.
            safetySettings: [
              { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
              { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
            ],
          }),
        }
      );
      if (!res.ok) {
        throw new Error(`Gemini generateContent failed (${res.status}): ${await safeText(res)}`);
      }
      const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
      };
      const cand = data.candidates?.[0];
      const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      if (!text.trim()) {
        const reason = cand?.finishReason ?? data.promptFeedback?.blockReason ?? 'unknown';
        throw new Error(
          `Gemini 没有返回文本 (finishReason=${reason})。` +
            (reason === 'MAX_TOKENS'
              ? '输出超长被截断——音频太长,建议分段转录。'
              : reason === 'SAFETY' || reason === 'RECITATION'
                ? '被安全策略拦截。'
                : reason === 'PROHIBITED_CONTENT' || reason === 'BLOCKLIST' || reason === 'SPII'
                  ? '被 Gemini 内容过滤误判拦截(安全阈值已放到最低仍被拦)。多为整段里某句触发的偶发误报,可重试;若一直失败,改用分段转录或换个模型。'
                  : '可能是 key 权限或模型不可用。')
        );
      }
      return parseTranscriptTemplate(text, this.model);
    } finally {
      if (uploaded) void deleteFile(uploaded.name, this.apiKey);
      await cleanup();
    }
  }
}
