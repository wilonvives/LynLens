import { PLATFORM_LABELS, PLATFORM_RULES, type SocialPlatform } from './copywriter-platforms';

export { PLATFORM_LABELS, type SocialPlatform } from './copywriter-platforms';

export interface CopywriterGenerateInput {
  /** Human label for the source shown in UI / kept in the snapshot. */
  sourceTitle: string;
  /** Full text snapshot the model reads. Already assembled by caller. */
  sourceText: string;
  /** Target platform — the system prompt loads only this platform's rules. */
  platform: SocialPlatform;
  /** Optional user-provided voice/style note, e.g. "我账号定位是 XX". */
  userStyleNote?: string;
}

/**
 * System prompt for a single-platform copy generation. Loads ONLY that
 * platform's rules so the model focuses — mixing multiple platforms'
 * guidance in one call dilutes output quality noticeably.
 */
export function buildCopywriterSystemPrompt(platform: SocialPlatform): string {
  const rules = PLATFORM_RULES[platform];
  const label = PLATFORM_LABELS[platform];
  return `你是一位资深社媒文案操盘手。根据用户提供的视频文本内容,为 ${label} 平台撰写一条可以直接发布的文案。

遵循以下平台规则(硬性):
${rules}

内容要求:
1. 从文本中提炼 1 个核心传播点(不要贪多)
2. 标题/Hook 前 10 个字必须抓人,不抓人全盘失败
3. 语气/结构/字数严格遵守上面的平台规则
4. 一条文案只打一种情绪牌(种草/痛点/悬念/反直觉 择一)
5. 如果原文是中文,输出中文;英文则英文;不要自作主张翻译

JSON 格式硬性要求(违反会导致解析失败):
A. 只输出 JSON 对象,前后不要任何文字或代码块围栏
B. 字符串分隔符必须是 ASCII 双引号 " (不是中文引号)
C. 字符串内部如需双引号,用反斜杠转义 \\"
D. 字符串内部不要换行,改用 \\n 转义
E. 没有尾逗号,没有 // 注释
F. 字段 title 若平台无标题概念(tiktok / twitter)填空字符串 ""
G. hashtags 是数组,每个元素是单个标签字符串(不要带 # 前缀)

输出格式(只改内容,结构不变):
{
  "platform": "${platform}",
  "title": "标题文本或空字符串",
  "body": "正文完整内容(可含 emoji 和换行用 \\n)",
  "hashtags": ["tag1", "tag2", "tag3"]
}`;
}

/**
 * User prompt: the source text snapshot + (optional) the user's style
 * note. Claude is given just enough to write one focused piece of copy.
 */
export function buildCopywriterUserPrompt(input: CopywriterGenerateInput): string {
  const styleBlock = input.userStyleNote?.trim()
    ? `\n账号风格 / 补充说明:\n${input.userStyleNote.trim()}\n`
    : '';
  return `内容来源: ${input.sourceTitle}
平台: ${PLATFORM_LABELS[input.platform]}
${styleBlock}
原始文本:
---
${input.sourceText}
---

请为 ${PLATFORM_LABELS[input.platform]} 生成一条可以直接发布的文案,严格遵守系统提示里的平台规则和 JSON 格式。`;
}
