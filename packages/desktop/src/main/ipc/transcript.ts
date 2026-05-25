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
import {
  applyAutoCorrections,
  applyProperNouns,
  filterTranscriptByCuts,
  mergeShortEnglishSegments,
  parseSrt,
  WhisperLocalService,
} from '@lynlens/core';
import type { IpcContext } from './_context';
import { resolveWhisperModel, listWhisperModels, type WhisperModelKey } from '../whisper-resolve';

export function registerTranscriptIpc(ctx: IpcContext): void {
  const { engine, getMainWindow } = ctx;

  // Which whisper models are downloaded — the 字幕转录 dialog uses this to
  // enable/disable the 高质量 (large-v3) option.
  ipcMain.handle('list-whisper-models', async (): Promise<WhisperModelKey[]> => listWhisperModels());

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

  /**
   * Import an external SRT file as the project's transcript. The user's
   * workflow: third-party tool / hand-edit produced subtitles for this
   * exact video; we read them in instead of running whisper from scratch.
   *
   * When `srtPath` is omitted we show a native file picker so the user
   * can browse. Defaults the dialog to the source video's folder \u2014 that's
   * where the SRT typically sits when someone exports one alongside.
   *
   * Post-processing matches the live transcribe pipeline:
   *   1. cut-range filter (drop / trim segments inside ripple cuts)
   *   2. learned auto-corrections (so the user's "\u5728\u4F5C"\u2192"\u5728\u505A" still apply)
   *   3. proper-noun canonical casing
   *   4. short-English merge (in case the SRT was also chopped fine)
   *
   * Returns the count + source path so the renderer can show a confirmation
   * toast. Throws on parse failure \u2014 caller surfaces the error to the user.
   */
  ipcMain.handle(
    'import-srt-into-project',
    async (_ev, projectId: string, srtPath?: string) => {
      const project = engine.projects.get(projectId);
      let actualPath = srtPath ?? null;
      if (!actualPath) {
        const defaultDir = path.dirname(project.videoPath);
        const result = await dialog.showOpenDialog(getMainWindow()!, {
          title: '\u5BFC\u5165\u5B57\u5E55\u6587\u4EF6',
          defaultPath: defaultDir,
          properties: ['openFile'],
          filters: [{ name: 'SubRip Subtitle', extensions: ['srt'] }],
        });
        if (result.canceled || result.filePaths.length === 0) return null;
        actualPath = result.filePaths[0];
      }
      const raw = await fsp.readFile(actualPath, 'utf-8');
      let transcript = parseSrt(raw);
      // Same post-process pipeline as transcribe: cut filter \u2192 auto-fix \u2192
      // proper-noun case \u2192 English merge. Same source-of-truth for both
      // paths means the user gets the same polish whether they transcribe
      // or import.
      if (project.cutRanges.length > 0) {
        transcript = filterTranscriptByCuts(transcript, project.cutRanges);
      }
      const autoCorrections = engine.learningMemory.getAutoCorrections();
      if (Object.keys(autoCorrections).length > 0) {
        transcript = applyAutoCorrections(transcript, autoCorrections);
      }
      const properNouns = engine.learningMemory.getProperNouns();
      if (Object.keys(properNouns).length > 0) {
        transcript = applyProperNouns(transcript, properNouns);
      }
      transcript = mergeShortEnglishSegments(transcript);
      project.setTranscript(transcript);
      if (project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      engine.eventBus.emit({
        type: 'transcription.completed',
        projectId,
        segmentCount: transcript.segments.length,
      });
      return {
        segmentCount: transcript.segments.length,
        language: transcript.language,
        sourcePath: actualPath,
      };
    }
  );

  ipcMain.handle(
    'update-transcript-segment',
    async (_ev, projectId: string, segmentId: string, newText: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.updateTranscriptSegment(segmentId, newText);
      // After the edit fires, LearningService has (synchronously, via event
      // bus) added the new from→to to autoCorrections. Now replay all
      // autoCorrections against the rest of the transcript so the user's
      // single edit ripples through every other card with the same error.
      // This is THE key UX improvement requested: "改一处全部改完",
      // no need for the user to manually fix 50 instances of 前里 → 钱骡.
      if (ok) {
        const corrections = engine.learningMemory.getAutoCorrections();
        project.applyAutoCorrectionsToTranscript(corrections, { skipSegmentId: segmentId });
      }
      return ok;
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
    'remove-transcript-segment',
    async (_ev, projectId: string, segmentId: string) => {
      const project = engine.projects.get(projectId);
      const ok = project.removeTranscriptSegment(segmentId);
      if (ok && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return ok;
    }
  );

  ipcMain.handle(
    'insert-transcript-segment-after',
    async (_ev, projectId: string, afterSegmentId: string) => {
      const project = engine.projects.get(projectId);
      const seg = project.insertTranscriptSegmentAfter(afterSegmentId);
      if (seg && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return seg;
    }
  );

  ipcMain.handle(
    'remove-empty-transcript-segments',
    async (_ev, projectId: string) => {
      const project = engine.projects.get(projectId);
      const n = project.removeEmptyTranscriptSegments();
      if (n > 0 && project.projectPath) {
        await engine.projects.saveProject(projectId);
      }
      return n;
    }
  );

  ipcMain.handle('clear-transcript', async (_ev, projectId: string) => {
    const project = engine.projects.get(projectId);
    const n = project.clearTranscript();
    if (n > 0 && project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
    return n;
  });

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
      opts: {
        engine?: 'whisper-local' | 'openai-api';
        language?: string;
        /** 'full' = whole video (default); 'edited' = only the kept audio. */
        scope?: 'full' | 'edited';
        /** Whisper model to use. Falls back to best available if not present. */
        model?: WhisperModelKey;
      }
    ) => {
      const project = engine.projects.get(projectId);
      // Honour the user's model choice (快速 base / 高质量 large-v3). Swap the
      // engine's whisper service to the requested model for this transcribe.
      if (opts.model) {
        const resolved = resolveWhisperModel(opts.model);
        if (resolved) {
          engine.setTranscriptionService(
            new WhisperLocalService({
              binaryPath: resolved.binaryPath,
              modelPath: resolved.modelPath,
              ffmpegPaths: engine.ffmpegPaths,
            })
          );
        }
      }
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
      // Apply learned auto-corrections so the user's repeated manual fixes
      // ("在作" → "在做" etc.) get baked in to the new transcript without
      // needing to redo the work. New corrections recorded since boot live
      // here — LearningMemory is shared across the engine, no reload needed.
      const autoCorrections = engine.learningMemory.getAutoCorrections();
      // Proper nouns get canonical-cased so "bmw motorrad" → "BMW Motorrad"
      // without the user having to fix every instance. Same source-of-truth
      // as autoCorrections: whatever the user has taught LynLens.
      const properNouns = engine.learningMemory.getProperNouns();
      engine.eventBus.emit({
        type: 'transcription.started',
        projectId,
        engine: opts.engine ?? 'whisper-local',
      });
      try {
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          engine: opts.engine,
          language: opts.language,
          scope: opts.scope,
          maxLen,
          cutRanges,
          autoCorrections,
          properNouns,
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
