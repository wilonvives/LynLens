import { z } from 'zod';
import { type LynLensToolDef, okOrFail, text } from './types';

/**
 * Learning-memory tools — let an agent read what LynLens has learned and
 * actively teach it new rules. These are intentionally agent-side
 * equivalents of the IPC handlers in `ipc/learning.ts` so the two surfaces
 * (UI clicks + chat) feed the same learning store.
 *
 * Agent flow that's worth supporting:
 *   1. User: "always change LHDN to 马来西亚税务局"
 *   2. Agent calls `add_auto_correction(LHDN, 马来西亚税务局)`
 *   3. Next transcribe applies it automatically — UI never asked.
 *
 * The "soft" record_correction tool is for cases where the agent is less
 * sure and wants the count-3 threshold to take effect.
 */

export const learningTools: LynLensToolDef[] = [
  {
    name: 'get_learning_state',
    description:
      '查看 LynLens 目前学到了什么：自动修正条数、专有名词数、保留原文词数,以及最近 5 条修正和 1 条等待晋升的记录。展示用,不改任何东西。',
    schema: {},
    handler: async (_args: Record<string, never>, engine) => {
      const snap = engine.learningMemory.snapshot();
      const lines = [
        `🧠 学习记忆现状:`,
        `  自动修正: ${snap.autoCorrectionCount} 条`,
        `  专有名词: ${snap.properNounCount} 个`,
        `  保留原文: ${snap.keepOriginalCount} 个`,
      ];
      if (snap.pendingPromotions.length > 0) {
        lines.push('', '⏳ 即将晋升 (再确认 1 次就自动应用):');
        for (const p of snap.pendingPromotions.slice(0, 5)) {
          lines.push(`  「${p.from}」 → 「${p.to}」 (已确认 ${p.count} 次)`);
        }
      }
      if (snap.recentCorrections.length > 0) {
        lines.push('', '📋 最近修正:');
        for (const r of snap.recentCorrections) {
          lines.push(`  「${r.from}」 → 「${r.to}」 (共 ${r.count} 次)`);
        }
      }
      return text(lines.join('\n'));
    },
  },

  {
    name: 'record_correction',
    description:
      '【软记录】告诉 LynLens 一条用户修正。同一 from→to 累积 3 次后自动晋升为永久规则。适合"用户改了一次字幕"这种场景——不确定是不是要永久应用,先记着。如果用户明确说"以后都这么改",直接用 add_auto_correction。',
    schema: {
      from: z.string(),
      to: z.string(),
      projectId: z.string().optional(),
    },
    handler: async (
      args: { from: string; to: string; projectId?: string },
      engine
    ) => {
      const result = await engine.learningMemory.recordCorrection(args.from, args.to, {
        projectId: args.projectId,
      });
      return text(
        result === 'promoted'
          ? `已记录并自动晋升:「${args.from}」→「${args.to}」 (现在转录会自动应用)`
          : `已记录:「${args.from}」→「${args.to}」 (距离自动应用还差 ${counts(engine, args.from, args.to)} 次)`
      );
    },
  },

  {
    name: 'add_auto_correction',
    description:
      '【硬规则】用户明确说"以后所有 X 都改成 Y" 时调用。跳过 3 次确认门槛,直接进入自动修正库,下次转录立刻生效。',
    schema: {
      from: z.string(),
      to: z.string(),
    },
    handler: async (args: { from: string; to: string }, engine) => {
      await engine.learningMemory.addAutoCorrection(args.from, args.to);
      return text(`已加入自动修正:「${args.from}」→「${args.to}」 (下次转录立刻应用)`);
    },
  },

  {
    name: 'add_proper_noun',
    description:
      '记一个用户教过的专有名词(人名/品牌/地名),并标分类。用户说"BMW Motorrad 是品牌名"时调用。',
    schema: {
      term: z.string(),
      category: z.string(),
    },
    handler: async (args: { term: string; category: string }, engine) => {
      await engine.learningMemory.addProperNoun(args.term, args.category);
      return text(`已记住专有名词:「${args.term}」 (${args.category})`);
    },
  },

  {
    name: 'add_keep_original',
    description:
      '标记一个外语词永远保留原文不翻译。用户说"iPhone 不要翻译"时调用。',
    schema: {
      word: z.string(),
    },
    handler: async (args: { word: string }, engine) => {
      await engine.learningMemory.addKeepOriginal(args.word);
      return text(`已加入保留原文:「${args.word}」`);
    },
  },

  {
    name: 'forget_learning',
    description:
      '撤销一条已学习的规则。kind = correction(自动修正) / noun(专有名词) / keep(保留原文)。',
    schema: {
      kind: z.enum(['correction', 'noun', 'keep']),
      key: z.string(),
    },
    handler: async (
      args: { kind: 'correction' | 'noun' | 'keep'; key: string },
      engine
    ) => {
      const ok = await engine.learningMemory.forget(args.kind, args.key);
      return okOrFail(ok, `已忘掉「${args.key}」`, `未找到要忘掉的「${args.key}」`);
    },
  },
];

/** Helper: count remaining confirmations until promotion for the snapshot string. */
function counts(
  engine: Parameters<LynLensToolDef['handler']>[1],
  from: string,
  to: string
): number {
  const entry = engine.learningMemory.getCorrectionLog().find((e) => e.from === from && e.to === to);
  if (!entry) return 3;
  return Math.max(0, 3 - entry.count);
}
