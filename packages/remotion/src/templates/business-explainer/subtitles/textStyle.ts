import type {CSSProperties} from 'react';
import {theme} from '../theme';

interface TextStyleOptions {
  fontSize?: number;
  color?: string;
  fontWeight?: number;
  glow?: boolean;
}

// 字幕文字的基础外观（白字 + 细黑描边 + 投影），所有样式共用，保证视觉统一。
export const subtitleTextStyle = (opts: TextStyleOptions = {}): CSSProperties => ({
  fontFamily: theme.fontFamily,
  fontSize: opts.fontSize ?? theme.sizes.normal,
  fontWeight: opts.fontWeight ?? 400,
  color: opts.color ?? theme.colors.normal,
  lineHeight: 1.3,
  WebkitTextStroke: `${theme.stroke.width}px ${theme.stroke.color}`,
  paintOrder: 'stroke',
  textShadow: opts.glow ? theme.glowShadow : theme.dropShadow,
});
