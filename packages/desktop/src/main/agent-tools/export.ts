import { z } from 'zod';
import { type LynLensToolDef, text } from './types';

/**
 * Export: final cut + single highlight variant. Both require an absolute
 * outputPath — the agent must ask the user for a path since we can't
 * popup a save dialog from inside a tool invocation.
 */

export const exportTools: LynLensToolDef[] = [
  {
    name: 'export_final_video',
    description:
      '导出最终成片(粗剪执行 ripple 之后的完整视频)。outputPath 必须是绝对路径。mode: fast(流拷贝,秒级,默认)/ precise(重编码,画面一致)。quality 仅 precise 模式有效: low/medium/high。',
    schema: {
      projectId: z.string(),
      outputPath: z.string(),
      mode: z.enum(['fast', 'precise'] as const).default('fast'),
      quality: z.enum(['low', 'medium', 'high'] as const).default('medium'),
    },
    handler: async (
      args: {
        projectId: string;
        outputPath: string;
        mode: 'fast' | 'precise';
        quality: 'low' | 'medium' | 'high';
      },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const result = await engine.exports.export(project, {
        outputPath: args.outputPath,
        mode: args.mode,
        quality: args.quality,
      });
      return text(
        `导出完成: ${result.outputPath} (${(result.sizeBytes / 1e6).toFixed(1)}MB, ${result.durationSeconds.toFixed(1)}s)`
      );
    },
  },

  {
    name: 'export_highlight_variant',
    description: '导出某一个高光变体成单独视频。outputPath 必须是绝对路径。',
    schema: {
      projectId: z.string(),
      variantId: z.string(),
      outputPath: z.string(),
    },
    handler: async (
      args: { projectId: string; variantId: string; outputPath: string },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      const variant = project.findHighlightVariant(args.variantId);
      if (!variant) {
        return {
          content: [{ type: 'text', text: `变体 ${args.variantId} 不存在` }],
          isError: true,
        };
      }
      const keepOverride = variant.segments.map((s) => ({ start: s.start, end: s.end }));
      const result = await engine.exports.export(project, {
        outputPath: args.outputPath,
        mode: 'fast',
        quality: 'medium',
        keepOverride,
      });
      return text(
        `变体 ${args.variantId.slice(0, 8)} 导出完成: ${result.outputPath} (${(result.sizeBytes / 1e6).toFixed(1)}MB)`
      );
    },
  },
];
