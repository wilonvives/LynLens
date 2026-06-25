/**
 * Shared Lynscripe config (userData JSON). Holds the Gemini key, the
 * faster-whisper pack path, and the chosen align model. Read by the Lynscripe
 * IPC, the startup transcription-engine selection, and the 粗剪 transcribe
 * handler — so they all agree on which engine to use. NOT in the repo.
 */
import { app } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';

export interface LynscripeConfig {
  geminiApiKey?: string;
  model?: string;
  /** faster-whisper offline pack root (empty → bundled whisper.cpp). */
  fwPath?: string;
  /** Which faster-whisper model to use (default medium). */
  alignModel?: string;
}

export function lynscripeConfigPath(): string {
  return path.join(app.getPath('userData'), 'lynscripe-config.json');
}

export async function loadLynscripeConfig(): Promise<LynscripeConfig> {
  try {
    return JSON.parse(await fsp.readFile(lynscripeConfigPath(), 'utf-8')) as LynscripeConfig;
  } catch {
    return {};
  }
}

export async function saveLynscripeConfig(cfg: LynscripeConfig): Promise<void> {
  await fsp.writeFile(lynscripeConfigPath(), JSON.stringify(cfg, null, 2), 'utf-8');
}
