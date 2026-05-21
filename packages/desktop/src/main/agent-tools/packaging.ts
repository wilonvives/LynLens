import { z } from 'zod';
import { type LynLensToolDef, text } from './types';
import {
  generatePackagingSpecFor,
  exportPackagingRemotion,
} from '../ipc/packaging-remotion';

/**
 * 商务讲解 (Remotion) packaging — the chat-driven equivalent of the
 * packaging tab's 「✨ 一键包装」 + 「🎬 导出成品」 for the business-explainer
 * template. Reuses the exact same shared functions as the IPC handlers, so
 * chat-driven and UI-driven packaging behave identically.
 */
export const packagingTools: LynLensToolDef[] = [
  {
    name: 'package_with_business_explainer',
    description:
      'AI 用「商务讲解」Remotion 模板编排一个变体(或整片):看字幕,逐行决定样式(plain/strong/strongWord/sentence 三行/cross 十字)+ 关键词高亮 + 镜头特效线 + 音效线,产出可在包装 tab 实时预览/二度编辑的 spec。variantId=null 打包整片。结果持久化到 .qcp,导出时用它。',
    schema: {
      projectId: z.string(),
      variantId: z.string().nullable().default(null),
    },
    handler: async (
      args: { projectId: string; variantId: string | null },
      engine
    ) => {
      const plan = await generatePackagingSpecFor(engine, args.projectId, args.variantId);
      const spec = plan.templateSpec;
      if (!spec) {
        return { content: [{ type: 'text', text: '编排失败:没有生成 spec。' }], isError: true };
      }
      const byStyle = spec.cues.reduce<Record<string, number>>((acc, c) => {
        acc[c.style] = (acc[c.style] ?? 0) + 1;
        return acc;
      }, {});
      const styleSummary = Object.entries(byStyle)
        .map(([s, n]) => `${s}×${n}`)
        .join(' · ');
      return text(
        `已用「商务讲解」模板编排 ${spec.cues.length} 行字幕。\n` +
          `样式分布: ${styleSummary}\n` +
          `镜头特效: ${spec.effects?.length ?? 0} 条 · 音效: ${spec.sounds?.length ?? 0} 条\n` +
          `在包装 tab 选「商务讲解」可实时预览 + 逐行/特效/音效二度编辑,或用 export_packaging_video 直接导出。`
      );
    },
  },
  {
    name: 'export_packaging_video',
    description:
      '把「商务讲解」模板的编排(spec)用 Remotion 渲染成最终成品视频(像素级等于包装 tab 预览)。需先 package_with_business_explainer 生成 spec。outputPath 可为绝对路径或文件名(默认落 Downloads)。渲染较慢(整片可能数分钟),进度走导出事件。',
    schema: {
      projectId: z.string(),
      variantId: z.string().nullable().default(null),
      outputPath: z.string(),
    },
    handler: async (
      args: { projectId: string; variantId: string | null; outputPath: string },
      engine
    ) => {
      const result = await exportPackagingRemotion(
        engine,
        args.projectId,
        args.variantId,
        args.outputPath
      );
      const mb = (result.sizeBytes / 1024 / 1024).toFixed(1);
      return text(`✅ 导出完成: ${result.outputPath} (${mb} MB)`);
    },
  },
];
