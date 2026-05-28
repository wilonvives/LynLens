import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import {
  applyAutoCorrections,
  applyProperNouns,
  filterTranscriptByCuts,
  mergeShortEnglishSegments,
  parseSrt,
} from '@lynlens/core';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Transcript editing tools: fix typos, stage suggestions, retime lines.
 * `suggest_transcript_fix` is the preferred "soft edit" — it puts a
 * proposal in the UI; `update_transcript_segment` is the nuclear option
 * for mechanical fixes that don't need human approval.
 */

export const transcriptTools: LynLensToolDef[] = [
  {
    name: 'get_transcript',
    description:
      '分页读取字幕稿正文(避免一次性超出工具结果大小上限)。只返回每段 id+text(省 token),用于通读字幕、挑错别字/衍音字/人名,再用 suggest_transcript_fix(歧义) 或 replace_in_transcript(全局替换) 改。长字幕请用 offset 翻页:每次 offset += returned,直到 returned < limit。',
    schema: {
      projectId: z.string(),
      offset: z.number().int().min(0).default(0).describe('从第几段开始,默认 0'),
      limit: z.number().int().min(1).max(400).default(200).describe('一次返回多少段,默认 200'),
    },
    handler: async (
      { projectId, offset, limit }: { projectId: string; offset: number; limit: number },
      engine
    ) => {
      const t = engine.projects.get(projectId).transcript;
      if (!t || t.segments.length === 0) return text('当前没有字幕稿,请先转录。');
      const segments = t.segments.slice(offset, offset + limit).map((s) => ({
        id: s.id,
        text: s.text,
        ...(s.speaker ? { spk: s.speaker } : {}),
      }));
      return text(
        JSON.stringify({ total: t.segments.length, offset, returned: segments.length, segments })
      );
    },
  },
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
    name: 'remove_transcript_segment',
    description:
      '删除某一段字幕(从字幕稿里彻底拿掉)。常用场景:用户把这段内容合并进了上一段或下一段,这张卡空了想清理。注意:这只删字幕项目,不影响视频本身。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
    },
    handler: async (args: { projectId: string; segmentId: string }, engine) => {
      const ok = engine.projects
        .get(args.projectId)
        .removeTranscriptSegment(args.segmentId);
      return okOrFail(
        ok,
        `已删除字幕段 ${args.segmentId.slice(0, 8)}`,
        `未找到字幕段 ${args.segmentId}`
      );
    },
  },

  {
    name: 'remove_empty_transcript_segments',
    description:
      '一次性清理所有"文字为空"的字幕段。用户合并完句子后这些空卡片自动清掉。返回删除的条数。',
    schema: {
      projectId: z.string(),
    },
    handler: async (args: { projectId: string }, engine) => {
      const n = engine.projects.get(args.projectId).removeEmptyTranscriptSegments();
      return text(n > 0 ? `已清理 ${n} 个空字幕段` : '没有空字幕段需要清理');
    },
  },

  {
    name: 'clear_transcript',
    description:
      '一键清空整份字幕稿（删除所有字幕段）。不影响视频、删除段或剪切——只清字幕文字。用户想重来一份转录、或丢掉乱掉的字幕时用。返回清空的条数。',
    schema: {
      projectId: z.string(),
    },
    handler: async (args: { projectId: string }, engine) => {
      const n = engine.projects.get(args.projectId).clearTranscript();
      return text(n > 0 ? `已清空字幕稿（${n} 段）` : '字幕稿已经是空的');
    },
  },

  {
    name: 'insert_transcript_segment_after',
    description:
      '在指定字幕段后面插入一段空白字幕(用户要手动加一行时)。新段会从锚点段的结束时间开始,默认 0.5 秒长(或到下一段开始为止)。返回新段的 id 和时间。',
    schema: {
      projectId: z.string(),
      afterSegmentId: z.string(),
    },
    handler: async (
      args: { projectId: string; afterSegmentId: string },
      engine
    ) => {
      const seg = engine.projects
        .get(args.projectId)
        .insertTranscriptSegmentAfter(args.afterSegmentId);
      if (!seg) {
        return text('未能插入新段(锚点不存在,或没有空隙可插入)');
      }
      return text(
        `已插入新段 ${seg.id.slice(0, 8)} (${seg.start.toFixed(2)}s - ${seg.end.toFixed(2)}s)`
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

  {
    name: 'import_srt_into_project',
    description:
      '读取一个 .srt 字幕文件作为本项目的字幕(会覆盖现有字幕)。和"字幕转录"等价但跳过 whisper:用第三方工具 / 手工编辑生成好的字幕直接套上。会自动应用学到的修正 + 专有名词大小写 + cut 范围过滤。',
    schema: {
      projectId: z.string(),
      srtPath: z.string().min(1),
    },
    handler: async (
      args: { projectId: string; srtPath: string },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const raw = await fsp.readFile(args.srtPath, 'utf-8');
      let transcript = parseSrt(raw);
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
      return text(`字幕导入完成: ${transcript.segments.length} 段 (来源: ${args.srtPath})`);
    },
  },
];
