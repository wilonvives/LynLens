/**
 * HTML/CSS subtitle overlay for the 包装 tab.
 *
 * Goal (kept deliberately small per user request "先从小的字幕效果花字做"):
 * just render the current subtitle on top of a normal `<video>` element,
 * using the PackagingPlan's per-segment styling + per-word highlights
 * (the "花字" effect — keyword in a different colour / size).
 *
 * No Remotion. No camera zoom. No transitions. Just text overlay.
 *
 * How it picks the current subtitle:
 *   - Caller passes `currentTimeSec` — the playhead position in the
 *     CURRENTLY-LOADED video file's timeline.
 *   - When `playlist` is provided (variant preview), this is preview/
 *     variant time. We map it back to source time via the playlist so
 *     transcript lookup (which is in source time) works.
 *   - When `playlist` is missing or empty, currentTimeSec is treated as
 *     source time directly (整片 fallback).
 *   - Find the transcript segment whose source-time range contains the
 *     mapped time; that's the "current line".
 *   - Look up that segment's index in the plan's segments[] to get the
 *     subtitle style + wordEffects.
 *   - Render the tokens with default style; override the highlighted
 *     ones with their color/size.
 */
import { useMemo } from 'react';
import type {
  PackagingPlan,
  PreviewPlaylistEntry,
  SubtitleStyle,
  Transcript,
  WordEffect,
} from '@lynlens/core';

interface Props {
  /** Project transcript (source-time segments). */
  transcript: Transcript;
  /** AI-generated styling plan. null → no decoration, plain default. */
  plan: PackagingPlan | null;
  /**
   * Current playback position. In VARIANT seconds when `playlist` is set
   * (preview mp4 playback); in SOURCE seconds when `playlist` is empty
   * (整片). The component reduces this to source time internally via the
   * playlist before looking up the transcript segment.
   */
  currentTimeSec: number;
  /**
   * Optional source↔variant time mapping. One entry per variant segment
   * (or a single 1:1 entry for 整片). When empty/undefined, currentTimeSec
   * is treated as source time directly.
   */
  playlist?: PreviewPlaylistEntry[];
  /** Display orientation hint (affects default sizes). */
  orientation?: 'portrait' | 'landscape' | 'unknown';
  /**
   * Source video height in px (typically videoMeta.height). AI returns
   * font-sizes scaled to this — e.g. size:56 on a 1080-high video means
   * roughly "5% of video height". We rescale to the rendered display
   * size so subtitles aren't huge when the video plays small.
   */
  sourceHeight: number;
  /**
   * Currently-rendered video height in px (from a ResizeObserver on the
   * video-aspect wrap). Used to scale font sizes proportionally.
   */
  displayHeight: number;
  /**
   * Click handler — fires with the active transcript segment's index
   * when the user clicks the visible subtitle text. Used by the 包装
   * tab to jump to that segment's card in the 字幕 editor. Click events
   * elsewhere on the overlay (transparent regions) pass through to the
   * video underneath, preserving play/pause-on-click.
   */
  onSubtitleClick?: (segmentIdx: number) => void;
}

const FALLBACK_STYLE: SubtitleStyle = {
  font: "'PingFang SC', 'Source Han Sans CN', 'Helvetica Neue', sans-serif",
  size: 36,
  color: '#ffffff',
  outline: { color: '#000000', width: 3 },
  position: 'bottom',
};

/**
 * Defensive font-size cap (matches packaging-plan.ts parser). Old plans
 * stored in .qcp before the parser cap landed still have wild sizes; we
 * clamp at render time so preview can't blow up regardless of where the
 * plan came from.
 */
function clampSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 56;
  return Math.min(120, Math.max(16, v));
}

export function PackagingSubtitleOverlay({
  transcript,
  plan,
  currentTimeSec,
  playlist,
  orientation,
  sourceHeight,
  displayHeight,
  onSubtitleClick,
}: Props): JSX.Element | null {
  // Map variant time → source time using the playlist. If currentTimeSec
  // falls between variant entries (mid-seek / outside any entry), the
  // lookup returns null and we render no subtitle (correct — there's no
  // source position to look up). With no playlist, treat the input as
  // source time directly.
  const sourceTimeSec = useMemo<number | null>(() => {
    if (!playlist || playlist.length === 0) return currentTimeSec;
    for (const e of playlist) {
      if (currentTimeSec >= e.variantStart && currentTimeSec < e.variantEnd) {
        return e.srcStart + (currentTimeSec - e.variantStart);
      }
    }
    // Past the end: clamp to the last entry's srcEnd so the final
    // subtitle keeps showing until the video ends.
    const last = playlist[playlist.length - 1];
    if (currentTimeSec >= last.variantEnd) return last.srcEnd - 0.001;
    return null;
  }, [playlist, currentTimeSec]);

  // Locate the active transcript segment for the current playhead.
  // Linear scan is fine — transcript segments are small (hundreds, not
  // millions) and this runs at most every onTimeUpdate fire (~4 Hz).
  const { activeSeg, activeIdx } = useMemo(() => {
    if (sourceTimeSec === null) return { activeSeg: null, activeIdx: -1 };
    for (let i = 0; i < transcript.segments.length; i++) {
      const s = transcript.segments[i];
      if (sourceTimeSec >= s.start && sourceTimeSec < s.end) {
        return { activeSeg: s, activeIdx: i };
      }
    }
    return { activeSeg: null, activeIdx: -1 };
  }, [transcript.segments, sourceTimeSec]);

  if (!activeSeg) return null;

  // Resolve the styling for THIS segment:
  //   whole-line styling = FALLBACK ← plan.defaults.subtitle
  //   per-keyword highlights = recipe.subtitle.wordEffects (only)
  //
  // We deliberately DO NOT merge recipe.subtitle's color/position/size/
  // font/outline/bgColor — those whole-line overrides made adjacent
  // segments render in different colors / positions (user reported
  // "preview 乱飞"). The parser now drops them on new generations, but
  // plans persisted to .qcp before that change still carry them; this
  // render-time filter makes loading an old plan look clean too.
  // Wholesale per-segment styling, if ever needed, should land as a
  // proper feature with its own UI affordance, not a free-for-all on
  // AI's whims.
  const recipe = plan?.segments.find((s) => s.segmentIdx === activeIdx);
  const merged: SubtitleStyle = {
    ...FALLBACK_STYLE,
    ...(plan?.defaults.subtitle ?? {}),
  };
  const wordEffects: WordEffect[] = recipe?.subtitle?.wordEffects ?? [];

  const font = merged.font ?? FALLBACK_STYLE.font!;
  // Render-time defensive cap. The parser also clamps but plans saved
  // before the cap landed (or hand-edited .qcp files) can still carry
  // wild sizes; cap here so the preview never explodes.
  const baseSize = clampSize(merged.size ?? FALLBACK_STYLE.size!);
  const color = merged.color ?? FALLBACK_STYLE.color!;
  const baseOutline = merged.outline ?? FALLBACK_STYLE.outline!;
  const bgColor = merged.bgColor;
  const position = merged.position ?? 'bottom';

  // Scale source-resolution px sizes to the actual displayed video size.
  // AI returns sizes calibrated for the source (e.g. 56px on a 1080-tall
  // video). When the video plays at 400px tall in a small player, 56px
  // text would be HUGE relative to the frame. Multiply by the ratio.
  const scale =
    sourceHeight > 0 && displayHeight > 0 ? displayHeight / sourceHeight : 1;
  const size = Math.max(8, Math.round(baseSize * scale));
  const outline = {
    color: baseOutline.color,
    width: Math.max(0.5, baseOutline.width * scale),
  };

  // Tokenise to map wordEffects.wordIdx to spans. Whitespace split is
  // simple; CJK without spaces becomes one token (wordIdx=0). Per v0.6
  // we can add char-level tokenisation if AI needs more granularity.
  const tokens = activeSeg.text.split(/\s+/).filter((t) => t.length > 0);
  const effectByIdx = new Map<number, WordEffect>();
  wordEffects.forEach((w) => effectByIdx.set(w.wordIdx, w));

  // 8-direction text-shadow approximates a stroke — works around CJK
  // glyph clipping issues in -webkit-text-stroke.
  const textShadow = outline.width > 0
    ? Array.from({ length: 8 })
        .map((_, i) => {
          const angle = (i * Math.PI) / 4;
          const dx = Math.cos(angle) * outline.width;
          const dy = Math.sin(angle) * outline.width;
          return `${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 ${outline.color}`;
        })
        .join(', ')
    : 'none';

  const verticalStyle: React.CSSProperties =
    position === 'top'
      ? { justifyContent: 'flex-start', paddingTop: '8%' }
      : position === 'center'
        ? { justifyContent: 'center' }
        : { justifyContent: 'flex-end', paddingBottom: '12%' };

  // Adjust default size by orientation if the AI didn't pick one.
  // Portrait videos play in a tall narrow box; same px size feels
  // smaller. Bump 1.15x for portrait. (Subtle — most of the resizing
  // is already handled by the source→display scale above.)
  const orientedSize =
    merged.size === undefined && orientation === 'portrait'
      ? Math.round(size * 1.15)
      : size;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
        ...verticalStyle,
      }}
    >
      <div
        onClick={(e) => {
          if (!onSubtitleClick) return;
          // Stop propagation so the click doesn't ALSO toggle video
          // play/pause (the video element has its own onClick).
          e.stopPropagation();
          onSubtitleClick(activeIdx);
        }}
        style={{
          maxWidth: '92%',
          padding: '6px 18px',
          background: bgColor ?? 'transparent',
          borderRadius: bgColor ? 6 : 0,
          textAlign: 'center',
          lineHeight: 1.2,
          // Re-enable pointer events on the TEXT area only (outer overlay
          // still passes clicks through to the video for play/pause).
          pointerEvents: onSubtitleClick ? 'auto' : 'none',
          cursor: onSubtitleClick ? 'pointer' : 'default',
        }}
        title={onSubtitleClick ? '点字幕 → 右侧字幕 tab 编辑这段' : undefined}
      >
        {tokens.map((tok, i) => {
          const eff = effectByIdx.get(i);
          const tokColor = eff?.highlight ?? color;
          // Scale per-word effect sizes the same way as the base size.
          const tokSize = eff?.size
            ? Math.max(8, Math.round(clampSize(eff.size) * scale))
            : orientedSize;
          return (
            <span
              key={i}
              style={{
                fontFamily: font,
                fontSize: tokSize,
                color: tokColor,
                textShadow,
                marginRight: i < tokens.length - 1 ? '0.25em' : 0,
                fontWeight: 900,
                display: 'inline-block',
                verticalAlign: 'baseline',
              }}
            >
              {tok}
            </span>
          );
        })}
      </div>
    </div>
  );
}
