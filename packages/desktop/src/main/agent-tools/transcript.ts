import { z } from 'zod';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Transcript editing tools: fix typos, stage suggestions, retime lines.
 * `suggest_transcript_fix` is the preferred "soft edit" — it puts a
 * proposal in the UI; `update_transcript_segment` is the nuclear option
 * for mechanical fixes that don't need human approval.
 */

export const transcriptTools: LynLensToolDef[] = [
  {
    name: 'update_transcript_segment',
    description:
      '【直接改】修正某一段字幕文字,立刻生效,不经过审核。只在"很明显不需要确认"的机械错误时用(如字面打错);有歧义请用 suggest_transcript_fix。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
      newText: z.string(),
    },
    handler: async (
      args: { projectId: string; segmentId: string; newText: string },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .updateTranscriptSegment(args.segmentId, args.newText);
      return okOrFail(
        ok,
        `已直接更新字幕段 ${args.segmentId.slice(0, 8)}`,
        `未找到字幕段 ${args.segmentId}`
      );
    },
  },

  {
    name: 'update_transcript_segment_time',
    description:
      '调整某段字幕的起止时间(source 秒)。级联规则:碰到前/后段时,邻居的就近边会让位。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
      newStart: z.number().nonnegative(),
      newEnd: z.number().positive(),
    },
    handler: async (
      args: { projectId: string; segmentId: string; newStart: number; newEnd: number },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .updateTranscriptSegmentTime(args.segmentId, args.newStart, args.newEnd);
      return okOrFail(
        ok,
        `已更新 ${args.segmentId.slice(0, 8)}: ${args.newStart.toFixed(2)}-${args.newEnd.toFixed(2)}`,
        '更新失败'
      );
    },
  },

  {
    name: 'suggest_transcript_fix',
    description:
      '对某一段字幕提出修改建议(不立刻生效)。UI 会显示 "✓ 接受 / ✗ 忽略",用户点击后才应用。用于疑似错字、同音字、专有名词统一。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
      newText: z.string().describe('建议的新文本'),
      reason: z.string().optional().describe('为什么要改 (简短)'),
    },
    handler: async (
      args: { projectId: string; segmentId: string; newText: string; reason?: string },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .suggestTranscriptFix(args.segmentId, args.newText, args.reason);
      return okOrFail(
        ok,
        `已对段 ${args.segmentId.slice(0, 8)} 提交建议,等用户确认。`,
        `未找到字幕段 ${args.segmentId}`
      );
    },
  },

  {
    name: 'accept_transcript_suggestion',
    description: '接受某段字幕的 AI 建议(用建议文本覆盖原文,相当于用户点 ✓ 接受)。',
    schema: { projectId: z.string(), segmentId: z.string() },
    handler: async ({ projectId, segmentId }: { projectId: string; segmentId: string }, engine) => {
      const ok = engine.projects.get(projectId).acceptTranscriptSuggestion(segmentId);
      return okOrFail(
        ok,
        `已接受 ${segmentId.slice(0, 8)} 的建议`,
        '找不到该段或无建议'
      );
    },
  },

  {
    name: 'clear_transcript_suggestion',
    description: '忽略某段字幕的 AI 建议(原文不变,相当于用户点 ✗ 忽略)。',
    schema: { projectId: z.string(), segmentId: z.string() },
    handler: async ({ projectId, segmentId }: { projectId: string; segmentId: string }, engine) => {
      const ok = engine.projects.get(projectId).clearTranscriptSuggestion(segmentId);
      return okOrFail(ok, `已忽略 ${segmentId.slice(0, 8)} 的建议`, '找不到该段或无建议');
    },
  },

  {
    name: 'replace_in_transcript',
    description: '全局查找替换字幕文字(批量修错字 / 统一专有名词)。返回改动的段数。',
    schema: {
      projectId: z.string(),
      find: z.string().min(1),
      replace: z.string(),
    },
    handler: async (
      args: { projectId: string; find: string; replace: string },
      engine
    ) => {
      const n = engine.projects.get(args.projectId).replaceInTranscript(args.find, args.replace);
      return text(`替换 "${args.find}" → "${args.replace}": ${n} 段被改动`);
    },
  },
];
