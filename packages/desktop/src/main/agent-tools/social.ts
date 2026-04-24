import { z } from 'zod';
import type { SocialCopy, SocialPlatform } from '@lynlens/core';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Social-copy generation + post-generation edit (the user usually wants
 * to tweak a line after seeing the output). `set_social_style_note`
 * controls the stylistic voice injected into every generation prompt.
 */

/** Assemble text for the "rippled full version" source. */
function assembleRippledText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  cutRanges: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const t of transcriptSegs) {
    const fullyInCut = cutRanges.some((c) => t.start >= c.start && t.end <= c.end);
    if (fullyInCut) continue;
    const txt = t.text.trim();
    if (txt) lines.push(txt);
  }
  return lines.join('\n');
}

/** Assemble text for a highlight variant source. */
function assembleVariantText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  variantSegs: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const v of variantSegs) {
    for (const t of transcriptSegs) {
      if (t.end <= v.start || t.start >= v.end) continue;
      const txt = t.text.trim();
      if (txt) lines.push(txt);
    }
  }
  return lines.join('\n');
}

export const socialTools: LynLensToolDef[] = [
  {
    name: 'generate_social_copies',
    description:
      '为指定平台生成社媒文案。sourceType=rippled 用粗剪后字幕;=variant 则用某个高光变体(需 sourceVariantId)。platforms 数组并行生成,每平台独立返回(标题/正文/hashtags)。',
    schema: {
      projectId: z.string(),
      sourceType: z.enum(['rippled', 'variant'] as const),
      sourceVariantId: z.string().optional(),
      platforms: z.array(
        z.enum(['xiaohongshu', 'instagram', 'tiktok', 'youtube', 'twitter'] as const)
      ),
      userStyleNote: z.string().optional(),
    },
    handler: async (
      args: {
        projectId: string;
        sourceType: 'rippled' | 'variant';
        sourceVariantId?: string;
        platforms: SocialPlatform[];
        userStyleNote?: string;
      },
      engine
    ) => {
      const project = engine.projects.get(args.projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        return {
          content: [{ type: 'text', text: '请先生成字幕后再生成文案。' }],
          isError: true,
        };
      }

      let sourceText: string;
      let sourceTitle: string;
      if (args.sourceType === 'variant') {
        if (!args.sourceVariantId) {
          return {
            content: [{ type: 'text', text: 'sourceType=variant 时必须提供 sourceVariantId' }],
            isError: true,
          };
        }
        const variant = project.findHighlightVariant(args.sourceVariantId);
        if (!variant) {
          return {
            content: [{ type: 'text', text: `找不到变体 ${args.sourceVariantId}` }],
            isError: true,
          };
        }
        sourceTitle = `高光变体:${variant.title}`;
        sourceText = assembleVariantText(project.transcript.segments, variant.segments);
      } else {
        sourceTitle = '粗剪完整版';
        sourceText = assembleRippledText(project.transcript.segments, project.cutRanges);
      }

      const { runCopywriterViaCurrentProvider } = await import('../agent-dispatcher');
      const platformResults = await Promise.allSettled(
        args.platforms.map((platform) =>
          runCopywriterViaCurrentProvider({
            sourceTitle,
            sourceText,
            platform,
            userStyleNote: args.userStyleNote ?? project.socialStyleNote ?? undefined,
          })
        )
      );

      const copies: SocialCopy[] = [];
      const failures: string[] = [];
      let model: string | undefined;
      for (let i = 0; i < platformResults.length; i++) {
        const r = platformResults[i];
        if (r.status === 'fulfilled') {
          copies.push(r.value.copy);
          if (r.value.model) model = r.value.model;
        } else {
          failures.push(`${args.platforms[i]}: ${(r.reason as Error).message}`);
        }
      }

      if (copies.length === 0) {
        return {
          content: [{ type: 'text', text: `全部平台生成失败:\n${failures.join('\n')}` }],
          isError: true,
        };
      }

      const setId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      project.addSocialCopySet({
        id: setId,
        sourceType: args.sourceType,
        sourceVariantId: args.sourceVariantId,
        sourceTitle,
        sourceText,
        userStyleNote: args.userStyleNote ?? null,
        copies: copies.map((c) => ({
          id: c.id,
          platform: c.platform,
          title: c.title,
          body: c.body,
          hashtags: c.hashtags,
        })),
        createdAt: new Date().toISOString(),
        model,
      });

      const summary =
        `生成了 ${copies.length} 个平台的文案。` +
        copies
          .map((c) => `\n- ${c.platform}: ${(c.title || c.body).slice(0, 40)}`)
          .join('') +
        (failures.length > 0 ? `\n\n失败: ${failures.join('\n')}` : '');
      return text(summary);
    },
  },

  {
    name: 'get_social_copies',
    description: '列出所有已生成的文案集(每组有多个平台的文案)。用来定位 setId/copyId。',
    schema: { projectId: z.string() },
    handler: async ({ projectId }: { projectId: string }, engine) => {
      const sets = engine.projects.get(projectId).socialCopies;
      return { content: [{ type: 'text', text: JSON.stringify(sets, null, 2) }] };
    },
  },

  {
    name: 'update_social_copy',
    description: '改一条生成的文案(标题/正文/hashtags)。patch 里只传要改的字段。',
    schema: {
      projectId: z.string(),
      setId: z.string(),
      copyId: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      hashtags: z.array(z.string()).optional(),
    },
    handler: async (
      args: {
        projectId: string;
        setId: string;
        copyId: string;
        title?: string;
        body?: string;
        hashtags?: string[];
      },
      engine
    ) => {
      const ok = engine.projects.get(args.projectId).updateSocialCopy(args.setId, args.copyId, {
        title: args.title,
        body: args.body,
        hashtags: args.hashtags,
      });
      return okOrFail(ok, `已更新 ${args.copyId.slice(0, 8)}`, '找不到对应文案');
    },
  },

  {
    name: 'delete_social_copy',
    description: '从某个文案集里删一个平台的文案。整组要删用 delete_social_copy_set。',
    schema: {
      projectId: z.string(),
      setId: z.string(),
      copyId: z.string(),
    },
    handler: async (
      args: { projectId: string; setId: string; copyId: string },
      engine
    ) => {
      const ok = engine.projects.get(args.projectId).deleteSocialCopy(args.setId, args.copyId);
      return okOrFail(ok, '已删除', '找不到对应文案');
    },
  },

  {
    name: 'delete_social_copy_set',
    description: '永久删除一整组文案(含所有平台条目)。',
    schema: { projectId: z.string(), setId: z.string() },
    handler: async (args: { projectId: string; setId: string }, engine) => {
      const ok = engine.projects.get(args.projectId).deleteSocialCopySet(args.setId);
      return okOrFail(ok, '已删除文案集', '找不到');
    },
  },

  {
    name: 'set_social_style_note',
    description:
      '设置全局「风格说明」文本 —— 下次生成文案时会被拼进 prompt,让模型贴近这个风格。null 或空 = 清除。',
    schema: {
      projectId: z.string(),
      note: z.string().nullable(),
    },
    handler: async (args: { projectId: string; note: string | null }, engine) => {
      engine.projects.get(args.projectId).setSocialStyleNote(args.note);
      return text(args.note ? `风格说明已设为: ${args.note.slice(0, 60)}` : '风格说明已清除');
    },
  },
];
