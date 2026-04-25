/**
 * Transcript lifecycle: transcribe / edit text / edit time / suggestions /
 * warning fingerprints / find-replace.
 *
 * Speaker-related handlers live in `speakers.ts`, not here, because they
 * mutate `project.speakers` rather than `project.transcript`.
 */

import { ipcMain } from 'electron';
import type { IpcContext } from './_context';

export function registerTranscriptIpc(ctx: IpcContext): void {
  const { engine } = ctx;

  ipcMain.handle(
    'update-transcript-segment',
    async (_ev, projectId: string, segmentId: string, newText: string) => {
      const project = engine.projects.get(projectId);
      return project.updateTranscriptSegment(segmentId, newText);
    }
  );

  ipcMain.handle(
    'update-transcript-segment-time',
    async (
      _ev,
      projectId: string,
      segmentId: string,
      newStart: number,
      newEnd: number
    ) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateTranscriptSegmentTime(segmentId, newStart, newEnd);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'set-transcript-warning-fingerprint',
    async (_ev, projectId: string, segmentId: string, fingerprint: string | null) => {
      const project = engine.projects.get(projectId);
      const ok = project.setTranscriptWarningFingerprint(segmentId, fingerprint);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'replace-in-transcript',
    async (_ev, projectId: string, find: string, replace: string) => {
      const project = engine.projects.get(projectId);
      return project.replaceInTranscript(find, replace);
    }
  );

  ipcMain.handle(
    'accept-transcript-suggestion',
    async (_ev, projectId: string, segmentId: string) => {
      return engine.projects.get(projectId).acceptTranscriptSuggestion(segmentId);
    }
  );

  ipcMain.handle(
    'clear-transcript-suggestion',
    async (_ev, projectId: string, segmentId: string) => {
      return engine.projects.get(projectId).clearTranscriptSuggestion(segmentId);
    }
  );

  ipcMain.handle(
    'transcribe',
    async (
      _ev,
      projectId: string,
      opts: { engine?: 'whisper-local' | 'openai-api'; language?: string }
    ) => {
      const project = engine.projects.get(projectId);
      engine.eventBus.emit({
        type: 'transcription.started',
        projectId,
        engine: opts.engine ?? 'whisper-local',
      });
      try {
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          engine: opts.engine,
          language: opts.language,
          onProgress: (percent) =>
            engine.eventBus.emit({ type: 'transcription.progress', projectId, percent }),
        });
        project.setTranscript(transcript);
        engine.eventBus.emit({
          type: 'transcription.completed',
          projectId,
          segmentCount: transcript.segments.length,
        });
        return {
          language: transcript.language,
          engine: transcript.engine,
          segmentCount: transcript.segments.length,
        };
      } catch (err) {
        engine.eventBus.emit({
          type: 'transcription.failed',
          projectId,
          error: (err as Error).message,
        });
        throw err;
      }
    }
  );
}
