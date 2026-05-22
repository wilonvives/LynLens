import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import type {SimpleSubtitleStyle, SubtitleStyleProps} from './types';

// 样式 · 通用(simple):干净字幕,可标重点。
//   · 普通字:思源宋体 Regular、白字(可调)、黑描边(可调色/粗细)
//   · 重点词:思源宋体 Heavy、黄字、黑描边
// 无渐变 / 无 Hero / 无镜头音效 —— 就是"上字幕 + 画重点"。
// 外观(位置/字号/颜色/描边)由 spec.subtitleStyle 控制(props.style)。
const MAX_WIDTH = '86%';

const DEFAULT_STYLE: SimpleSubtitleStyle = {
  positionFromBottom: 0.35,
  size: theme.sizes.normal,
  color: '#ffffff',
  outlineColor: '#000000',
  outlineWidth: 4,
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Seg = {hot: boolean; text: string};

const segmentize = (text: string, words: string[]): Seg[] => {
  const valid = words.filter((w) => w && text.includes(w));
  if (valid.length === 0) return [{hot: false, text}];
  const re = new RegExp(`(${valid.map(escapeRegExp).join('|')})`, 'g');
  return text
    .split(re)
    .filter((s) => s.length > 0)
    .map((s) => ({hot: valid.includes(s), text: s}));
};

/** Text style for one span — reuses the family + shadow but lets the
 *  author override color / weight / outline color + width. */
const spanStyle = (
  st: SimpleSubtitleStyle,
  hot: boolean
): React.CSSProperties => ({
  fontFamily: theme.fontFamily,
  fontSize: st.size,
  fontWeight: hot ? 900 : 400,
  color: hot ? theme.colors.highlight : st.color,
  lineHeight: 1.3,
  WebkitTextStroke: `${st.outlineWidth}px ${st.outlineColor}`,
  paintOrder: 'stroke',
  textShadow: theme.dropShadow,
});

export const SimpleSubtitle: React.FC<SubtitleStyleProps> = ({
  text,
  highlight = [],
  style,
}) => {
  const st = style ?? DEFAULT_STYLE;
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [0, 6], [16, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          marginLeft: 'auto',
          marginRight: 'auto',
          bottom: `${st.positionFromBottom * 100}%`,
          maxWidth: MAX_WIDTH,
          textAlign: 'center',
          opacity,
          transform: `translateY(${rise}px)`,
        }}
      >
        {segmentize(text.trim(), highlight).map((seg, i) => (
          <span key={i} style={spanStyle(st, seg.hot)}>
            {seg.text}
          </span>
        ))}
      </div>
    </AbsoluteFill>
  );
};
