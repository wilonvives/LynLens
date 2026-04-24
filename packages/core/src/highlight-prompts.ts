import { mapRangeToEffective } from './ripple';
import type { Range, Transcript } from './types';

/**
 * Which strategy Claude should use when picking highlight segments.
 *   - default   : general best-of compilation
 *   - hero      : optimised for openers / social-media hooks
 *   - ai-choice : let the model pick any style it likes
 */
export type HighlightStyle = 'default' | 'hero' | 'ai-choice';

export interface HighlightGenerateOptions {
  style: HighlightStyle;
  /** How many variants to produce (1..5). */
  count: number;
  /** Approximate target duration per variant in seconds. */
  targetSeconds: number;
}

const STYLE_DESC: Record<HighlightStyle, string> = {
  default:
    '通用精华混剪风格:从视频中挑出最有价值、最精彩、最有信息密度的段落,组合成一个连贯的短视频。优先观点明确、情绪强、信息含量高、结构完整的段落。',
  hero:
    '片头风格:目标是做成社交媒体视频的开头(第一个 3-10 秒是 hook)。优先选择冲击性观点、悬念设置、抓眼瞬间、最能概括视频核心的一句话。',
  'ai-choice':
    '自由风格:你自己判断最适合这段内容的呈现形式,不受预设风格约束,可以大胆一些。',
};

/**
 * Format an effective-time transcript for Claude. Segments fully inside a
 * cut range are dropped; segments straddling a cut show the outermost
 * effective-time extents. Timestamps are MM:SS.s.
 */
export function formatTranscriptEffective(
  transcript: Transcript,
  cutRanges: readonly Range[]
): string {
  const lines: string[] = [];
  for (const seg of transcript.segments) {
    const pieces = mapRangeToEffective({ start: seg.start, end: seg.end }, cutRanges);
    if (pieces.length === 0) continue;
    const effStart = pieces[0].start;
    const effEnd = pieces[pieces.length - 1].end;
    lines.push(`[${fmtTime(effStart)} - ${fmtTime(effEnd)}] ${seg.text.trim()}`);
  }
  return lines.join('\n');
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

/**
 * System prompt: hard constraints and JSON-only output contract.
 * Keep this small — the heavy instructions live in the user prompt with
 * the actual transcript.
 */
export function buildHighlightSystemPrompt(): string {
  return `你是一位视频剪辑师,专门从长视频中挑出高光时刻组成短视频。你会看到一份已经去掉了停顿和废话的视频字幕(时间已经是压缩后的)。

用户会在 user prompt 里指定一个**固定风格**和**变体数量 N**。你的任务:生成 N 个**同一个风格**的变体,变体之间**必须角度不同**(选段不同、节奏不同、叙事侧重不同),但**风格必须一致**。

内容要求:
1. 时间戳必须来自字幕中真实出现的时间范围,不要编造
2. 每个变体段落数量 2-8 段为宜,太碎或太整块都不好
3. 每段必须给一句 \`reason\` 说明选它的理由
4. N 个 variant 之间**选段差异明显**,不要只换顺序、不要大段重复

JSON 格式硬性要求(违反会导致解析失败):
A. 只输出 JSON 对象,前后不要任何文字,不要 \`\`\`json 代码块围栏
B. 字符串分隔符必须是 ASCII 双引号 "  (不是中文引号 " " 或 ' ')
C. 字符串内部如果出现双引号,必须用反斜杠转义: \\"
D. 字符串内部不要换行;改用空格或中文顿号 、
E. 不要尾逗号: 最后一个数组元素 / 对象属性后面不加逗号
F. 不要 JSON 注释 (// 或 /* */)
G. reason 字段里**尽量不要用任何引号**(单双都不要),用括号或顿号代替

输出格式 (严格照搬,只改内容。style 字段**必须**等于 user prompt 里指定的风格,所有变体都是同一个值):
{
  "variants": [
    {
      "title": "短而有力的中文标题",
      "style": "<照搬 user 里的 style>",
      "segments": [
        { "start": 12.3, "end": 34.5, "reason": "开场 hook 一句话点题" },
        { "start": 45.0, "end": 58.2, "reason": "关键论点 数据支撑" }
      ]
    }
  ]
}`;
}

/**
 * User prompt: the transcript in effective time + style / count / target
 * duration requirements. No magic — Claude only sees what we give here.
 */
export function buildHighlightUserPrompt(opts: {
  transcript: Transcript;
  cutRanges: readonly Range[];
  effectiveDuration: number;
  style: HighlightStyle;
  count: number;
  targetSeconds: number;
}): string {
  const transcriptText = formatTranscriptEffective(opts.transcript, opts.cutRanges);
  const styleDesc = STYLE_DESC[opts.style];
  return `视频总时长(压缩后): ${opts.effectiveDuration.toFixed(1)} 秒
变体数量: ${opts.count}(${opts.count} 个变体,全部同一个风格,不要换风格)
每个变体目标时长: ≈ ${opts.targetSeconds} 秒(±20%)
风格(所有变体都用这个):
  style 字段值: "${opts.style}"
  含义: ${styleDesc}

字幕(时间是压缩后的):
${transcriptText}

请生成 ${opts.count} 个变体,**每个变体的 style 字段都等于 "${opts.style}"**,变体之间选段差异要明显。输出纯 JSON。`;
}
