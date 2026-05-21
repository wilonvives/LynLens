import React from 'react';
import {theme} from '../theme';

// 统一的「黄字」处理：每个字 左 80% 黄 → 右 20% 白 的渐变填充，无描边。
// strongWord 的重点词、sentence 的上/下行都用它，保持统一。
export const HOT_YELLOW = '#FFF2C0';
export const YELLOW_TO_WHITE = `linear-gradient(90deg, ${HOT_YELLOW} 0%, ${HOT_YELLOW} 80%, #ffffff 100%)`;

const GradientChar: React.FC<{ch: string}> = ({ch}) => (
  <span
    style={{
      display: 'inline-block',
      backgroundImage: YELLOW_TO_WHITE,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
      WebkitTextFillColor: 'transparent',
    }}
  >
    {ch}
  </span>
);

interface GradientFillTextProps {
  text: string;
  fontSize: number;
  shadow: string;
  fontWeight?: number;
}

// 分两层：背层（整词）只画阴影；前层逐字渐变不透明填充盖在内部，避免「透明填充 + 阴影」发黑。
export const GradientFillText: React.FC<GradientFillTextProps> = ({
  text,
  fontSize,
  shadow,
  fontWeight = 900,
}) => (
  <span
    style={{
      position: 'relative',
      display: 'inline-block',
      fontFamily: theme.fontFamily,
      fontSize,
      fontWeight,
    }}
  >
    <span style={{color: 'transparent', WebkitTextFillColor: 'transparent', textShadow: shadow}}>
      {text}
    </span>
    <span aria-hidden style={{position: 'absolute', left: 0, top: 0, whiteSpace: 'nowrap'}}>
      {Array.from(text).map((ch, i) => (
        <GradientChar key={i} ch={ch} />
      ))}
    </span>
  </span>
);
