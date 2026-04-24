/**
 * Shared helper for running speaker diarization on a project.
 *
 * Both the IPC handler (`'diarize'`) and the embedded MCP tools need the
 * same "prefer sherpa-onnx bundle, fall back to mock" routing logic, plus
 * the same post-diarization save. Extracted here so the two callers stay
 * in sync — accidental divergence would give different UX between the
 * button and the agent.
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';
import {
  type DiarizationEngine,
  type DiarizationResult,
  type LynLensEngine,
  MockDiarizationEngine,
  resolveSherpaPaths,
  SherpaOnnxDiarizationEngine,
} from '@lynlens/core';

function resolveBundledDiarizationBase(): string | null {
  // Mirrors the fallback chain used by whisper / ffmpeg resolvers: try
  // the packaged resources dir first, then the dev-time source tree.
  const platformDir =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
        : null;
  if (!platformDir) return null;
  const candidates = [
    path.join(process.resourcesPath, 'diarization', platformDir),
    path.join(app.getAppPath(), 'resources', 'diarization', platformDir),
    path.join(app.getAppPath(), '..', 'resources', 'diarization', platformDir),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function runDiarization(
  engine: LynLensEngine,
  projectId: string,
  opts?: { speakerCount?: number }
): Promise<DiarizationResult> {
  const project = engine.projects.get(projectId);
  if (!project.transcript || project.transcript.segments.length === 0) {
    throw new Error('请先生成字幕后再区分说话人');
  }
  const diarBase = resolveBundledDiarizationBase();
  let diarEngine: DiarizationEngine;
  if (diarBase) {
    const paths = await resolveSherpaPaths(diarBase);
    if (paths) {
      const count =
        opts?.speakerCount && opts.speakerCount > 0
          ? Math.floor(opts.speakerCount)
          : undefined;
      diarEngine = new SherpaOnnxDiarizationEngine(paths, engine.ffmpegPaths, {
        clusterThreshold: 0.9,
        numClusters: count,
      });
    } else {
      diarEngine = new MockDiarizationEngine(() => project.transcript);
    }
  } else {
    diarEngine = new MockDiarizationEngine(() => project.transcript);
  }
  const result = await diarEngine.diarize(project.videoPath);
  project.applyDiarization(result);
  if (project.projectPath) {
    await engine.projects.saveProject(projectId);
  }
  return result;
}
