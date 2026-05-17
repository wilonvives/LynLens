/**
 * Styled subtitle overlay, with optional word-level effects (color + size
 * override for punchline keywords).
 *
 * Tokenisation: split on whitespace, then for each token, check whether
 * its wordIdx has a wordEffect. CJK note: pure-CJK text has no spaces,
 * so the entire string becomes wordIdx=0. Authors that want word-level
 * effects on CJK should either:
 *   (a) write space-separated text in the transcript, or
 *   (b) wait for v0.6+ when we add character-level wordEffects.
 *
 * Rendered at the variant's effective position. v0.5 doesn't animate;
 * subtitle is on-screen for the full duration of its parent <Sequence>.
 */
import { AbsoluteFill } from 'remotion';
import type { SubtitleStyle, WordEffect } from '@lynlens/core';

interface SubtitleProps {
  text: string;
  style: SubtitleStyle;
  wordEffects?: WordEffect[];
}

export function Subtitle({ text, style, wordEffects }: SubtitleProps): JSX.Element {
  const font = style.font ?? 'PingFang SC Heavy, Source Han Sans CN, sans-serif';
  const size = style.size ?? 56;
  const color = style.color ?? '#ffffff';
  const outline = style.outline ?? { color: '#000000', width: 3 };
  const bgColor = style.bgColor;
  const position = style.position ?? 'bottom';

  // Tokenise to render each word with its own span so wordEffects can
  // override per-token. Use simple whitespace split; intentional space
  // between tokens is preserved with margin-right via inline-block.
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const effectByIdx = new Map<number, WordEffect>();
  (wordEffects ?? []).forEach((w) => effectByIdx.set(w.wordIdx, w));

  const verticalStyle: React.CSSProperties =
    position === 'top'
      ? { justifyContent: 'flex-start', paddingTop: '8%' }
      : position === 'center'
        ? { justifyContent: 'center' }
        : { justifyContent: 'flex-end', paddingBottom: '12%' };

  // CSS text-shadow approximates outline via 4-corner offset shadows.
  // Cleaner than -webkit-text-stroke (inconsistent across Chromium versions).
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

  return (
    <AbsoluteFill style={{ display: 'flex', alignItems: 'center', ...verticalStyle }}>
      <div
        style={{
          maxWidth: '90%',
          padding: '8px 24px',
          background: bgColor ?? 'transparent',
          borderRadius: bgColor ? 8 : 0,
          textAlign: 'center',
          lineHeight: 1.2,
        }}
      >
        {tokens.map((tok, i) => {
          const eff = effectByIdx.get(i);
          const tokColor = eff?.highlight ?? color;
          const tokSize = eff?.size ?? size;
          return (
            <span
              key={i}
              style={{
                fontFamily: font,
                fontSize: tokSize,
                color: tokColor,
                textShadow,
                marginRight: i < tokens.length - 1 ? '0.25em' : 0,
                fontWeight: 700,
                display: 'inline-block',
                verticalAlign: 'baseline',
              }}
            >
              {tok}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}
