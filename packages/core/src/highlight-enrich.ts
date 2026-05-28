/**
 * "🪄 enrich" — let Claude look at a variant's segments + the surrounding
 * transcript, then propose:
 *   - a punchy short title (8-20 chars CJK preferred)
 *   - a one-line reason per segment explaining WHY it's worth keeping
 *
 * Used by the highlight tab to populate empty/auto-named variants
 * (e.g. "自定义 #1") with meaningful metadata. The AI is told NOT to
 * touch segment ranges (start/end) — only the labels around them.
 *
 * Tolerant parser: ill-formed AI output won't throw; missing reasons
 * yield `null` entries so the project-manager update preserves whatever
 * the user already had.
 */
import { extractJsonObject } from './highlight-parser';

export interface EnrichSegmentInput {
  /** Index into variant.segments (0-based). */
  segmentIdx: number;
  /** Source-time bounds for AI context (so it can reason about ordering). */
  start: number;
  end: number;
  /** Existing reason (may be empty / generic). AI can refine or replace. */
  existingReason: string;
  /** Transcript text inside this range — joined, no per-segment markers. */
  transcriptText: string;
}

export interface EnrichInput {
  /**
   * The variant's current title. AI uses this as context only — it can
   * propose a different title, or keep this one by returning it verbatim.
   */
  currentTitle: string;
  totalDurationSec: number;
  /** Helpful styling hint Claude already understands (default | hero | etc). */
  styleHint?: string;
  segments: EnrichSegmentInput[];
}

export interface EnrichOutput {
  /** Proposed title; null if AI declined / parse failed. */
  title: string | null;
  /**
   * Per-segment proposed reason. Aligned to `segments[]` input order.
   * `null` for any segment AI couldn't / wouldn't enrich.
   */
  reasons: Array<string | null>;
}

const SYSTEM_PROMPT = `你是短视频高光剪辑的文案助理。

用户给你一份「变体」的资料: 几个时间段 + 每段里说话人讲了什么内容。你的任务是输出两类文本:

1. **title** — 这个变体的标题, 8-20 字, 体现整组段落的核心钩子或主题. 像短视频标题, 不像论文标题. **标题会被直接用作导出文件名, 所以不要包含任何标点或特殊符号 (? ? : / \\ * " < > | 。 , 、 ! 等都不行), 需要停顿就用空格.** 例如:
   - 好: "钱骡罚款完才是噩梦开始" / "SLAPP 让你闭嘴的策略性诉讼"
   - 不好: "讲座内容片段一" / "金融案例 #3" (太通用) / "钱骡户口想开回?银行说不行" (有问号, 不能做文件名)

2. **reasons** — 每段一句话备注 (8-30 字), 说明这段为什么值得留, 帮用户后面快速回顾. 像剪辑师贴在时间线上的小笔记, 不是总结字幕. 例如:
   - "钩子段, 抛出'你以为完了, 其实才开始'的反转"
   - "核心数据: 3 万人受害的具体数字"
   - "情绪爆点, '永远出不了身' 一句话押重锤"

不要改时间段范围. 不要改 segmentIdx. 不要给段标颜色 / 字体 / 任何视觉样式.

输出 JSON, 严格格式:
{
  "title": "示例标题",
  "reasons": [
    { "segmentIdx": 0, "reason": "钩子段..." },
    { "segmentIdx": 1, "reason": "核心数据..." }
  ]
}

JSON 硬性要求:
A. 只输出 JSON, 前后无文字, 不要 \`\`\`json 围栏
B. 字符串双引号必须是 ASCII "
C. 不要尾逗号
D. 不要注释

如果某段你判断不出值得说的, 输出 reason 为空字符串 "", 我会保留用户原有备注. 不要硬编套话.`;

export function buildEnrichSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export function buildEnrichUserPrompt(input: EnrichInput): string {
  const lines: string[] = [];
  lines.push(`当前变体标题: ${input.currentTitle || '(无)'}`);
  lines.push(`总时长: ${input.totalDurationSec.toFixed(1)} 秒, ${input.segments.length} 段`);
  if (input.styleHint) lines.push(`风格: ${input.styleHint}`);
  lines.push('');
  lines.push('--- 段落明细 ---');
  for (const seg of input.segments) {
    lines.push(
      `[seg ${seg.segmentIdx}] ${seg.start.toFixed(2)}-${seg.end.toFixed(2)}s` +
        (seg.existingReason ? ` (现有备注: ${seg.existingReason})` : '')
    );
    lines.push(`  内容: ${seg.transcriptText || '(无字幕)'}`);
  }
  lines.push('');
  lines.push('请输出 title + reasons. 每个 segmentIdx 一条 reason (空字符串表示保留现有备注).');
  return lines.join('\n');
}

interface RawEnrich {
  title?: unknown;
  reasons?: unknown;
}

interface RawReason {
  segmentIdx?: unknown;
  reason?: unknown;
}

/**
 * Parse the AI response into structured fields. Always succeeds (returns
 * { title: null, reasons: [...nulls] }) when the response is unparseable
 * or empty — caller treats nulls as "preserve existing".
 *
 * @param raw  AI output (possibly with markdown fences / trailing commas)
 * @param segmentCount  number of segments in the variant; output reasons[]
 *                      length always matches this exactly
 */
export function parseEnrichResponse(raw: string, segmentCount: number): EnrichOutput {
  const nullReasons = new Array<string | null>(segmentCount).fill(null);
  let parsed: RawEnrich;
  try {
    parsed = extractJsonObject(raw) as RawEnrich;
  } catch {
    return { title: null, reasons: nullReasons };
  }

  let title: string | null = null;
  if (typeof parsed.title === 'string') {
    const t = parsed.title.trim();
    // Reject obvious placeholders that don't add information.
    if (t && t.length <= 40 && !/^(变体|未命名|untitled)/i.test(t)) {
      title = t;
    }
  }

  const reasons = [...nullReasons];
  if (Array.isArray(parsed.reasons)) {
    for (const r of parsed.reasons) {
      if (typeof r !== 'object' || r === null) continue;
      const rr = r as RawReason;
      const idx = typeof rr.segmentIdx === 'number' ? Math.floor(rr.segmentIdx) : -1;
      if (idx < 0 || idx >= segmentCount) continue;
      if (typeof rr.reason !== 'string') continue;
      const r2 = rr.reason.trim();
      // Empty reason → leave the slot as null (= preserve existing).
      if (!r2) continue;
      // Defensive length cap to keep .qcp clean.
      reasons[idx] = r2.slice(0, 80);
    }
  }

  return { title, reasons };
}
