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
  return `你是一位视频剪辑师,专门从长视频中挑出高光时刻组成短视频。你会看到一份已经去掉了停顿和废话的视频字幕(时间已经是压缩后的)。任务是挑出几个**不同风格**的"变体",每个变体是一组段落,拼起来就是一个独立的短视频。

严格要求:
1. 只输出 JSON,不要任何前后解释文字,不要 markdown 代码块
2. 时间戳必须来自字幕中真实出现的时间范围,不要编造
3. 每个变体段落数量 2-8 段为宜,太碎或太整块都不好
4. 每段必须给一句 \`reason\` 说明选它的理由
5. variant 之间必须有差异(段落选择、节奏、角度不同)

输出格式:
{
  "variants": [
    {
      "title": "短而有力的中文标题",
      "style": "default | hero | ai-choice",
      "segments": [
        { "start": 12.3, "end": 34.5, "reason": "开场 hook" },
        { "start": 45.0, "end": 58.2, "reason": "关键论点" }
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
目标变体数量: ${opts.count}
每个变体目标时长: ≈ ${opts.targetSeconds} 秒(±20%)
风格要求: ${styleDesc}

字幕(时间是压缩后的):
${transcriptText}

请生成 ${opts.count} 个变体,输出纯 JSON。`;
}
