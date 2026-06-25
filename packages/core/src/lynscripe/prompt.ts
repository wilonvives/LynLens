/**
 * Stage 1 prompt. The text model does THREE closely-related semantic jobs and
 * nothing else (doc §6.5): transcribe, flag uncertain terms, format into cue
 * lines. Timestamps + final line-length enforcement are Python/TS's job, never
 * the model's.
 */
import type { VocabEntry } from './types';

/** Max visual width per cue line the model should aim for (CJK ≈ 1 each). */
const TARGET_LINE_CHARS = 16;

export function buildTranscribeSystemPrompt(): string {
  return `你是专业的字幕转录员。给你一段音频,你只做三件密切相关的事,别的都不做:
1. 转录:把语音逐字转成文字,忠实原话(口语、语气保留),不要翻译、不要总结、不要润色。
2. 标记不确定词:凡是你拿不准写法的词(人名/品牌/地名/机构/专有术语/缩写/本地俚语),用占位符 {{T1}} {{T2}} … 代替它在正文里的每一次出现,并在 uncertain_terms 里列出。
   - 同一个词多次出现 → 全部用同一个 id,occurrences 记次数。
   - 普通常见词不要标(只标真正可能写错的)。
3. 格式化:按句意断成一行一条字幕,每行尽量 ≤ ${TARGET_LINE_CHARS} 个字(中文按字、英文按词大致估算),在语气停顿处断,别把一个完整短语拆断。**字幕惯例:不要任何标点符号**(逗号、句号、问号、感叹号、顿号、引号、括号、省略号等都不要),靠换行表示停顿。

**你不要做**:不要输出时间戳(交给本地工具);不要硬凑行长(断行只按句意,长度是软目标);不要清洗内容(忠实原话);不要加标点。

JSON 输出硬性要求(违反会解析失败):
A. 只输出一个 JSON 对象,前后不要任何文字,不要 \`\`\`json 代码块围栏。
B. 字符串分隔符用 ASCII 双引号 ";内部双引号转义 \\";内部不要换行(用 \\n 表示字幕换行)。
C. 不要尾逗号,不要 JSON 注释。
D. transcript_template 里的换行用字面 \\n 分隔每条字幕。

输出格式(照搬结构,只改内容):
{
  "transcript_template": "第一条字幕\\n第二条有个{{T1}}的字幕\\n第三条又提到{{T1}}",
  "uncertain_terms": [
    { "id": "T1", "heard": "听到的原始写法", "guess": "最可能的正确写法", "context": "出现该词的一句上下文", "occurrences": 2, "category": "term" }
  ]
}
category 取值: person | brand | place | org | term | abbr | other`;
}

/**
 * Build the user prompt. The vocab (known proper nouns from LearningMemory) is
 * appended so the model spells them consistently — this is how the tool gets
 * smarter the more the user confirms (doc §2.2).
 */
export function buildTranscribeUserPrompt(opts: {
  vocab: VocabEntry[];
  language?: string;
}): string {
  const lang =
    opts.language && opts.language !== 'auto'
      ? `音频语言: ${opts.language}(混入其他语言时如实保留原文)。`
      : '音频可能中英/方言混杂,如实保留每种语言的原文,不要翻译。';
  const lines: string[] = [lang, ''];
  if (opts.vocab.length > 0) {
    lines.push('【已有词库参考】(优先按这些写法拼写,匹配到就别再标为不确定词)');
    for (const v of opts.vocab.slice(0, 200)) {
      const meaning = v.meaning ? `(${v.meaning})` : '';
      const cat = v.category ? ` [${v.category}]` : '';
      lines.push(`- ${v.term}${meaning}${cat}`);
    }
    lines.push('');
  }
  lines.push('请转录这段音频,按上面的规则输出纯 JSON。');
  return lines.join('\n');
}
