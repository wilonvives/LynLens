/**
 * faster-whisper PATH RESOLUTION (electron-specific). The actual spawn + parse +
 * TranscriptionService live in core (`faster-whisper-service.ts`); this module
 * just locates the user's pack pieces and builds the service-options object.
 */
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { app } from 'electron';
import type { FasterWhisperServiceOptions, FfmpegPaths } from '@lynlens/core';

export const FW_MODEL_KEYS = [
  'tiny',
  'base',
  'small',
  'medium',
  'large-v1',
  'large-v2',
  'large-v3',
] as const;
export type FwModelKey = (typeof FW_MODEL_KEYS)[number];

/** Locate the bundled fw_align.py (dev: repo resources; packaged: resourcesPath). */
function alignScriptPath(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'lynscripe', 'fw_align.py')]
    : [path.join(__dirname, '..', '..', '..', 'resources', 'lynscripe', 'fw_align.py')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The embedded python.exe inside the pack (folder name varies by version). */
function findPythonExe(fwPath: string): string | null {
  try {
    const dir = readdirSync(fwPath).find((d) => /python.*embed/i.test(d));
    if (!dir) return null;
    const exe = path.join(fwPath, dir, 'python.exe');
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

/** The snapshot dir for a model key (…/faster-whisper-<key>/snapshots/<hash>). */
function findModelSnapshot(fwPath: string, key: string): string | null {
  const base = path.join(fwPath, 'models', `models--Systran--faster-whisper-${key}`, 'snapshots');
  try {
    const snaps = readdirSync(base)
      .map((s) => path.join(base, s))
      .filter((p) => statSync(p).isDirectory() && existsSync(path.join(p, 'model.bin')));
    return snaps[0] ?? null;
  } catch {
    return null;
  }
}

/** Which model keys are actually present in the pack (have a model.bin snapshot). */
export function listFasterWhisperModels(fwPath: string): FwModelKey[] {
  if (!fwPath || !existsSync(fwPath)) return [];
  return FW_MODEL_KEYS.filter((k) => findModelSnapshot(fwPath, k) != null);
}

/** True if a usable pack (python + script + at least one model) is present. */
export function fasterWhisperReady(fwPath: string): boolean {
  return (
    !!fwPath &&
    existsSync(fwPath) &&
    findPythonExe(fwPath) != null &&
    alignScriptPath() != null &&
    listFasterWhisperModels(fwPath).length > 0
  );
}

/** Build the core service-options for a given pack + model, or null if unusable. */
export function resolveFwServiceOptions(
  fwPath: string,
  modelKey: string,
  ffmpegPaths?: FfmpegPaths
): FasterWhisperServiceOptions | null {
  const python = findPythonExe(fwPath);
  const script = alignScriptPath();
  const modelDir = findModelSnapshot(fwPath, modelKey) ?? findModelSnapshot(fwPath, 'medium');
  if (!python || !script || !modelDir) return null;
  return {
    pythonPath: python,
    scriptPath: script,
    modelDir,
    cudaDll: path.join(fwPath, 'cuda_dll'),
    ffmpegPaths,
  };
}
