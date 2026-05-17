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
 *   - Caller passes `currentTimeSec` (read from the same <video> element
 *     it's overlaying — usually via an `onTimeUpdate` handler).
 *   - We find the transcript segment whose source-time range contains
 *     that time; that's the "current line".
 *   - Look up that segment's index in the plan's segments[] to get the
 *     subtitle style + wordEffects.
 *   - Render the tokens with default style; override the highlighted
 *     ones with their color/size.
 *
 * Variant playback (player jumps between non-contiguous source ranges)
 * is fine — `currentTimeSec` is still source time, the lookup still
 * works the same way.
 */
import { useMemo } from 'react';
import type {
  PackagingPlan,
  SubtitleStyle,
  Transcript,
  WordEffect,
} from '@lynlens/core';

interface Props {
  /** Project transcript (source-time segments). */
  transcript: Transcript;
  /** AI-generated styling plan. null → no decoration, plain default. */
  plan: PackagingPlan | null;
  /** Current playback position in SOURCE seconds. */
  currentTimeSec: number;
  /** Display orientation hint (affects default sizes). */
  orientation?: 'portrait' | 'landscape' | 'unknown';
}

const FALLBACK_STYLE: SubtitleStyle = {
  font: "'PingFang SC', 'Source Han Sans CN', 'Helvetica Neue', sans-serif",
  size: 36,
  color: '#ffffff',
  outline: { color: '#000000', width: 3 },
  position: 'bottom',
};

export function PackagingSubtitleOverlay({
  transcript,
  plan,
  currentTimeSec,
  orientation,
}: Props): JSX.Element | null {
  // Locate the active transcript segment for the current playhead.
  // Linear scan is fine — transcript segments are small (hundreds, not
  // millions) and this runs at most every onTimeUpdate fire (~4 Hz).
  const { activeSeg, activeIdx } = useMemo(() => {
    for (let i = 0; i < transcript.segments.length; i++) {
      const s = transcript.segments[i];
      if (currentTimeSec >= s.start && currentTimeSec < s.end) {
        return { activeSeg: s, activeIdx: i };
      }
    }
    return { activeSeg: null, activeIdx: -1 };
  }, [transcript.segments, currentTimeSec]);

  if (!activeSeg) return null;

  // Resolve the styling for THIS segment from the plan:
  //   default style (plan.defaults.subtitle) merged with per-segment
  //   recipe (plan.segments[i].subtitle) merged with FALLBACK_STYLE.
  const recipe = plan?.segments.find((s) => s.segmentIdx === activeIdx);
  const merged: SubtitleStyle & { wordEffects?: WordEffect[] } = {
    ...FALLBACK_STYLE,
    ...(plan?.defaults.subtitle ?? {}),
    ...(recipe?.subtitle ?? {}),
  };
  const wordEffects: WordEffect[] = recipe?.subtitle?.wordEffects ?? [];

  const font = merged.font ?? FALLBACK_STYLE.font!;
  const size = merged.size ?? FALLBACK_STYLE.size!;
  const color = merged.color ?? FALLBACK_STYLE.color!;
  const outline = merged.outline ?? FALLBACK_STYLE.outline!;
  const bgColor = merged.bgColor;
  const position = merged.position ?? 'bottom';

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
  // smaller. Bump 1.2x for portrait.
  const orientedSize =
    merged.size === undefined && orientation === 'portrait'
      ? Math.round(size * 1.2)
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
        style={{
          maxWidth: '92%',
          padding: '6px 18px',
          background: bgColor ?? 'transparent',
          borderRadius: bgColor ? 6 : 0,
          textAlign: 'center',
          lineHeight: 1.2,
        }}
      >
        {tokens.map((tok, i) => {
          const eff = effectByIdx.get(i);
          const tokColor = eff?.highlight ?? color;
          const tokSize = eff?.size ?? orientedSize;
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
