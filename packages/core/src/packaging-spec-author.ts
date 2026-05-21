/**
 * AI spec-author for the `business-explainer` Remotion template.
 *
 * The deterministic `planToSpec` (packaging-spec.ts) only derives
 * plain/strong/strongWord. To reach the template's full editorial range
 * (sentence 三行 Hero, cross 十字, curated camera + sound lines, CJK keyword
 * substrings) a model must make the judgement calls RULES.md describes.
 *
 * Design — the model decides STYLE, not TIMING. We hand it the variant-time
 * transcript lines (idx + start + text) and ask for, per line: a style id +
 * optional keyword substrings + optional hero segments; plus an effects line
 * and a sounds line in variant seconds. We then build the final cues from
 * the transcript text + our own variant-time mapping, so timing/text are
 * never the model's responsibility (no drift). Mirrors the proven
 * build-captions.mjs HIGHLIGHTS-table approach.
 */
import { extractJsonObject } from './highlight-parser';
import {
  SPEC_SOUND_IDS,
  segmentVariantStart,
  type BusinessExplainerSpec,
  type SpecCue,
  type SpecCueStyle,
  type SpecEffect,
  type SpecEffectType,
  type SpecSound,
} from './packaging-spec';
import type { PreviewPlaylistEntry } from './preview-render';
import type { Transcript } from './types';

/** One transcript line, already mapped to variant time. */
export interface SpecAuthorLine {
  idx: number;
  variantStart: number;
  text: string;
}

/**
 * Build the variant-time line skeleton the spec-author works from: every
 * transcript segment whose midpoint lands inside the variant playlist,
 * rebased to variant seconds, in playback order.
 */
export function buildSpecAuthorLines(
  transcript: Transcript,
  playlist: PreviewPlaylistEntry[]
): SpecAuthorLine[] {
  const lines: SpecAuthorLine[] = [];
  transcript.segments.forEach((seg, idx) => {
    const vStart = segmentVariantStart(seg.start, seg.end, playlist);
    if (vStart === null) return;
    const text = seg.text.trim();
    if (!text) return;
    lines.push({ idx, variantStart: vStart, text });
  });
  lines.sort((a, b) => a.variantStart - b.variantStart);
  return lines;
}

const VALID_STYLES: ReadonlySet<string> = new Set<SpecCueStyle>([
  'plain',
  'strong',
  'strongWord',
  'sentence',
  'cross',
]);
const VALID_EFFECTS: ReadonlySet<string> = new Set<SpecEffectType>([
  'impactPunch',
  'vignetteFocus',
  'bottomScrim',
  'coolGrade',
]);
const VALID_SOUND_IDS: ReadonlySet<string> = new Set<string>(SPEC_SOUND_IDS);

export function buildSpecAuthorSystemPrompt(): string {
  return `你是"商务讲解"竖屏短视频的字幕花字 + 镜头 + 音效编排师。视觉身份:思源宋体 + 白字描边 + 黄色强调,权威/严肃/编辑感。

你会拿到一份按时间排好的字幕(每行有 idx + start 秒 + text)。你的任务:给**每一行**判定一个字幕样式,并编排镜头特效线和音效线。**不要改文本、不要改时间、不要新增/删除行。**

# 字幕样式(5 选 1)
- plain — 普通白字,铺垫/过渡/次要信息,或超长英文/马来文句。
- strong — 大粗白字,主体叙述(最常用,主力)。
- strongWord — strong + 句中 1-2 个关键词黄色放大凸出。给 highlight 填关键词(**必须是 text 里原样出现的子串**,区分简繁/大小写)。
- sentence — 金句/结论/强转折,拆 3 节做三行 Hero。给 segments 填 [中,上,下](读序中→上→下能拼回原句;每节 1-3 字佳)。
- cross — 2 节对仗/冲击短句,竖+横十字。给 segments 填 [竖,横](竖节限中文 1-3 字;横节 2-5 字)。

# 样式密度(硬约束)
- plain ≤ 20%(普通字越少越炸,大胆装饰)。
- 开场第一句不要 plain。
- Hero(sentence + cross)每 15-20 秒最多 1 个,全片均匀分布,不要连用。
- 主体用 strong,strongWord 点亮关键词,Hero 做高潮。
- 关键词选名词/术语/数字/情绪词/主题词,一行最多 1-2 个。

# 镜头特效线 effects(作用于背景视频,窗口不可重叠;秒)
- impactPunch — 冲击推近,配 Hero 句或最炸的点。一片约 4 处。
- vignetteFocus — 黑边压暗,开场留人/转严肃。一般开头一次。
- bottomScrim — 底部底盘,配连续多句重点信息的密集段。
- coolGrade — 去色冷调,**极少用且要短**,只配视觉惊悚瞬间(进监牢/被抓);大多数片一次都不用。
- 结尾特效用 "tail":"hold"(戛然而止,不收回);片中用默认 release。

# 音效线 sounds(秒,15 个 id 选用)
opening(开头一次): suspense-boom / tense-transition / shh-tension
keypoint(重点,混用降重复): variety-suspense / variety-suspense-tap / ming-suspense / clang-light / variety-suspense-wrong / eerie-drip
goldquote(金句/励志收尾): flash-transition / water-drop-soft / water-drop
ending(收束): wood-knock / impact-echo / pause-transition
规则: 音效只落在被装饰的行(strong/strongWord/sentence/cross)上,**绝不落在 plain 上**;相邻音效间隔 ≥ 2.5 秒;一片 60 秒约 10-12 个;每次换不同的避免重复。

# 输出 JSON(严格)
A. 只输出 JSON 对象,前后不要任何文字,不要代码块围栏。
B. ASCII 双引号;字符串内双引号转义 \\";不要尾逗号;不要注释。
C. lines 只列"非 plain"的行(plain 行不用列,会自动当 plain);其余字段按需。

格式:
{
  "lines": [
    { "idx": 0, "style": "strong" },
    { "idx": 4, "style": "strongWord", "highlight": ["钱骡"] },
    { "idx": 14, "style": "sentence", "segments": ["它","比破产","更恐怖"] },
    { "idx": 6, "style": "cross", "segments": ["被银行","关闭"] }
  ],
  "effects": [
    { "type": "vignetteFocus", "start": 0, "end": 3.5 },
    { "type": "impactPunch", "start": 17.2, "end": 18.3 }
  ],
  "sounds": [
    { "id": "suspense-boom", "start": 0.25 },
    { "id": "ming-suspense", "start": 17.2 }
  ]
}`;
}

export function buildSpecAuthorUserPrompt(opts: {
  title: string;
  totalDurationSec: number;
  lines: SpecAuthorLine[];
}): string {
  const body = opts.lines
    .map((l) => `idx ${l.idx} (${l.variantStart.toFixed(1)}s): ${l.text}`)
    .join('\n');
  return `视频: ${opts.title}
总时长: ${opts.totalDurationSec.toFixed(1)} 秒(竖屏 9:16)

字幕(idx + 出现秒 + 文本):
${body}

请按规则输出编排 JSON。记住:plain 行不用列;highlight 词必须是该行 text 的原样子串;sentence/cross 必须给 segments;effects 窗口不重叠;音效不落在 plain 上、间隔 ≥2.5s。`;
}

// ---------- Parser ----------

interface RawLine {
  idx?: unknown;
  style?: unknown;
  highlight?: unknown;
  segments?: unknown;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/**
 * Parse the model's editorial decisions into a validated spec. Timing +
 * text come from `lines` (our variant-time skeleton); the model only
 * contributes style / keywords / hero-splits / effects / sounds. Anything
 * invalid is dropped, never coerced.
 *
 * @throws when the response has no parseable JSON.
 */
export function parseSpecAuthorResponse(
  raw: string,
  lines: SpecAuthorLine[]
): BusinessExplainerSpec {
  const payload = extractJsonObject(raw) as Record<string, unknown>;

  // Index the model's per-line decisions.
  const rawLines = Array.isArray(payload.lines) ? (payload.lines as RawLine[]) : [];
  const decisionByIdx = new Map<number, RawLine>();
  for (const rl of rawLines) {
    if (typeof rl !== 'object' || rl === null) continue;
    const idx = typeof rl.idx === 'number' ? Math.floor(rl.idx) : -1;
    if (idx < 0) continue;
    decisionByIdx.set(idx, rl);
  }

  // Build one cue per transcript line; unlisted → plain.
  const cues: SpecCue[] = lines.map((line) => {
    const d = decisionByIdx.get(line.idx);
    const text = line.text.trim();
    const start = Number(line.variantStart.toFixed(3));
    const rawStyle = typeof d?.style === 'string' ? d.style : 'plain';
    let style: SpecCueStyle = VALID_STYLES.has(rawStyle)
      ? (rawStyle as SpecCueStyle)
      : 'plain';

    if (style === 'strongWord') {
      // Keep only keyword substrings genuinely present in the line and
      // shorter than the whole line (don't blow a full line into a hot word).
      const highlight = asStringArray(d?.highlight).filter(
        (w) => text.includes(w) && w !== text
      );
      if (highlight.length === 0) {
        return { start, text, style: 'strong' }; // downgrade: no valid keyword
      }
      return { start, text, style, highlight };
    }

    if (style === 'sentence' || style === 'cross') {
      const segments = asStringArray(d?.segments);
      const need = style === 'sentence' ? 3 : 2;
      if (segments.length !== need) {
        return { start, text, style: 'strong' }; // bad split → strong
      }
      return { start, text, style, segments };
    }

    return { start, text, style };
  });

  return {
    cues,
    effects: parseEffects(payload.effects),
    sounds: parseSounds(payload.sounds, cues),
  };
}

/** Validate + sort + de-overlap effects (CameraLayer takes first hit). */
function parseEffects(raw: unknown): SpecEffect[] {
  if (!Array.isArray(raw)) return [];
  const parsed: SpecEffect[] = [];
  for (const e of raw) {
    if (typeof e !== 'object' || e === null) continue;
    const o = e as Record<string, unknown>;
    if (typeof o.type !== 'string' || !VALID_EFFECTS.has(o.type)) continue;
    if (typeof o.start !== 'number' || typeof o.end !== 'number') continue;
    const start = Math.max(0, o.start);
    const end = o.end;
    if (!(end > start)) continue;
    const eff: SpecEffect = {
      type: o.type as SpecEffectType,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    };
    if (o.tail === 'hold' || o.tail === 'release') eff.tail = o.tail;
    if (typeof o.origin === 'string') eff.origin = o.origin;
    parsed.push(eff);
  }
  parsed.sort((a, b) => a.start - b.start);
  // Drop windows that overlap the previous kept one.
  const out: SpecEffect[] = [];
  let lastEnd = -Infinity;
  for (const e of parsed) {
    if (e.start < lastEnd) continue;
    out.push(e);
    lastEnd = e.end;
  }
  return out;
}

/** Validate sound ids + spacing; drop sounds landing on a plain cue. */
function parseSounds(raw: unknown, cues: SpecCue[]): SpecSound[] {
  if (!Array.isArray(raw)) return [];
  // Cue lookup: which style is active at time t.
  const styleAt = (t: number): SpecCueStyle => {
    let cur: SpecCueStyle = 'plain';
    for (const c of cues) {
      if (c.start <= t) cur = c.style;
      else break;
    }
    return cur;
  };
  const candidates: SpecSound[] = [];
  for (const s of raw) {
    if (typeof s !== 'object' || s === null) continue;
    const o = s as Record<string, unknown>;
    if (typeof o.id !== 'string' || !VALID_SOUND_IDS.has(o.id)) continue;
    if (typeof o.start !== 'number' || o.start < 0) continue;
    candidates.push({ id: o.id, start: Number(o.start.toFixed(3)) });
  }
  candidates.sort((a, b) => a.start - b.start);
  const out: SpecSound[] = [];
  let lastStart = -Infinity;
  for (const s of candidates) {
    if (s.start < lastStart + 2.5) continue; // spacing
    if (styleAt(s.start) === 'plain') continue; // never on plain
    out.push(s);
    lastStart = s.start;
  }
  return out;
}
