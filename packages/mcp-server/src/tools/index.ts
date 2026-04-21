import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LynLensEngine } from '@lynlens/core';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import path from 'node:path';

function ok<T>(data: T) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Persist a project to disk if it has a known .qcp path. Used after every
 * mutation so the desktop UI (which watches the same file) can pick up the
 * changes immediately.
 */
async function autosave(engine: LynLensEngine, projectId: string): Promise<void> {
  try {
    const project = engine.projects.get(projectId);
    if (!project.projectPath) return;
    await engine.projects.saveProject(projectId, project.projectPath);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[lynlens-mcp] autosave failed:', err);
  }
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

export function registerTools(server: McpServer, engine: LynLensEngine): void {
  // ---------- Tool 1: open_project ----------
  server.registerTool(
    'open_project',
    {
      title: 'Open a video project',
      description:
        '打开一个视频文件开始剪辑项目。如果提供了 .qcp 工程路径且存在,则加载它;否则新建。返回 projectId。',
      inputSchema: {
        videoPath: z.string().describe('视频文件绝对路径'),
        projectPath: z.string().optional().describe('(可选) .qcp 工程文件路径'),
      },
    },
    async ({ videoPath, projectPath }) => {
      try {
        engine.governor.tick('open_project');
        // If caller didn't provide a projectPath, default to "<video>.qcp"
        // next to the video file. This makes MCP and the desktop UI share
        // state automatically, since the UI watches the same path.
        let effectivePath = projectPath;
        if (!effectivePath) {
          const ext = path.extname(videoPath);
          effectivePath = videoPath.slice(0, videoPath.length - ext.length) + '.qcp';
        }
        const project = await engine.openFromVideo({
          videoPath,
          projectPath: existsSync(effectivePath) ? effectivePath : undefined,
        });
        // Assign projectPath even for new projects so subsequent mutations
        // autosave to the conventional location.
        project.projectPath = effectivePath;
        return ok({
          projectId: project.id,
          videoMeta: project.videoMeta,
          existingSegmentsCount: project.segments.list().length,
          aiMode: project.aiMode,
          projectPath: effectivePath,
        });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 2: transcribe ----------
  server.registerTool(
    'transcribe',
    {
      title: 'Transcribe the project video',
      description:
        '对视频进行语音转文字,生成带词级时间戳的文字稿。这是 AI 做剪辑决策的基础。',
      inputSchema: {
        projectId: z.string(),
        engine: z.enum(['whisper-local', 'openai-api']).default('whisper-local'),
        language: z.string().default('auto').describe('zh / en / auto'),
      },
    },
    async ({ projectId, engine: engineKind, language }) => {
      try {
        engine.governor.tick('transcribe');
        const project = engine.projects.get(projectId);
        engine.eventBus.emit({
          type: 'transcription.started',
          projectId,
          engine: engineKind ?? 'whisper-local',
        });
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          engine: engineKind,
          language,
          onProgress: (percent) => {
            engine.eventBus.emit({ type: 'transcription.progress', projectId, percent });
          },
        });
        project.setTranscript(transcript);
        engine.eventBus.emit({
          type: 'transcription.completed',
          projectId,
          segmentCount: transcript.segments.length,
        });
        await autosave(engine, projectId);
        return ok({
          language: transcript.language,
          engine: transcript.engine,
          model: transcript.model,
          segmentCount: transcript.segments.length,
          segments: transcript.segments,
        });
      } catch (e) {
        engine.eventBus.emit({
          type: 'transcription.failed',
          projectId,
          error: (e as Error).message,
        });
        return err((e as Error).message);
      }
    }
  );

  // ---------- Extra Tool: ai_mark_silence (built-in heuristic) ----------
  server.registerTool(
    'ai_mark_silence',
    {
      title: 'Mark silent regions as AI segments',
      description:
        '使用内置的静音检测,把超过 minPauseSec 秒的安静段落作为 AI 建议删除段加入项目(不需要外部 AI)。',
      inputSchema: {
        projectId: z.string(),
        minPauseSec: z.number().positive().default(1.0),
        silenceThreshold: z.number().min(0).max(1).default(0.03),
      },
    },
    async ({ projectId, minPauseSec, silenceThreshold }) => {
      try {
        engine.governor.tick('ai_mark_silence');
        const project = engine.projects.get(projectId);
        const { extractWaveform, detectSilences } = await import('@lynlens/core');
        const env = await extractWaveform(project.videoPath, 4000, engine.ffmpegPaths);
        const silences = detectSilences(env.peak, project.videoMeta.duration, {
          minPauseSec,
          silenceThreshold,
        });
        const ids: string[] = [];
        for (const s of silences) {
          const seg = project.segments.add({
            start: s.start,
            end: s.end,
            source: 'ai',
            reason: s.reason,
            confidence: 0.75,
            aiModel: 'builtin-silence-detector',
            status: project.aiMode === 'L3' ? 'approved' : 'pending',
          });
          ids.push(seg.id);
        }
        await autosave(engine, projectId);
        return ok({ added: ids.length, segmentIds: ids });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 3: get_project_state ----------
  server.registerTool(
    'get_project_state',
    {
      title: 'Get full project state',
      description:
        '获取当前项目的完整状态,包括视频信息、文字稿、已有标记段、审核状态等。',
      inputSchema: {
        projectId: z.string(),
        includeTranscript: z.boolean().default(true),
      },
    },
    async ({ projectId, includeTranscript }) => {
      try {
        engine.governor.tick('get_project_state');
        const project = engine.projects.get(projectId);
        const qcp = project.toQcp();
        if (!includeTranscript) qcp.transcript = null;
        return ok(qcp);
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 4: add_segments ----------
  server.registerTool(
    'add_segments',
    {
      title: 'Add delete segments',
      description:
        '批量添加需要删除的视频段落。每个段落必须提供 reason 说明为什么删除(如"停顿 3.2 秒"、"重复开头")。AI 添加的段默认 pending 等待审核。',
      inputSchema: {
        projectId: z.string(),
        segments: z
          .array(
            z.object({
              start: z.number().nonnegative(),
              end: z.number().positive(),
              reason: z.string(),
              confidence: z.number().min(0).max(1).optional(),
            })
          )
          .min(1),
      },
    },
    async ({ projectId, segments }) => {
      try {
        engine.governor.tick('add_segments');
        const project = engine.projects.get(projectId);
        const ids: string[] = [];
        for (const s of segments) {
          const seg = project.segments.add({
            start: s.start,
            end: s.end,
            source: 'ai',
            reason: s.reason,
            confidence: s.confidence,
            aiModel: 'mcp-client',
            // L3 = auto-approved, L2 = pending
            status: project.aiMode === 'L3' ? 'approved' : 'pending',
          });
          ids.push(seg.id);
        }
        await autosave(engine, projectId);
        return ok({ addedCount: ids.length, segmentIds: ids, aiMode: project.aiMode });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 5: remove_segments ----------
  server.registerTool(
    'remove_segments',
    {
      title: 'Remove delete segments',
      description: '移除之前添加的删除标记(AI 自我纠错或响应用户要求)。',
      inputSchema: {
        projectId: z.string(),
        segmentIds: z.array(z.string()).min(1),
      },
    },
    async ({ projectId, segmentIds }) => {
      try {
        engine.governor.tick('remove_segments');
        const project = engine.projects.get(projectId);
        for (const id of segmentIds) project.segments.remove(id);
        await autosave(engine, projectId);
        return ok({ removedCount: segmentIds.length });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 6: set_mode ----------
  server.registerTool(
    'set_mode',
    {
      title: 'Set AI mode',
      description:
        '设置项目的 AI 工作模式。L2 = 人工审核每个 AI 标记; L3 = AI 全自动,直接导出(需要 UI 侧用户已授权)。',
      inputSchema: {
        projectId: z.string(),
        mode: z.enum(['L2', 'L3']),
      },
    },
    async ({ projectId, mode }) => {
      try {
        engine.governor.tick('set_mode');
        const project = engine.projects.get(projectId);
        project.setMode(mode);
        await autosave(engine, projectId);
        return ok({ projectId, mode });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 7: preview ----------
  server.registerTool(
    'preview',
    {
      title: 'Generate a short preview clip',
      description:
        '生成一个短预览片段(不导出完整视频),用于 AI 或用户检查标记效果。可指定时间范围。',
      inputSchema: {
        projectId: z.string(),
        startTime: z.number().optional(),
        endTime: z.number().optional(),
      },
    },
    async ({ projectId, startTime, endTime }) => {
      try {
        engine.governor.tick('preview');
        const project = engine.projects.get(projectId);
        const { tmpdir } = await import('node:os');
        const path = (await import('node:path')).default;
        const previewPath = path.join(
          tmpdir(),
          `lynlens-preview-${Date.now()}.mp4`
        );

        // Re-use ExportService with a temp project-like object.
        // For simplicity, we produce a precise export over a time range by
        // temporarily filtering keeps. The simplest correct approach: export
        // whole project with current segments to temp path.
        const originalDuration = project.videoMeta.duration;
        const keeps = project.segments.getKeepSegments(originalDuration);
        if (keeps.length === 0) throw new Error('Nothing to preview');

        // If a range was provided, intersect keeps with [start, end]
        const s = startTime ?? 0;
        const e = endTime ?? Math.min(originalDuration, s + 30);
        const clipped = keeps
          .map((k) => ({ start: Math.max(k.start, s), end: Math.min(k.end, e) }))
          .filter((k) => k.end > k.start);
        if (clipped.length === 0) throw new Error('Range has no keep content');

        const { buildConcatFilter, runFfmpeg, resolveFfmpegPaths } = await import('@lynlens/core');
        const filter = buildConcatFilter(clipped);
        const paths = resolveFfmpegPaths();
        await runFfmpeg({
          ffmpegPath: paths.ffmpeg,
          args: [
            '-v', 'error',
            '-i', project.videoPath,
            '-filter_complex', filter,
            '-map', '[outv]',
            '-map', '[outa]',
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-y',
            previewPath,
          ],
        });
        return ok({ previewPath, range: { start: s, end: e } });
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );

  // ---------- Tool 8: export ----------
  server.registerTool(
    'export',
    {
      title: 'Export the final video',
      description:
        '导出最终视频。L3 模式下可直接导出;L2 模式下必须所有段都 approved 才会导出。',
      inputSchema: {
        projectId: z.string(),
        outputPath: z.string().describe('输出视频路径(必须不同于源视频)'),
        mode: z.enum(['fast', 'precise']).default('precise'),
        quality: z.enum(['original', 'high', 'medium', 'low']).default('high'),
      },
    },
    async ({ projectId, outputPath, mode, quality }) => {
      try {
        engine.governor.tick('export');
        const project = engine.projects.get(projectId);
        if (project.aiMode === 'L2') {
          const pending = project.segments
            .list()
            .filter((s) => s.source === 'ai' && s.status === 'pending');
          if (pending.length > 0) {
            return err(
              `L2 模式下存在 ${pending.length} 个待审核 AI 段落,请先批准或拒绝,或切换到 L3 模式。`
            );
          }
        }
        const result = await engine.exports.export(project, {
          outputPath,
          mode,
          quality,
        });
        return ok(result);
      } catch (e) {
        return err((e as Error).message);
      }
    }
  );
}
