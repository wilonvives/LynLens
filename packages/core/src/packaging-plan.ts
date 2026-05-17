import { v4 as uuid } from 'uuid';
import { extractJsonObject } from './highlight-parser';
import type { Transcript } from './types';

/**
 * AI-driven 一键包装 / video packaging plan.
 *
 * Inspired by 开拍 Kaipai's auto-packaging workflow: Claude reads the
 * transcript of a highlight variant (or the whole video) and outputs a
 * structured plan that says "this segment's subtitle should look like X,
 * this segment's camera should zoom Y, the brand watermark goes in the
 * bottom-right".
 *
 * The plan is **renderer-agnostic** by design — same JSON drives Remotion
 * preview AND export. A future v0.7+ migration to HyperFrames would only
 * swap the renderer adapter, not this schema, the AI prompts, or the UI.
 *
 * v0.5 (MVP) implements just `camera.zoom` + `subtitle.wordEffects.highlight/size`
 * + `subtitle` style overrides. The schema includes v0.6+ placeholder
 * fields (`zoomFrom/zoomTo` for Ken Burns, `effect: 'pop-in'` for word
 * animations, `transitionToNext`) so renderer additions don't require
 * data model changes.
 */

// ---------- Schema types ----------

export interface PackagingPlan {
  id: string;
  /**
   * The highlight variant this plan packages. null when packaging the
   * whole un-varianted source (i.e. you've cut a video and want to
   * package the whole rippled output, no high-light pick).
   */
  variantId: string | null;
  /**
   * Permanent overlay (channel logo / handle) burned on every frame.
   * v0.5 renders a static PNG; v0.6+ may support animated PNGs / Lottie.
   */
  brandWatermark?: BrandWatermark;
  /** Project-level default styles. Per-segment values override these. */
  defaults: {
    subtitle?: SubtitleStyle;
  };
  /**
   * Per-segment recipe. Segments NOT listed here get the defaults applied
   * with no special effects — saves payload size and lets Claude focus
   * on the segments that matter (金句 / punchline / 钩子).
   */
  segments: PackagingSegment[];
  createdAt: string;
  /** Which model emitted this plan, for debugging / future memory. */
  model?: string;
}

export interface BrandWatermark {
  /** Absolute path to PNG (with transparency) or base64 data URI. */
  image: string;
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  /** Width as fraction of video width, 0..1. */
  size: number;
  /** 0..1. */
  opacity: number;
}

export interface SubtitleStyle {
  /** CSS font-family. Default: 'PingFang SC Heavy'. */
  font?: string;
  /** Font size in PX at 1080p reference height. */
  size?: number;
  /** Foreground hex color. */
  color?: string;
  /** Stroke / outline (for readability over busy backgrounds). */
  outline?: { color: string; width: number };
  /** Solid background behind the text (alternative to outline). */
  bgColor?: string;
  position?: 'bottom' | 'center' | 'top';
  /** v0.5: only 'none'. v0.6+: 'fade-in' / 'typewriter'. */
  animation?: 'none' | 'fade-in' | 'typewriter';
}

/**
 * Free-form per-segment placement set by the user via drag handles in
 * the preview. When present, it OVERRIDES the default position (top/
 * center/bottom) for that one segment.
 *
 * Why user-only: the parser strips this from AI responses to keep
 * baseline consistent (chaos when AI auto-positions). Drag handles
 * in PackagingSubtitleOverlay write to this, and setPackagingPlan
 * persists it without going through the parser, so it survives.
 *
 * Coords are FRACTIONS of the frame so they scale correctly across
 * preview / export resolutions.
 */
export interface SubtitleTransform {
  /** Center X, 0-1 fraction of frame width. Default 0.5 = horizontal center. */
  x: number;
  /** Center Y, 0-1 fraction of frame height. Default depends on style.position. */
  y: number;
  /** Multiplier on the resolved font-size. 0.3 ≤ s ≤ 3.0. Default 1.0. */
  scale: number;
  /** Clockwise rotation in degrees. -180 ≤ r ≤ 180. Default 0. */
  rotation: number;
}

export interface PackagingSegment {
  /** Index into the variant's segments[] (or transcript's segments[]). */
  segmentIdx: number;
  subtitle?: SubtitleStyle & {
    /**
     * Word-level overrides — make 1-2 punchline words pop visually.
     * v0.5 renders `highlight` + `size`. `effect` is schema placeholder
     * for v0.6+ (renderer ignores it for now).
     */
    wordEffects?: WordEffect[];
    /** User-set drag-handle placement (overrides style.position). */
    transform?: SubtitleTransform;
  };
  camera?: CameraMove;
  /** v0.6+ placeholder, renderer ignores in v0.5. */
  transitionToNext?: { type: 'fade' | 'dissolve' | 'wipe'; duration: number };
  /** v0.6+ placeholder, renderer ignores in v0.5. */
  textOverlay?: {
    text: string;
    appearAt: number;
    duration: number;
  };
}

export interface WordEffect {
  /** Index into the segment's whitespace-tokenised text. */
  wordIdx: number;
  /** Override foreground color. */
  highlight?: string;
  /** Override font size. */
  size?: number;
  /** v0.6+ placeholder. */
  effect?: 'pop-in' | 'shake';
}

export interface CameraMove {
  /** Static zoom factor. 1.0 = original framing. v0.5 supports this. */
  zoom?: number;
  /** Crop center, 0..1 normalised. Default { x: 0.5, y: 0.5 }. */
  focus?: { x: number; y: number };
  // ↓ v0.6+ Ken Burns animation. Renderer ignores in v0.5.
  zoomFrom?: number;
  zoomTo?: number;
  panFrom?: { x: number; y: number };
  panTo?: { x: number; y: number };
  easing?: 'linear' | 'ease-in-out';
}

/**
 * Vibe knob the user can set when triggering 一键包装. Steers Claude
 * toward different packaging styles for the same content.
 */
export type PackagingVibe = 'default' | 'energetic' | 'calm';

// ---------- Default values ----------

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  font: 'PingFang SC Heavy',
  size: 56,
  color: '#ffffff',
  outline: { color: '#000000', width: 3 },
  position: 'bottom',
  animation: 'none',
};

/**
 * Reasonable defaults for a fresh PackagingPlan when the user wants an
 * empty plan to fill in manually (without invoking Claude).
 */
export function emptyPackagingPlan(variantId: string | null): PackagingPlan {
  return {
    id: `pkg_${uuid().slice(0, 8)}`,
    variantId,
    defaults: { subtitle: { ...DEFAULT_SUBTITLE_STYLE } },
    segments: [],
    createdAt: new Date().toISOString(),
  };
}

// ---------- AI prompt builders ----------

const VIBE_DESC: Record<PackagingVibe, string> = {
  default:
    '通用风格 — 每段最多挑 1-2 个关键词加黄色高亮,字号 +20%。',
  energetic:
    '高能风格 — 关键词更密集 (2-3 个/段),颜色更鲜艳 (#ff3333 / #ffd700 轮换),字号 +30%。适合钩子段、热点、爆点。',
  calm:
    '冷静风格 — 关键词稀疏 (0-1 个/段),颜色克制 (#ffcc00),字号 +10%。适合科普、深度内容。',
};

/**
 * System prompt — v0.5 narrow scope: ONLY 字幕花字 (per-word colour +
 * size highlights). Camera zoom + transitions + watermark are in the
 * schema for v0.6+ but Claude is explicitly told to ignore them.
 *
 * Why? The user tried earlier versions with zoom and it caused playback
 * jitter + black-frame flicker before we had the right render pipeline.
 * The MVP nails one thing first.
 */
export function buildPackagingSystemPrompt(): string {
  return `你是短视频字幕花字设计师。

你会看到一份字幕(每段有 idx/start/end/text)。你的任务:**给某些段挑出 1-2 个关键词做花字效果**(变颜色 + 字号放大)。其他什么都不要做。

判断原则:
1. **关键词挑选** — 每段最多挑 1-2 个最该被强调的词:
   - 数字 (3 个、10 万、第一)
   - 人名 / 品牌 / 专有名词
   - 情绪词 (噩梦、可怕、惨、爽)
   - 动词高潮 (爆、崩、炸)
2. **不是所有段都要高亮** — 平铺直叙的解释段、过渡段就不要挑,只给 punchline / 金句 / 钩子加。
3. **只对需要花字的段输出 segments 条目** — 不要列出"无修改"的段,会自动用 defaults。
4. **字号(size)严格控制范围 32-120 px** (相对 1080p 视频高度):
   - 默认 56 (普通字幕),
   - 关键词高亮 64-80 (微强调),
   - 金句 / 钩子 80-100 (大强调),
   - **永远不要超过 120**。超出会被自动 clamp,而且会丑。
   想要"更突出"应该是换颜色 / 加描边,不是单纯放大字号。
5. **段级别 subtitle 只允许 wordEffects 字段** — 不要给某段单独设
   color / position / size / font / outline / bgColor,
   不同段用不同色/位会让整体很乱(已被用户反馈"乱飞")。
   全行风格统一在 defaults.subtitle 里设一次;段级别的差异化只通
   过 wordEffects 体现(关键词变色/放大)。
   段级别非 wordEffects 字段会被自动丢弃。

JSON 输出格式硬性要求(违反会解析失败):
A. 只输出 JSON 对象,前后不要任何文字,不要 \`\`\`json 代码块围栏
B. 字符串分隔符必须是 ASCII 双引号 "
C. 字符串内部如果出现双引号,必须用反斜杠转义: \\"
D. 不要尾逗号
E. 不要 JSON 注释

输出格式(严格照搬,只改值。\`wordIdx\` 是从 0 开始的词索引,词之间用空格分割):
{
  "defaults": {
    "subtitle": {
      "color": "#ffffff"
    }
  },
  "segments": [
    {
      "segmentIdx": 4,
      "subtitle": {
        "wordEffects": [
          { "wordIdx": 1, "highlight": "#ffd700", "size": 68 }
        ]
      }
    },
    {
      "segmentIdx": 12,
      "subtitle": {
        "wordEffects": [
          { "wordIdx": 1, "highlight": "#ff3333", "size": 72 },
          { "wordIdx": 2, "highlight": "#ff3333", "size": 72 }
        ]
      }
    }
  ]
}

**不要输出 camera / transitionToNext / textOverlay / brandWatermark 字段** — v0.5 不渲染它们。专注花字。`;
}

/**
 * User prompt — the actual content (transcript segments + metadata + vibe).
 */
export function buildPackagingUserPrompt(opts: {
  title: string;
  totalDurationSec: number;
  orientation: 'portrait' | 'landscape' | 'unknown';
  segments: Array<{ idx: number; start: number; end: number; text: string }>;
  vibe: PackagingVibe;
}): string {
  const transcriptLines = opts.segments.map((s) => {
    // Show wordIdx hints so Claude can match wordIdx to actual tokens
    // (we tokenise on whitespace; 中文 is split per-char for now since
    // the subtitle renderer does too — see Subtitle.tsx).
    const words = s.text.split(/\s+/);
    const wordsAnnotated = words
      .map((w, i) => `[${i}]${w}`)
      .join(' ');
    return `seg ${s.idx} (${s.start.toFixed(1)}-${s.end.toFixed(1)}s): ${wordsAnnotated}`;
  });

  return `视频标题: ${opts.title}
总时长: ${opts.totalDurationSec.toFixed(1)} 秒
方向: ${opts.orientation === 'portrait' ? '竖屏 9:16' : opts.orientation === 'landscape' ? '横屏 16:9' : '未知'}
vibe: ${opts.vibe} — ${VIBE_DESC[opts.vibe]}

字幕(每段前缀 seg N,词前缀 [wordIdx]):
${transcriptLines.join('\n')}

请输出 PackagingPlan JSON。记住:**只列需要特殊处理的段**,其他段自动用 defaults。`;
}

// ---------- Parser ----------

/**
 * Parse Claude's PackagingPlan response into a validated, sanitised
 * PackagingPlan record. Tolerant of model quirks via extractJsonObject;
 * defensive about types (every field validated, bad values dropped not
 * coerced into nonsense).
 *
 * @throws when the response has no parseable JSON, or no valid segments.
 */
export function parsePackagingPlanResponse(
  raw: string,
  variantId: string | null,
  /** Used to drop segmentIdx values that are out of range. */
  segmentCount: number,
  model?: string
): PackagingPlan {
  const payload = extractJsonObject(raw) as Record<string, unknown>;
  const defaultSubtitle = sanitiseSubtitleStyle(
    (payload.defaults as Record<string, unknown> | undefined)?.subtitle
  ) ?? { ...DEFAULT_SUBTITLE_STYLE };
  const brandWatermark = sanitiseBrandWatermark(payload.brandWatermark);

  const rawSegments = Array.isArray(payload.segments) ? payload.segments : [];
  const segments: PackagingSegment[] = [];
  for (const rawSeg of rawSegments) {
    if (typeof rawSeg !== 'object' || rawSeg === null) continue;
    const seg = rawSeg as Record<string, unknown>;
    const idx = typeof seg.segmentIdx === 'number' ? Math.floor(seg.segmentIdx) : -1;
    if (idx < 0 || idx >= segmentCount) continue;
    const subtitle = sanitiseSubtitleWithWordEffects(seg.subtitle);
    const camera = sanitiseCamera(seg.camera);
    if (!subtitle && !camera) continue; // nothing meaningful in this entry
    const out: PackagingSegment = { segmentIdx: idx };
    if (subtitle) out.subtitle = subtitle;
    if (camera) out.camera = camera;
    segments.push(out);
  }

  return {
    id: `pkg_${uuid().slice(0, 8)}`,
    variantId,
    brandWatermark,
    defaults: { subtitle: defaultSubtitle },
    segments,
    createdAt: new Date().toISOString(),
    model,
  };
}

// ---------- Sanitisers (defensive coercion) ----------

/**
 * Sane subtitle font-size cap, in source-resolution px. Calibrated so a
 * size value on a 1080p (1920-high) source stays well under 7% of frame
 * height. The previous `< 500` ceiling let Claude return 200-300 size
 * values that made one character fill the screen in preview AND took
 * 1 line per char in the burned-in export. Real-world subtitle sizes
 * top out around 72-96 even for the loudest emphasis; capping at 120
 * leaves headroom for a punchline pop without ever blowing up the frame.
 */
const MAX_SUBTITLE_SIZE = 120;
const MIN_SUBTITLE_SIZE = 16;

function clampSubtitleSize(v: number): number {
  return Math.min(MAX_SUBTITLE_SIZE, Math.max(MIN_SUBTITLE_SIZE, v));
}

function sanitiseSubtitleStyle(input: unknown): SubtitleStyle | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = input as Record<string, unknown>;
  const out: SubtitleStyle = {};
  if (typeof v.font === 'string') out.font = v.font;
  if (typeof v.size === 'number' && v.size > 0) out.size = clampSubtitleSize(v.size);
  if (typeof v.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.color)) {
    out.color = v.color;
  }
  if (typeof v.outline === 'object' && v.outline !== null) {
    const o = v.outline as Record<string, unknown>;
    if (
      typeof o.color === 'string' &&
      /^#[0-9a-fA-F]{3,8}$/.test(o.color) &&
      typeof o.width === 'number' &&
      o.width >= 0 &&
      o.width < 50
    ) {
      out.outline = { color: o.color, width: o.width };
    }
  }
  if (typeof v.bgColor === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.bgColor)) {
    out.bgColor = v.bgColor;
  }
  if (v.position === 'bottom' || v.position === 'center' || v.position === 'top') {
    out.position = v.position;
  }
  if (v.animation === 'none' || v.animation === 'fade-in' || v.animation === 'typewriter') {
    out.animation = v.animation;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Segment-level subtitle sanitiser.
 *
 * IMPORTANT design decision: at the SEGMENT level we ONLY keep
 * wordEffects — drop any whole-line color/size/position/font/outline
 * overrides Claude might emit. Rationale:
 *
 *   - Default style is the project-wide look (set in defaults.subtitle).
 *     A consistent baseline is what makes packaged videos look polished.
 *   - Per-segment whole-line overrides used to make different lines
 *     render at different positions (some center, some bottom) and
 *     different colors (some red, some white). Preview looked chaotic
 *     even though export was the same — user feedback "乱飞".
 *   - The user can still manually override per-segment colour via the
 *     字幕 tab's color picker — that's an explicit choice, not AI
 *     surprise. Word-level花字 (the actual emphasis feature) lives
 *     in wordEffects and is preserved.
 *
 * If the schema ever needs to expose AI-driven whole-line styling
 * again, gate it behind an explicit vibe option (e.g. "鬼畜变色"),
 * not the default flow.
 */
function sanitiseSubtitleWithWordEffects(
  input: unknown
): (SubtitleStyle & { wordEffects?: WordEffect[] }) | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = input as Record<string, unknown>;
  const wordEffects: WordEffect[] = [];
  if (Array.isArray(v.wordEffects)) {
    for (const w of v.wordEffects) {
      if (typeof w !== 'object' || w === null) continue;
      const we = w as Record<string, unknown>;
      const wordIdx = typeof we.wordIdx === 'number' ? Math.floor(we.wordIdx) : -1;
      if (wordIdx < 0) continue;
      const effect: WordEffect = { wordIdx };
      if (typeof we.highlight === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(we.highlight)) {
        effect.highlight = we.highlight;
      }
      if (typeof we.size === 'number' && we.size > 0) {
        effect.size = clampSubtitleSize(we.size);
      }
      if (we.effect === 'pop-in' || we.effect === 'shake') {
        effect.effect = we.effect;
      }
      // Only keep if at least one override present.
      if (effect.highlight || effect.size || effect.effect) wordEffects.push(effect);
    }
  }
  if (wordEffects.length > 0) return { wordEffects };
  return null;
}

function sanitiseCamera(input: unknown): CameraMove | null {
  if (typeof input !== 'object' || input === null) return null;
  const v = input as Record<string, unknown>;
  const out: CameraMove = {};
  if (typeof v.zoom === 'number' && v.zoom >= 0.5 && v.zoom <= 3.0) {
    out.zoom = v.zoom;
  }
  if (typeof v.focus === 'object' && v.focus !== null) {
    const f = v.focus as Record<string, unknown>;
    if (
      typeof f.x === 'number' &&
      typeof f.y === 'number' &&
      f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1
    ) {
      out.focus = { x: f.x, y: f.y };
    }
  }
  // v0.6+ placeholders — pass through if shape is right, renderer ignores.
  if (typeof v.zoomFrom === 'number') out.zoomFrom = v.zoomFrom;
  if (typeof v.zoomTo === 'number') out.zoomTo = v.zoomTo;
  return Object.keys(out).length > 0 ? out : null;
}

function sanitiseBrandWatermark(input: unknown): BrandWatermark | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const v = input as Record<string, unknown>;
  if (typeof v.image !== 'string' || !v.image) return undefined;
  const pos = v.position;
  if (
    pos !== 'top-left' &&
    pos !== 'top-right' &&
    pos !== 'bottom-left' &&
    pos !== 'bottom-right'
  ) {
    return undefined;
  }
  const size = typeof v.size === 'number' && v.size > 0 && v.size < 1 ? v.size : 0.12;
  const opacity =
    typeof v.opacity === 'number' && v.opacity > 0 && v.opacity <= 1 ? v.opacity : 1;
  return { image: v.image, position: pos, size, opacity };
}

// ---------- Convenience: build prompt context from a Transcript ----------

/**
 * Turn a Transcript (+ optional segment-index filter for variants) into
 * the shape buildPackagingUserPrompt expects. Variants pass the indices
 * of segments inside the variant; whole-video packaging passes undefined
 * to use all segments.
 */
export function transcriptToPromptSegments(
  transcript: Transcript,
  segmentIndices?: readonly number[]
): Array<{ idx: number; start: number; end: number; text: string }> {
  const segs = segmentIndices
    ? segmentIndices
        .map((i) => transcript.segments[i])
        .filter((s): s is NonNullable<typeof s> => s != null)
        .map((s, i) => ({ ...s, _idx: segmentIndices[i] }))
    : transcript.segments.map((s, i) => ({ ...s, _idx: i }));
  return segs.map((s) => ({
    idx: s._idx,
    start: s.start,
    end: s.end,
    text: s.text,
  }));
}
