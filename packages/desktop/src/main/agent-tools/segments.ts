import { z } from 'zod';
import type { SegmentSource, SegmentStatus } from '@lynlens/core';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Delete-segment editing tools: add / remove / erase / resize / approve /
 * reject / undo / redo / ripple commit + revert / built-in AI marking.
 *
 * These are what any editing workflow lives on — the user says "删掉
 * 这段 / 批准全部 / 撤销 / 真剪掉吧" and the Agent maps it to one of
 * the tools here.
 */

export const segmentTools: LynLensToolDef[] = [
  {
    name: 'ai_mark_silence',
    description:
      '内置静音检测(可选:若已有字幕,还会识别语气词和重复段)。添加的段都进 pending 待审状态。',
    schema: {
      projectId: z.string(),
      minPauseSec: z.number().positive().default(1.0),
      silenceThreshold: z.number().min(0).max(1).default(0.03),
    },
    handler: async (
      args: { projectId: string; minPauseSec: number; silenceThreshold: number },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const { detectSilences, detectFillers, detectRetakes, extractWaveform } = await import(
        '@lynlens/core'
      );
      const env = await extractWaveform(project.videoPath, 4000, engine.ffmpegPaths);
      const silences = detectSilences(env.peak, project.videoMeta.duration, {
        minPauseSec: args.minPauseSec,
        silenceThreshold: args.silenceThreshold,
      });
      let fillerCount = 0;
      let retakeCount = 0;
      const ids: string[] = [];
      for (const s of silences) {
        const seg = project.segments.add({
          start: s.start,
          end: s.end,
          source: 'ai',
          reason: s.reason,
          confidence: 0.75,
          aiModel: 'builtin-silence',
        });
        ids.push(seg.id);
      }
      if (project.transcript) {
        for (const f of detectFillers(project.transcript)) {
          const seg = project.segments.add({
            start: f.start,
            end: f.end,
            source: 'ai',
            reason: f.reason,
            confidence: f.confidence,
            aiModel: 'builtin-filler',
          });
          ids.push(seg.id);
          fillerCount += 1;
        }
        for (const r of detectRetakes(project.transcript)) {
          const seg = project.segments.add({
            start: r.start,
            end: r.end,
            source: 'ai',
            reason: r.reason,
            confidence: r.confidence,
            aiModel: 'builtin-retake',
          });
          ids.push(seg.id);
          retakeCount += 1;
        }
      }
      return text(
        `已标 ${ids.length} 段: 停顿 ${silences.length}, 语气词 ${fillerCount}, 重复 ${retakeCount}`
      );
    },
  },

  {
    name: 'add_segments',
    description: '手动添加需要删除的段(一般配合已有字幕做精细标记)。',
    schema: {
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
    handler: async (
      args: {
        projectId: string;
        segments: Array<{ start: number; end: number; reason: string; confidence?: number }>;
      },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const ids: string[] = [];
      for (const s of args.segments) {
        const seg = project.segments.add({
          start: s.start,
          end: s.end,
          source: 'ai' as SegmentSource,
          reason: s.reason,
          confidence: s.confidence,
          aiModel: 'agent',
        });
        ids.push(seg.id);
      }
      return text(`添加 ${ids.length} 段: ${ids.join(', ')}`);
    },
  },

  {
    name: 'remove_segments',
    description: '移除之前添加的删除段(纠错 / 响应用户"保留 #3"之类的要求)。',
    schema: { projectId: z.string(), segmentIds: z.array(z.string()).min(1) },
    handler: async ({ projectId, segmentIds }: { projectId: string; segmentIds: string[] }, engine) => {
      const project = engine.projects.get(projectId);
      for (const id of segmentIds) project.segments.remove(id);
      return text(`移除 ${segmentIds.length} 段`);
    },
  },

  {
    name: 'erase_range',
    description:
      '擦除某个时间范围内所有标记段。time 为 source 秒。用户说"别删 0:10-0:20 那段的任何标记"时用。',
    schema: {
      projectId: z.string(),
      start: z.number().nonnegative(),
      end: z.number().positive(),
    },
    handler: async (args: { projectId: string; start: number; end: number }, engine) => {
      const project = engine.projects.get(args.projectId);
      const before = project.segments.list().length;
      project.segments.eraseRange(args.start, args.end);
      const after = project.segments.list().length;
      return text(`擦除 ${args.start.toFixed(2)}-${args.end.toFixed(2)}: 删掉 ${before - after} 个标记`);
    },
  },

  {
    name: 'resize_segment',
    description: '调整一个已有删除段的起止时间(source 秒)。用户说"把 #3 改到 0:05-0:08"时用。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
      start: z.number().nonnegative(),
      end: z.number().positive(),
    },
    handler: async (
      args: { projectId: string; segmentId: string; start: number; end: number },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const seg = project.segments.resize(args.segmentId, args.start, args.end);
      return okOrFail(
        !!seg,
        `段 ${args.segmentId.slice(0, 8)} 已改到 ${args.start.toFixed(2)}-${args.end.toFixed(2)}`,
        `找不到段 ${args.segmentId}`
      );
    },
  },

  {
    name: 'set_segment_status',
    description: '修改某个段的审核状态(approve / reject / pending)。',
    schema: {
      projectId: z.string(),
      segmentId: z.string(),
      status: z.enum(['approved', 'rejected', 'pending'] as const),
    },
    handler: async (
      args: { projectId: string; segmentId: string; status: 'approved' | 'rejected' | 'pending' },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      if (args.status === 'approved') project.segments.approve(args.segmentId, 'agent');
      else if (args.status === 'rejected') project.segments.reject(args.segmentId, 'agent');
      else {
        const seg = project.segments.find(args.segmentId);
        if (seg) seg.status = 'pending' as SegmentStatus;
      }
      return text(`段 ${args.segmentId.slice(0, 8)} 状态→${args.status}`);
    },
  },

  {
    name: 'approve_all_pending',
    description: '一键批准所有待审核的 AI 段(用户说"全部接受"时调用)。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const pending = project.segments.list().filter((s) => s.status === 'pending');
      for (const s of pending) project.segments.approve(s.id, 'agent');
      return text(`批准了 ${pending.length} 个待审段`);
    },
  },

  {
    name: 'reject_segment',
    description: '拒绝(否决)一个待审 AI 段。对应 UI 里的 ✗ 按钮。',
    schema: { projectId: z.string(), segmentId: z.string() },
    handler: async ({ projectId, segmentId }: { projectId: string; segmentId: string }, engine) => {
      engine.projects.get(projectId).segments.reject(segmentId, 'agent');
      return text(`段 ${segmentId.slice(0, 8)} 已拒绝`);
    },
  },

  {
    name: 'reject_all_pending',
    description: '一键拒绝所有待审 AI 段。用户说"全部不要"或"推倒重来"时用。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const pending = project.segments.list().filter((s) => s.status === 'pending');
      for (const s of pending) project.segments.reject(s.id, 'agent');
      return text(`拒绝了 ${pending.length} 个待审段`);
    },
  },

  {
    name: 'undo',
    description: '撤销上一步删除段操作(只影响 deleteSegments,不影响字幕/转录/高光)。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const ok = engine.projects.get(projectId).segments.undo();
      return okOrFail(ok, '已撤销', '没有可撤销的操作');
    },
  },

  {
    name: 'redo',
    description: '重做上一次撤销的操作。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const ok = engine.projects.get(projectId).segments.redo();
      return okOrFail(ok, '已重做', '没有可重做的操作');
    },
  },

  {
    name: 'commit_ripple',
    description:
      '对所有 approved 删除段执行 ripple 剪切:把它们从时间轴里压掉,后面的内容整体往前填补,时间轴变短。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const project = engine.projects.get(projectId);
      const result = project.commitRipple();
      return text(
        result.cutSegmentIds.length === 0
          ? '没有 approved 段,无需剪切。'
          : `剪掉 ${result.cutSegmentIds.length} 段,共 ${result.totalCutSeconds.toFixed(2)} 秒,时间轴长度变为 ${result.effectiveDuration.toFixed(2)} 秒。`
      );
    },
  },

  {
    name: 'revert_ripple',
    description: '撤销某一段已经执行的 ripple 剪切:把指定段从 cut 状态恢复为 approved。',
    schema: { projectId: z.string(), segmentId: z.string() },
    handler: async ({ projectId, segmentId }: { projectId: string; segmentId: string }, engine) => {
      const ok = engine.projects.get(projectId).revertRipple(segmentId);
      return okOrFail(
        ok,
        `已恢复段 ${segmentId.slice(0, 8)}。`,
        `找不到 cut 状态的段 ${segmentId}。`
      );
    },
  },
];
