import { z } from 'zod';
import { type LynLensToolDef, text } from './types';

/**
 * Speaker diarization + label management. `diarize` uses the shared
 * `diarize-helper.ts` so the agent and the UI button take identical
 * sherpa-onnx / mock routing paths.
 */

export const speakerTools: LynLensToolDef[] = [
  {
    name: 'diarize',
    description:
      '跑说话人识别,给每段字幕打标签(S1, S2, ...)。speakerCount 可选(不给就自动估计)。跑完后用 rename_speaker 给人取名。',
    schema: {
      projectId: z.string(),
      speakerCount: z.number().int().min(1).max(8).optional(),
    },
    handler: async (args: { projectId: string; speakerCount?: number }, engine) => {
      try {
        const { runDiarization } = await import('../diarize-helper');
        const diar = await runDiarization(engine, args.projectId, {
          speakerCount: args.speakerCount,
        });
        return text(
          `识别完成,engine=${diar.engine},说话人: ${diar.speakers.join(', ') || '(空)'}`
        );
      } catch (err) {
        return {
          content: [{ type: 'text', text: (err as Error).message }],
          isError: true,
        };
      }
    },
  },

  {
    name: 'rename_speaker',
    description: '给说话人 ID 起显示名字,比如把 S1 改叫「主持人」。name 为 null 或空字符串 = 取消命名。',
    schema: {
      projectId: z.string(),
      speakerId: z.string(),
      name: z.string().nullable(),
    },
    handler: async (
      args: { projectId: string; speakerId: string; name: string | null },
      engine
    ) => {
      engine.projects.get(args.projectId).renameSpeaker(args.speakerId, args.name);
      return text(args.name ? `${args.speakerId} → "${args.name}"` : `${args.speakerId} 取消命名`);
    },
  },

  {
    name: 'merge_speakers',
    description: '把所有标成 from 的字幕段重新标成 to。用户说"S2 和 S4 是同一个人,合起来"时用。',
    schema: {
      projectId: z.string(),
      from: z.string(),
      to: z.string(),
    },
    handler: async (args: { projectId: string; from: string; to: string }, engine) => {
      const n = engine.projects.get(args.projectId).mergeSpeakers(args.from, args.to);
      return text(`把 ${n} 段从 ${args.from} 合并到 ${args.to}`);
    },
  },

  {
    name: 'set_segment_speaker',
    description: '改单一字幕段的说话人标签(修一个错标)。speaker 为 null 清除标签。',
    schema: {
      projectId: z.string(),
      transcriptSegmentId: z.string(),
      speaker: z.string().nullable(),
    },
    handler: async (
      args: { projectId: string; transcriptSegmentId: string; speaker: string | null },
      engine
    ) => {
      const ok = engine.projects
        .get(args.projectId)
        .setSegmentSpeaker(args.transcriptSegmentId, args.speaker);
      if (!ok) {
        return { content: [{ type: 'text', text: '段不存在' }], isError: true };
      }
      return text(
        args.speaker
          ? `${args.transcriptSegmentId.slice(0, 8)} → ${args.speaker}`
          : `${args.transcriptSegmentId.slice(0, 8)} 清除标签`
      );
    },
  },

  {
    name: 'auto_assign_unlabeled_speakers',
    description: '给所有未标记的字幕段按就近原则自动指派说话人(最近的已标记段同一个人)。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const n = engine.projects.get(projectId).autoAssignUnlabeledSpeakers();
      return text(`自动指派了 ${n} 段`);
    },
  },

  {
    name: 'clear_speakers',
    description: '清空所有说话人标签,回到识别前的状态。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      engine.projects.get(projectId).clearSpeakers();
      return text('所有说话人标签已清除');
    },
  },
];
