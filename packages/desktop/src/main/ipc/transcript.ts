/**
 * Transcript lifecycle: transcribe / edit text / edit time / suggestions /
 * warning fingerprints / find-replace + SRT save.
 *
 * Speaker-related handlers live in `speakers.ts`, not here, because they
 * mutate `project.speakers` rather than `project.transcript`.
 */

import { ipcMain, dialog } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { IpcContext } from './_context';

export function registerTranscriptIpc(ctx: IpcContext): void {
  const { engine, getMainWindow } = ctx;

  /**
   * Save SRT content to disk. Default destination is the source video's
   * folder with the video's basename + .srt — that's where the user
   * looks for "the subtitles that go with this video". The dialog still
   * lets them rename or pick a different folder.
   */
  ipcMain.handle(
    'save-srt',
    async (_ev, projectId: string, content: string) => {
      const project = engine.projects.get(projectId);
      const dir = path.dirname(project.videoPath);
      const base = path.basename(project.videoPath, path.extname(project.videoPath));
      const defaultPath = path.join(dir, `${base}.srt`);
      const result = await dialog.showSaveDialog(getMainWindow()!, {
        defaultPath,
        filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
      });
      if (result.canceled || !result.filePath) return null;
      // UTF-8 BOM keeps Windows tools (Notepad, some Chinese players)
      // from misinterpreting the encoding. Byte-identical to what the
      // browser-side blob download wrote before.
      await fsp.writeFile(result.filePath, '\uFEFF' + content, 'utf-8');
      return result.filePath;
    }
  );

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
      // Cap subtitle length per orientation. Without this whisper produces
      // "natural-pause" segments that can run 19+ chars even for portrait,
      // overflowing the on-screen subtitle frame.
      const maxLen =
        project.userOrientation === 'portrait'
          ? 12
          : project.userOrientation === 'landscape'
            ? 24
            : 16;
      // Forward cut ranges so the post-process step drops/trims any
      // transcript segment that overlaps a ripple cut. Without this every
      // cut produces a "spans across cut" warning on the subtitle card and
      // downstream copy generation includes already-cut text.
      const cutRanges = project.cutRanges;
      engine.eventBus.emit({
        type: 'transcription.started',
        projectId,
        engine: opts.engine ?? 'whisper-local',
      });
      try {
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          engine: opts.engine,
          language: opts.language,
          maxLen,
          cutRanges,
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
