/**
 * Lynscripe IPC — the standalone 转录 tab's backend. PATH-BASED on purpose:
 * it transcribes any audio OR video file (Lynscripe is audio-first — MP3/WAV/
 * M4A/FLAC as well as video), so it does NOT go through LynLens's video-only
 * project open (which rejects audio with "No video stream"). It never auto-
 * touches a project; the only bridge is the explicit `lynscripe-apply`.
 *
 * Flow: pick file → transcribe (Gemini) → (user edits) → build (whisper words
 * + char-align) → export SRT, and/or apply to the open video project.
 *
 * The Gemini API key lives in a JSON under userData (a secret — never in the
 * repo). We only tell the renderer WHETHER a key is set, not the key.
 */
import { dialog, ipcMain } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  extractWaveform,
  fasterWhisperWords,
  GeminiTranscribeProvider,
  v2ToTranscript,
  WhisperLocalService,
  type TranscriptTemplate,
  type Transcript,
  type TranscriptWord,
  type VocabEntry,
} from '@lynlens/core';
import type { IpcContext } from './_context';
import { resolveWhisperModel } from '../whisper-resolve';
import {
  fasterWhisperReady,
  listFasterWhisperModels,
  resolveFwServiceOptions,
} from '../faster-whisper';
import { loadLynscripeConfig, saveLynscripeConfig } from '../lynscripe-config';

/** Serialize a Transcript to SubRip (.srt) text. Times are the transcript's own
 *  seconds (a standalone file has no cuts; comma is the SRT ms separator). */
function transcriptToSrt(t: Transcript): string {
  const fmt = (sec: number): string => {
    const total = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const ms = total % 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const lines: string[] = [];
  let idx = 1;
  for (const seg of t.segments) {
    const text = seg.text.trim();
    if (!text || seg.end - seg.start < 0.05) continue;
    lines.push(String(idx));
    lines.push(`${fmt(seg.start)} --> ${fmt(seg.end)}`);
    lines.push(text);
    lines.push('');
    idx += 1;
  }
  return lines.join('\n');
}

export function registerLynscripeIpc(ctx: IpcContext): void {
  const { engine, getMainWindow } = ctx;

  /** Whether a key is configured + the chosen model. NEVER returns the key. */
  ipcMain.handle('lynscripe-get-config', async () => {
    const cfg = await loadLynscripeConfig();
    return { keySet: !!cfg.geminiApiKey, model: cfg.model ?? 'gemini-2.5-flash' };
  });

  /** Save the Gemini key (and optional model) to userData config. */
  ipcMain.handle('lynscripe-set-key', async (_ev, apiKey: string, model?: string) => {
    const cfg = await loadLynscripeConfig();
    cfg.geminiApiKey = apiKey.trim();
    if (model) cfg.model = model;
    await saveLynscripeConfig(cfg);
    return { keySet: !!cfg.geminiApiKey, model: cfg.model ?? 'gemini-2.5-flash' };
  });

  /** Waveform envelope for the source file (a static overview strip). Path-based,
   *  so it works for standalone audio. Modest bucket count — not zoomable. */
  ipcMain.handle(
    'lynscripe-waveform',
    async (_ev, filePath: string, buckets = 1600): Promise<{ peak: number[]; rms: number[] }> => {
      const env = await extractWaveform(filePath, buckets, engine.ffmpegPaths);
      return { peak: Array.from(env.peak), rms: Array.from(env.rms) };
    }
  );

  /** The current proper-noun vocab (shared LearningMemory, same as 粗剪). */
  ipcMain.handle('lynscripe-get-vocab', async (): Promise<Record<string, string>> => {
    const map = engine.learningMemory.getProperNouns();
    const out: Record<string, string> = {};
    for (const [term, cat] of Object.entries(map)) out[term] = String(cat);
    return out;
  });

  /** Pick an audio OR video file to transcribe. Returns the absolute path. */
  ipcMain.handle('lynscripe-pick-file', async (): Promise<string | null> => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择要转录的音频或视频',
      properties: ['openFile'],
      filters: [
        { name: '音频/视频', extensions: ['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg', 'mp4', 'mov', 'mkv', 'webm', 'm4v'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /**
   * Stage 1: Gemini transcribe a file → template + uncertain terms. Known
   * proper nouns (LearningMemory) are fed in as vocab so spellings stay
   * consistent. Path-based — works for audio-only too.
   */
  ipcMain.handle(
    'lynscripe-transcribe',
    async (_ev, filePath: string, language?: string): Promise<TranscriptTemplate> => {
      const cfg = await loadLynscripeConfig();
      if (!cfg.geminiApiKey) {
        throw new Error('请先在「转录」页填入 Gemini API Key。');
      }
      const properNouns = engine.learningMemory.getProperNouns();
      const vocab: VocabEntry[] = Object.entries(properNouns).map(([term, category]) => ({
        term,
        category: String(category),
      }));
      const provider = new GeminiTranscribeProvider({
        apiKey: cfg.geminiApiKey,
        model: cfg.model ?? 'gemini-2.5-flash',
        ffmpegPaths: engine.ffmpegPaths,
      });
      return provider.transcribeToTemplate({ audioPath: filePath, vocab, language });
    }
  );

  /**
   * Stage 5: confirmed V2 text + whisper word timings (on the same file) →
   * char-aligned preview Transcript. Optionally commit confirmed terms to vocab.
   */
  ipcMain.handle(
    'lynscripe-build',
    async (
      _ev,
      filePath: string,
      v2Text: string,
      opts: { language?: string; commitVocab?: Array<{ term: string; category: string }> } = {}
    ): Promise<Transcript> => {
      for (const v of opts.commitVocab ?? []) {
        const term = v.term.trim();
        if (term) await engine.learningMemory.addProperNoun(term, v.category || 'other');
      }
      const cfg = await loadLynscripeConfig();

      // Engine A — faster-whisper (user's own pack): GPU, selectable model, no
      // downloads. Preferred when configured since we only need word timings.
      if (cfg.fwPath && fasterWhisperReady(cfg.fwPath)) {
        const fwOpts = resolveFwServiceOptions(cfg.fwPath, cfg.alignModel || 'medium', engine.ffmpegPaths);
        if (fwOpts) {
          const { words, language } = await fasterWhisperWords(fwOpts, filePath, opts.language ?? 'auto');
          return v2ToTranscript(v2Text, words, {
            language: opts.language ?? language,
            model: `gemini+faster-whisper(${cfg.alignModel || 'medium'})`,
          });
        }
      }

      // Engine B — bundled whisper.cpp (fallback). Transcribes any media path
      // (ffmpeg extracts audio first), so it works on a standalone MP3 too.
      const resolved = resolveWhisperModel();
      if (resolved) {
        engine.setTranscriptionService(
          new WhisperLocalService({
            binaryPath: resolved.binaryPath,
            modelPath: resolved.modelPath,
            ffmpegPaths: engine.ffmpegPaths,
          })
        );
      }
      const fwTranscript = await engine.transcription.transcribe(filePath, {
        language: opts.language ?? 'auto',
        scope: 'full',
      });
      const fwWords: TranscriptWord[] = fwTranscript.segments.flatMap((s) => s.words ?? []);
      return v2ToTranscript(v2Text, fwWords, {
        language: opts.language ?? fwTranscript.language,
        model: 'gemini+whisper.cpp',
      });
    }
  );

  /** Current alignment-engine config + which faster-whisper models are present. */
  ipcMain.handle('lynscripe-get-align', async () => {
    const cfg = await loadLynscripeConfig();
    const fwPath = cfg.fwPath ?? '';
    const models = fwPath ? listFasterWhisperModels(fwPath) : [];
    return {
      fwPath,
      alignModel: cfg.alignModel ?? 'medium',
      ready: fwPath ? fasterWhisperReady(fwPath) : false,
      models,
      engine: fwPath && fasterWhisperReady(fwPath) ? 'faster-whisper' : 'whisper.cpp',
    };
  });

  /** Set the faster-whisper pack folder + chosen align model. */
  ipcMain.handle('lynscripe-set-align', async (_ev, fwPath: string, alignModel: string) => {
    const cfg = await loadLynscripeConfig();
    cfg.fwPath = fwPath.trim();
    cfg.alignModel = alignModel;
    await saveLynscripeConfig(cfg);
    const models = cfg.fwPath ? listFasterWhisperModels(cfg.fwPath) : [];
    return {
      fwPath: cfg.fwPath,
      alignModel: cfg.alignModel,
      ready: cfg.fwPath ? fasterWhisperReady(cfg.fwPath) : false,
      models,
      engine: cfg.fwPath && fasterWhisperReady(cfg.fwPath) ? 'faster-whisper' : 'whisper.cpp',
    };
  });

  /** Pick the faster-whisper pack folder via native dialog. */
  ipcMain.handle('lynscripe-pick-fw-folder', async (): Promise<string | null> => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: '选择 faster-whisper 离线包文件夹(含 python 与 models)',
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  /** Save the produced transcript as a .srt file (works for standalone audio). */
  ipcMain.handle(
    'lynscripe-export-srt',
    async (_ev, transcript: Transcript, suggestedName?: string): Promise<string | null> => {
      const body = transcriptToSrt(transcript);
      if (!body.trim()) throw new Error('没有可导出的字幕段');
      const win = getMainWindow();
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: suggestedName ? `${suggestedName}.srt` : 'transcript.srt',
        filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
      });
      if (result.canceled || !result.filePath) return null;
      // UTF-8 BOM so Windows players render CJK correctly.
      await fsp.writeFile(result.filePath, '﻿' + body, 'utf-8');
      return result.filePath;
    }
  );

  /** Save the draft text as a plain .txt file (one cue per line). */
  ipcMain.handle(
    'lynscripe-export-txt',
    async (_ev, text: string, suggestedName?: string): Promise<string | null> => {
      if (!text.trim()) throw new Error('没有可导出的文稿');
      const win = getMainWindow();
      const result = await dialog.showSaveDialog(win ?? undefined!, {
        defaultPath: suggestedName ? `${suggestedName}.txt` : 'transcript.txt',
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (result.canceled || !result.filePath) return null;
      await fsp.writeFile(result.filePath, '﻿' + text, 'utf-8');
      return result.filePath;
    }
  );

  /**
   * Session persistence — auto-saves the work-in-progress (template, edits,
   * V2, produced timeline) to a sidecar next to the source file, so closing the
   * app doesn't lose it. The session is opaque JSON owned by the renderer.
   */
  const sessionPath = (sourcePath: string): string => {
    const dir = path.dirname(sourcePath);
    const base = path.basename(sourcePath, path.extname(sourcePath));
    return path.join(dir, `${base}.lynscripe.json`);
  };

  ipcMain.handle('lynscripe-save-session', async (_ev, sourcePath: string, session: unknown) => {
    try {
      await fsp.writeFile(sessionPath(sourcePath), JSON.stringify(session), 'utf-8');
      return true;
    } catch {
      return false; // best-effort (e.g. read-only folder) — never throw
    }
  });

  ipcMain.handle('lynscripe-load-session', async (_ev, sourcePath: string): Promise<unknown> => {
    try {
      return JSON.parse(await fsp.readFile(sessionPath(sourcePath), 'utf-8'));
    } catch {
      return null;
    }
  });

  /**
   * Explicit bridge: apply a Lynscripe transcript as THIS project's subtitle
   * track (overwrites). User-triggered only — used when transcribing the open
   * video project's own audio.
   */
  ipcMain.handle('lynscripe-apply', async (_ev, projectId: string, transcript: Transcript) => {
    const project = engine.projects.get(projectId);
    project.setTranscript(transcript);
    if (project.projectPath) await engine.projects.saveProject(projectId).catch(() => {});
    return { applied: transcript.segments.length };
  });
}
