/**
 * PackagingPlan → ASS subtitle file (Advanced SubStation Alpha).
 *
 * Why ASS: ffmpeg ships a `subtitles=...` filter that consumes ASS and
 * burns it into the video frames during encode. ASS natively supports
 * per-word color / size / outline overrides via inline {\c}{\fs}{\bord}
 * tags, which is exactly what PackagingPlan's wordEffects needs.
 * Plain SRT can't do per-word styling within one cue.
 *
 * Time axis: the ASS produced here is calibrated for the EXPORT's video
 * timeline. When the export uses trim+concat to assemble a variant from
 * source ranges, the dialogue events use VARIANT time (0..variantDur).
 * For 整片 with no variant, dialogue events use source time (1:1).
 *
 * The transcript still drives WHEN each line shows up; the PackagingPlan
 * drives HOW each line looks (default style + per-line overrides + per-
 * word highlight effects).
 */
import type {
  PackagingPlan,
  SubtitleStyle,
  WordEffect,
} from './packaging-plan';
import type { Transcript } from './types';

/**
 * One playlist entry: maps a slice of source-time to its position on the
 * export video's timeline. For variant export this is one entry per
 * variant segment; for 整片 export with no cuts it's a single 1:1 entry
 * spanning the whole video.
 */
export interface AssPlaylistEntry {
  srcStart: number;
  srcEnd: number;
  /** Time in the OUTPUT video where this slice lives. */
  outStart: number;
  outEnd: number;
}

export interface AssGeneratorOptions {
  transcript: Transcript;
  plan: PackagingPlan | null;
  playlist: AssPlaylistEntry[];
  /** Source video resolution — defines PlayResX/Y so font sizes match. */
  videoWidth: number;
  videoHeight: number;
}

/**
 * Fallback style — must match PackagingSubtitleOverlay's FALLBACK_STYLE
 * so preview and export look the same when AI omitted styling.
 */
const FALLBACK: Required<Pick<SubtitleStyle, 'font' | 'size' | 'color'>> & {
  outline: { color: string; width: number };
  position: 'bottom' | 'center' | 'top';
} = {
  font: 'PingFang SC',
  size: 56,
  color: '#ffffff',
  outline: { color: '#000000', width: 3 },
  position: 'bottom',
};

/**
 * Defensive font-size cap (mirrors packaging-plan.ts parser). Plans
 * persisted before the parser cap landed still have wild values; clamp
 * at generation time so libass never burns in screen-filling characters.
 */
function clampSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 56;
  return Math.min(120, Math.max(16, v));
}

/**
 * Convert "#RRGGBB" to ASS's "&H00BBGGRR" format. ASS color is little-
 * endian 8-char hex: AABBGGRR with AA=00 (opaque). Returns the fallback
 * white if the input isn't a valid 6-char hex.
 */
export function hexToAssColor(hex: string | undefined, fallback = '#ffffff'): string {
  const src = (hex ?? fallback).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(src)) {
    return hexToAssColor(fallback);
  }
  const rr = src.slice(0, 2).toUpperCase();
  const gg = src.slice(2, 4).toUpperCase();
  const bb = src.slice(4, 6).toUpperCase();
  return `&H00${bb}${gg}${rr}`;
}

/**
 * Convert seconds to ASS's "H:MM:SS.CC" format (centiseconds, NOT
 * milliseconds — common gotcha when porting from SRT).
 */
export function secondsToAssTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // Round to centisecond resolution first to avoid floating-point
  // truncation that drops trailing digits (e.g. 65.27 → 65.2699...).
  // Then split into h/m/s parts on the rounded value so carry works
  // correctly across second/minute/hour boundaries.
  let totalCs = Math.round(s * 100);
  const h = Math.floor(totalCs / 360000);
  totalCs -= h * 360000;
  const m = Math.floor(totalCs / 6000);
  totalCs -= m * 6000;
  const secInt = Math.floor(totalCs / 100);
  const cs = totalCs - secInt * 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(secInt).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/**
 * Clip a source-time range against the playlist, returning the slices
 * (in output-time) that overlap with the playlist's source ranges.
 * Most transcript segments fall entirely inside ONE playlist entry, so
 * the typical result is a single slice. If a transcript segment straddles
 * a gap between variant segments, we yield multiple slices (rare).
 */
function clipRangeToPlaylist(
  srcStart: number,
  srcEnd: number,
  playlist: AssPlaylistEntry[]
): Array<{ outStart: number; outEnd: number }> {
  const out: Array<{ outStart: number; outEnd: number }> = [];
  for (const e of playlist) {
    const s = Math.max(srcStart, e.srcStart);
    const x = Math.min(srcEnd, e.srcEnd);
    if (x > s) {
      out.push({
        outStart: e.outStart + (s - e.srcStart),
        outEnd: e.outStart + (x - e.srcStart),
      });
    }
  }
  return out;
}

/** ASS alignment numpad codes: 2=bottom-center, 5=center, 8=top-center. */
function alignFor(position: 'bottom' | 'center' | 'top' | undefined): number {
  if (position === 'top') return 8;
  if (position === 'center') return 5;
  return 2;
}

/**
 * Render one transcript line's text with inline overrides for per-word
 * highlights. The base style is applied via the dialogue's Style field;
 * here we only emit DELTAS for highlighted tokens.
 *
 * Token split = whitespace, matching PackagingSubtitleOverlay. CJK text
 * without spaces becomes one token (wordIdx=0).
 */
export function renderAssText(
  text: string,
  wordEffects: WordEffect[],
  baseSize: number,
  baseColor: string
): string {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  const effByIdx = new Map<number, WordEffect>();
  for (const w of wordEffects) effByIdx.set(w.wordIdx, w);

  const cappedBase = clampSize(baseSize);
  const parts: string[] = [];
  tokens.forEach((tok, i) => {
    const eff = effByIdx.get(i);
    const overrideColor = eff?.highlight;
    const overrideSize = eff?.size ? clampSize(eff.size) : undefined;
    const escaped = escapeAssText(tok);
    if (overrideColor || overrideSize) {
      const tags: string[] = [];
      if (overrideColor) tags.push(`\\c${hexToAssColor(overrideColor, baseColor)}`);
      if (overrideSize) tags.push(`\\fs${Math.round(overrideSize)}`);
      // After the override, reset back to the dialogue's base style so the
      // next token isn't accidentally styled.
      parts.push(`{${tags.join('')}}${escaped}{\\fs${Math.round(cappedBase)}\\c${hexToAssColor(baseColor)}}`);
    } else {
      parts.push(escaped);
    }
    if (i < tokens.length - 1) parts.push(' ');
  });
  return parts.join('');
}

/**
 * ASS escaping: backslash, opening brace, and newlines have special
 * meaning. Replace newline with the ASS hard-break sequence \N.
 */
function escapeAssText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

// styleOverrideBlock removed: segment-level whole-line overrides are no
// longer honored at generation time (only wordEffects survive). If a
// future feature needs them back, restore from git history (commit
// before this comment) and re-thread into generatePackagingAss.

/**
 * Generate the complete ASS file content for a packaged variant.
 *
 * Returns a UTF-8 string the caller can write to disk and pass to ffmpeg's
 * `subtitles=` filter. The Default style derives from plan.defaults.subtitle
 * (falling back to FALLBACK); per-segment recipes are applied as inline
 * overrides at the dialogue level.
 */
export function generatePackagingAss(opts: AssGeneratorOptions): string {
  const { transcript, plan, playlist, videoWidth, videoHeight } = opts;

  const defaults = {
    font: plan?.defaults.subtitle?.font ?? FALLBACK.font,
    // Defensive clamp — see clampSize comment. Old persisted plans may
    // carry pre-cap sizes that would burn in screen-filling chars.
    size: clampSize(plan?.defaults.subtitle?.size ?? FALLBACK.size),
    color: plan?.defaults.subtitle?.color ?? FALLBACK.color,
    outline: plan?.defaults.subtitle?.outline ?? FALLBACK.outline,
    position: plan?.defaults.subtitle?.position ?? FALLBACK.position,
  };

  const primaryColour = hexToAssColor(defaults.color);
  const outlineColour = hexToAssColor(defaults.outline.color);
  const bord = defaults.outline.width.toFixed(1);

  // Vertical margin from the alignment edge: ~8% of video height matches
  // PackagingSubtitleOverlay's padding-bottom: 12% / padding-top: 8% spec.
  const marginV = Math.round(videoHeight * 0.08);

  const header = [
    '[Script Info]',
    'Title: LynLens packaging burn-in',
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    `PlayResX: ${videoWidth}`,
    `PlayResY: ${videoHeight}`,
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${defaults.font},${Math.round(defaults.size)},${primaryColour},&H000000FF,${outlineColour},&H00000000,1,0,0,0,100,100,0,0,1,${bord},0,${alignFor(defaults.position)},40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];

  transcript.segments.forEach((seg, idx) => {
    const slices = clipRangeToPlaylist(seg.start, seg.end, playlist);
    if (slices.length === 0) return;

    // Only wordEffects from the recipe are honored; whole-line overrides
    // (color/position/size/font/outline) are intentionally ignored at
    // generation time so the burned-in export stays visually consistent
    // across segments even if Claude or an old .qcp plan included them.
    // See PackagingSubtitleOverlay for the matching render-side filter.
    const recipe = plan?.segments.find((s) => s.segmentIdx === idx);
    const wordEffects: WordEffect[] = recipe?.subtitle?.wordEffects ?? [];

    const effectiveSize = defaults.size;
    const effectiveColor = defaults.color;

    const body = renderAssText(seg.text, wordEffects, effectiveSize, effectiveColor);
    if (!body) return;

    for (const sl of slices) {
      const start = secondsToAssTime(sl.outStart);
      const end = secondsToAssTime(sl.outEnd);
      events.push(
        `Dialogue: 0,${start},${end},Default,,0,0,0,,${body}`
      );
    }
  });

  return [...header, ...events, ''].join('\n');
}
