import { z } from 'zod';
import type { HighlightStyle } from '@lynlens/core';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Highlight-variant lifecycle: generate → inspect → pin/delete → segment-
 * level edit (update/add/delete/reorder). Segment edits clear the
 * variant's `sourceSnapshot` so the AI-staleness banner no longer fires
 * on hand-tuned variants.
 */

export const highlightTools: LynLensToolDef[] = [
  {
    name: 'generate_highlights',
    description:
      '从已经粗剪(ripple)过的字幕里挑出高光段,生成短视频变体。style: default(通用精华) / hero(片头) / ai-choice(自由)。所有变体同一个 style,AI 在变体间换角度而非换风格。',
    schema: {
      projectId: z.string(),
      style: z.enum(['default', 'hero', 'ai-choice'] as const),
      count: z.number().int().min(1).max(5),
      targetSeconds: z.number().int().min(5).max(300),
    },
    handler: async (
      args: {
        projectId: string;
        style: HighlightStyle;
        count: number;
        targetSeconds: number;
      },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        return {
          content: [{ type: 'text', text: '请先生成字幕后再生成高光。' }],
          isError: true,
        };
      }
      const { buildHighlightSystemPrompt, buildHighlightUserPrompt, parseHighlightResponse } =
        await import('@lynlens/core');
      const sys = buildHighlightSystemPrompt();
      const user = buildHighlightUserPrompt({
        transcript: project.transcript,
        cutRanges: project.cutRanges,
        effectiveDuration: project.getEffectiveDuration(),
        style: args.style,
        count: args.count,
        targetSeconds: args.targetSeconds,
      });
      const { runOneShotViaCurrentProvider } = await import('../agent-dispatcher');
      const { text: responseText, model } = await runOneShotViaCurrentProvider(sys, user);
      const variants = parseHighlightResponse(responseText, project.cutRanges, model, args.style);
      project.setHighlightVariants(variants);
      return text(
        `生成了 ${variants.length} 个高光变体。` +
          variants.map((v) => `\n- ${v.title} (${v.durationSeconds.toFixed(1)}s)`).join('')
      );
    },
  },

  {
    name: 'get_highlights',
    description:
      '列出当前项目的所有高光变体及各自的段落。用于定位 variantId / segmentIdx 再调其它工具修改。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const slim = project.highlightVariants.map((v) => ({
        id: v.id,
        title: v.title,
        style: v.style,
        pinned: !!v.pinned,
        durationSeconds: Number(v.durationSeconds.toFixed(2)),
        segments: v.segments.map((s) => ({
          start: Number(s.start.toFixed(3)),
          end: Number(s.end.toFixed(3)),
          reason: s.reason,
        })),
      }));
      return { content: [{ type: 'text', text: JSON.stringify(slim, null, 2) }] };
    },
  },

  {
    name: 'clear_highlights',
    description: '清空当前高光变体(保留已收藏的)。通常在用户说"不要这些变体"时调用。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const n = project.highlightVariants.length;
      project.clearHighlightVariants();
      return text(`清空了 ${n - project.highlightVariants.length} 个非收藏变体。`);
    },
  },

  {
    name: 'set_highlight_pinned',
    description:
      '收藏 / 取消收藏一个高光变体。收藏的不会被「重新生成」覆盖。pinned=true 收藏,false 取消。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      pinned: z.boolean(),
    },
    handler: async (
      args: { projectId: string; variantId: string; pinned: boolean },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .setHighlightVariantPinned(args.variantId, args.pinned);
      return okOrFail(
        ok,
        `变体 ${args.variantId.slice(0, 8)} ${args.pinned ? '已收藏' : '已取消收藏'}`,
        '变体不存在'
      );
    },
  },

  {
    name: 'delete_highlight_variant',
    description: '永久删除整个高光变体(包括收藏的,不做二次确认)。只在用户明确要删时调用。',
    schema: { projectId: z.string(), variantId: z.string() },
    handler: async (args: { projectId: string; variantId: string }, engine) => {
      const ok = engine.projects.get(args.projectId).deleteHighlightVariant(args.variantId);
      return okOrFail(ok, `已删除变体 ${args.variantId.slice(0, 8)}`, '变体不存在');
    },
  },

  {
    name: 'update_highlight_variant_segment',
    description:
      '修改某一段高光的起止时间(source 秒)和/或描述文字。用户说"第 3 段前移 2 秒"/"第 1 段缩短到 5 秒"/"改描述为…"时调用。先用 get_project_state / get_highlights 查 variantId 和 segmentIdx。不能和同变体其他段重叠;时长 < 0.2s 或越界会被拒。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      segmentIdx: z.number().int().min(0),
      newStart: z.number().nonnegative(),
      newEnd: z.number().positive(),
      newReason: z.string().optional(),
    },
    handler: async (
      args: {
        projectId: string;
        variantId: string;
        segmentIdx: number;
        newStart: number;
        newEnd: number;
        newReason?: string;
      },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .updateHighlightVariantSegment(
          args.variantId,
          args.segmentIdx,
          args.newStart,
          args.newEnd,
          args.newReason
        );
      return okOrFail(
        ok,
        `已更新变体 ${args.variantId.slice(0, 8)} 的第 ${args.segmentIdx + 1} 段`,
        '更新失败 —— 可能和其他段重叠、越界、或段长 < 0.2s。'
      );
    },
  },

  {
    name: 'add_highlight_variant_segment',
    description:
      '给某个高光变体加一段(source 秒)。新段追加到末尾,用 reorder 改位置。必须不与现有段重叠。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      startSec: z.number().nonnegative(),
      endSec: z.number().positive(),
      reason: z.string().default('AI 手动添加'),
    },
    handler: async (
      args: {
        projectId: string;
        variantId: string;
        startSec: number;
        endSec: number;
        reason: string;
      },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .addHighlightVariantSegment(args.variantId, args.startSec, args.endSec, args.reason);
      return okOrFail(
        ok,
        `已添加新段到变体 ${args.variantId.slice(0, 8)}: ${args.startSec.toFixed(2)} - ${args.endSec.toFixed(2)}`,
        '添加失败 —— 重叠、越界或长度 < 0.2s。'
      );
    },
  },

  {
    name: 'delete_highlight_variant_segment',
    description: '从某个高光变体里删掉一段。变体必须剩至少一段(否则拒绝)。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      segmentIdx: z.number().int().min(0),
    },
    handler: async (
      args: { projectId: string; variantId: string; segmentIdx: number },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .deleteHighlightVariantSegment(args.variantId, args.segmentIdx);
      return okOrFail(
        ok,
        `已删除变体 ${args.variantId.slice(0, 8)} 的第 ${args.segmentIdx + 1} 段`,
        '删除失败 —— 可能是最后一段(保留至少 1 段)或编号越界。'
      );
    },
  },

  {
    name: 'reorder_highlight_variant_segment',
    description:
      '调整变体里段落的播放顺序。时间不变,只改数组顺序。用户说"把第 3 段挪到第 1 段之前"时用。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      fromIdx: z.number().int().min(0),
      toIdx: z.number().int().min(0),
    },
    handler: async (
      args: { projectId: string; variantId: string; fromIdx: number; toIdx: number },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .reorderHighlightVariantSegment(args.variantId, args.fromIdx, args.toIdx);
      return okOrFail(
        ok,
        `已把变体 ${args.variantId.slice(0, 8)} 的第 ${args.fromIdx + 1} 段移到第 ${args.toIdx + 1} 位`,
        '重排失败 —— 编号越界。'
      );
    },
  },
];
