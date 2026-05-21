import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {theme} from '../theme';
import {subtitleTextStyle} from './textStyle';

interface SubtitleBoxProps {
  children: React.ReactNode;
  color?: string;
  fontSize?: number;
  fontWeight?: number;
  scale?: number;
  glow?: boolean;
  // 竖直中心位置（距底部的高度比例）。默认用主题里的普通字位置。
  centerFromBottom?: number;
}

// 字幕的统一容器：竖直中心锁在「距底部 X 高」、白字 + 细黑描边 + 投影、无 box、进场淡入上移。
// 单行字幕都基于它；多行/阶梯等特殊布局的样式可自行实现，但共用 subtitleTextStyle 保持外观一致。
export const SubtitleBox: React.FC<SubtitleBoxProps> = ({
  children,
  color,
  fontSize,
  fontWeight,
  scale = 1,
  glow = false,
  centerFromBottom = theme.layout.verticalCenterFromBottom,
}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  const appear = spring({frame, fps, durationInFrames: 9, config: {damping: 200}});
  const opacity = interpolate(appear, [0, 1], [0, 1]);
  const riseY = interpolate(appear, [0, 1], [26, 0]);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          marginLeft: 'auto',
          marginRight: 'auto',
          bottom: `${centerFromBottom * 100}%`,
          transform: `translateY(calc(50% + ${riseY}px)) scale(${scale})`,
          opacity,
          maxWidth: theme.layout.maxWidth,
          textAlign: 'center',
          ...subtitleTextStyle({fontSize, color, fontWeight, glow}),
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
