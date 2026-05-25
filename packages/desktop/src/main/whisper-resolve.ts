/**
 * Resolve which whisper.cpp model + binary to use. Shared by main/index.ts
 * (startup default) and the transcribe IPC handler (per-transcribe model
 * choice from the 字幕转录 dialog). Kept out of index.ts so both can import it
 * without a circular dependency.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';

export type WhisperModelKey = 'base' | 'small' | 'medium' | 'large-v3';

const MODEL_FILES: Record<WhisperModelKey, string> = {
  base: 'ggml-base.bin',
  small: 'ggml-small.bin',
  medium: 'ggml-medium.bin',
  'large-v3': 'ggml-large-v3.bin',
};

/** Most-accurate-first — used as the fallback order when a requested model
 *  isn't downloaded, and as the default pick (best available). */
const PREFERENCE: WhisperModelKey[] = ['large-v3', 'medium', 'small', 'base'];

function whisperDir(): string | null {
  const platformDir =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64'
          ? 'mac-arm64'
          : 'mac-x64'
        : null;
  if (!platformDir) return null;
  // Packaged: electron-builder puts models directly under resourcesPath/whisper.
  // Dev: this file compiles to dist/main/main/whisper-resolve.js, so go up to
  // packages/desktop and into resources/whisper/<platform> (same as the old
  // inline resolver that worked).
  return app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(__dirname, '..', '..', '..', 'resources', 'whisper', platformDir);
}

export interface ResolvedWhisper {
  binaryPath: string;
  modelPath: string;
  modelKey: WhisperModelKey;
}

/**
 * Resolve the binary + a model file. If `requested` is given and downloaded,
 * it's used; otherwise we fall back to the best available model. Returns null
 * if the binary or no model is present.
 */
export function resolveWhisperModel(requested?: WhisperModelKey): ResolvedWhisper | null {
  const dir = whisperDir();
  if (!dir) return null;
  const exe = process.platform === 'win32' ? '.exe' : '';
  const binaryPath = path.join(dir, `whisper-cli${exe}`);
  if (!existsSync(binaryPath)) return null;
  const order = requested ? [requested, ...PREFERENCE.filter((k) => k !== requested)] : PREFERENCE;
  for (const key of order) {
    const modelPath = path.join(dir, MODEL_FILES[key]);
    if (existsSync(modelPath)) return { binaryPath, modelPath, modelKey: key };
  }
  return null;
}

/** Which model files are actually downloaded (for the dialog's enable/disable). */
export function listWhisperModels(): WhisperModelKey[] {
  const dir = whisperDir();
  if (!dir) return [];
  return (Object.keys(MODEL_FILES) as WhisperModelKey[]).filter((k) =>
    existsSync(path.join(dir, MODEL_FILES[k]))
  );
}
