import { z } from 'zod';
import type { AiMode } from '@lynlens/core';
import { type LynLensToolDef, text } from './types';

/**
 * Project-level tools: inspect state, transcribe, save, switch L2/L3 mode.
 * These are the ones every workflow starts with — `get_project_state`
 * in particular is what any agent calls first to discover ids.
 */

export const projectTools: LynLensToolDef[] = [
  {
    name: 'get_project_state',
    description:
      '获取当前项目概览(视频信息、删除段、AI 模式、高光变体)。为避免超出工具结果大小上限,字幕正文不在这里返回——只给 segmentCount,请用 get_transcript 分页读取字幕文本。删除段只含 id/start/end/status/source。',
    schema: {
      projectId: z
        .string()
        .describe('项目 ID(从 LynLens UI 打开视频后自动生成;不要从路径或 session 文件名里猜)'),
    },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const qcp = project.toQcp();
      // Keep this UNDER the MCP tool-result size cap even for long videos:
      // omit the (potentially huge) transcript body and slim the delete-mark
      // list to essentials. Full transcript text → get_transcript (paginated).
      const slim = {
        ...qcp,
        transcript: qcp.transcript
          ? {
              language: qcp.transcript.language,
              segmentCount: qcp.transcript.segments.length,
              note: '字幕正文已省略以免超限,请用 get_transcript(projectId, offset, limit) 分页读取',
            }
          : null,
        deleteSegments: qcp.deleteSegments.map((d) => ({
          id: d.id,
          start: Number(d.start.toFixed(3)),
          end: Number(d.end.toFixed(3)),
          status: d.status,
          source: d.source,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(slim, null, 2) }] };
    },
  },

  {
    name: 'transcribe',
    description:
      '对当前项目的视频进行语音转文字(本地 whisper.cpp)。返回带词级时间戳的字幕。scope=full 转完整视频(默认,字幕随剪切自动重映射);scope=edited 只转"剪剩下的音频"(所见即所得,更准,但改刀后字幕会失效需重转)。',
    schema: {
      projectId: z.string(),
      language: z.string().default('auto').describe('zh / en / auto'),
      scope: z.enum(['full', 'edited']).default('full').describe('full=完整视频; edited=剪辑后音频'),
    },
    handler: async (
      { projectId, language, scope }: { projectId: string; language: string; scope: 'full' | 'edited' },
      engine
    ) => {
      const project = engine.projects.get(projectId);
      const maxLen =
        project.userOrientation === 'portrait' ? 12 : project.userOrientation === 'landscape' ? 24 : 16;
      engine.eventBus.emit({
        type: 'transcription.started',
        projectId,
        engine: 'whisper-local',
      });
      try {
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          language,
          scope,
          maxLen,
          cutRanges: project.cutRanges,
          autoCorrections: engine.learningMemory.getAutoCorrections(),
          properNouns: engine.learningMemory.getProperNouns(),
          onProgress: (percent) =>
            engine.eventBus.emit({ type: 'transcription.progress', projectId, percent }),
        });
        project.setTranscript(transcript);
        engine.eventBus.emit({
          type: 'transcription.completed',
          projectId,
          segmentCount: transcript.segments.length,
        });
        return text(`转录完成: ${transcript.segments.length} 段, 语言=${transcript.language}`);
      } catch (err) {
        engine.eventBus.emit({
          type: 'transcription.failed',
          projectId,
          error: (err as Error).message,
        });
        throw err;
      }
    },
  },

  {
    name: 'save_project',
    description: '把当前项目状态写到 .qcp 文件。默认保存到项目绑定路径。用户说"保存"时调用。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const savedPath = await engine.projects.saveProject(projectId);
      return text(`已保存: ${savedPath}`);
    },
  },

  {
    name: 'set_mode',
    description: '设置 AI 工作模式。L2 = 添加 AI 段进 pending 等审核; L3 = 直接 approved。',
    schema: {
      projectId: z.string(),
      mode: z.enum(['L2', 'L3'] as const),
    },
    handler: async ({ projectId, mode }: { projectId: string; mode: AiMode }, engine) => {
      engine.projects.get(projectId).setMode(mode);
      return text(`模式→${mode}`);
    },
  },
];
