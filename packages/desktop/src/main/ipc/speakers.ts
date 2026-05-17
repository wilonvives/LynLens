/**
 * Speaker labeling: diarize (one-shot run) + manual rename / merge / clear.
 *
 * The diarization engine selection (sherpa-onnx if bundled, mock fallback)
 * is decided at the call site so the choice can react to runtime presence
 * of the bundled assets — see `resolveBundledDiarizationBase` on the
 * IpcContext.
 */

import { ipcMain } from 'electron';
import {
  MockDiarizationEngine,
  SherpaOnnxDiarizationEngine,
  resolveSherpaPaths,
  type DiarizationEngine,
} from '@lynlens/core';
import type { IpcContext } from './_context';

export function registerSpeakersIpc(ctx: IpcContext): void {
  const { engine, resolveBundledDiarizationBase } = ctx;

  ipcMain.handle(
    'diarize',
    async (_ev, projectId: string, opts?: { speakerCount?: number }) => {
      const project = engine.projects.get(projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        throw new Error('请先生成字幕后再区分说话人');
      }

      const wantedCount =
        opts?.speakerCount && opts.speakerCount > 0
          ? Math.floor(opts.speakerCount)
          : undefined;

      // Short-circuit: when the user explicitly says "1 person", running
      // sherpa-onnx with --clustering.num-clusters=1 is degenerate — the
      // clustering step crashes (SIGBUS on macOS) because intra-cluster
      // distance math divides by (n-1). Skip the model entirely and just
      // tag every existing transcript segment as the single speaker S1.
      // Same observable result as a "successful" 1-speaker diarization,
      // but instant and crash-proof.
      if (wantedCount === 1) {
        const allSegments = project.transcript.segments.map((s) => ({
          start: s.start,
          end: s.end,
          speaker: 'S1',
        }));
        // Use 'mock' for engine field — DiarizationResult only accepts
        // 'mock' | 'sherpa-onnx'. Internally this IS a mock (no model ran).
        const result = {
          engine: 'mock' as const,
          segments: allSegments,
          speakers: ['S1'],
        };
        project.applyDiarization(result);
        if (project.projectPath) {
          await engine.projects.saveProject(projectId);
        }
        return {
          engine: result.engine,
          speakers: result.speakers,
          segmentCount: result.segments.length,
        };
      }

      const diarBase = resolveBundledDiarizationBase();
      let diarEngine: DiarizationEngine;
      if (diarBase) {
        const paths = await resolveSherpaPaths(diarBase);
        if (paths) {
          // When the caller knows the speaker count, forward it — vastly
          // more reliable than threshold-based auto-clustering for
          // short / low-speaker-count content. We've already short-circuited
          // the count===1 case above; sherpa is only invoked for >= 2.
          diarEngine = new SherpaOnnxDiarizationEngine(paths, engine.ffmpegPaths, {
            clusterThreshold: 0.9,
            numClusters: wantedCount,
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
      return {
        engine: result.engine,
        speakers: result.speakers,
        segmentCount: result.segments.length,
      };
    }
  );

  ipcMain.handle(
    'merge-speakers',
    async (_ev, projectId: string, from: string, to: string) => {
      const project = engine.projects.get(projectId);
      const n = project.mergeSpeakers(from, to);
      if (n > 0 && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return n;
    }
  );

  ipcMain.handle(
    'set-segment-speaker',
    async (
      _ev,
      projectId: string,
      transcriptSegmentId: string,
      speaker: string | null
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.setSegmentSpeaker(transcriptSegmentId, speaker);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'auto-assign-unlabeled-speakers',
    async (_ev, projectId: string) => {
      const project = engine.projects.get(projectId);
      const n = project.autoAssignUnlabeledSpeakers();
      if (n > 0 && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return n;
    }
  );

  ipcMain.handle(
    'rename-speaker',
    async (_ev, projectId: string, speakerId: string, name: string | null) => {
      const project = engine.projects.get(projectId);
      project.renameSpeaker(speakerId, name);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
    }
  );

  ipcMain.handle('clear-speakers', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    project.clearSpeakers();
    if (project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
  });
}
