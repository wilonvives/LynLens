import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {theme} from '../theme';
import {GradientFillText} from './gradientText';
import {useReveal} from './reveal';
import type {SubtitleStyleProps} from './types';

// 样式 · 十字交叉重点句（cross）：适合 2 节拆分——一节竖排、一节横排。
// 读序 中 → 横：第 1 节竖排居中(先出现)，第 2 节横排(后出现)，从中间断开成左右两半夹住竖字。
//   竖：150px 白色 · 无描边 · 高 blur 阴影 · 大→缩定弹现 · vertical 书写
//   横：130px 黄→白渐变(同前) · 无描边 · 高 blur 阴影 · 直接隐现
// 最后整体隐出。注意：竖排只适合中文，英文罗马字不竖排（由 spec 内容把控）。
// 以竖字底部为基准锚定（不论竖字几个字，底边都对齐这条线）。比重点句更低。
const VERT_BOTTOM_FROM_BOTTOM = 0.15;
const VERT_SIZE = 150;
const HORIZ_SIZE = 130;
const HERO_SHADOW = '0 6px 28px rgba(0,0,0,0.85)';
const WHITE = theme.colors.normal;
const VERTICAL_DELAY = 0;
const HORIZONTAL_DELAY = 6;
const EXIT_FRAMES = 8;
const OVERLAP = 36; // 横排两半向中间收拢、被竖字覆盖的量（px）

const VerticalWord: React.FC<{text: string}> = ({text}) => {
  const {opacity, scale} = useReveal(VERTICAL_DELAY, true);
  return (
    <span
      style={{
        display: 'inline-block',
        opacity,
        transform: `scale(${scale})`,
        writingMode: 'vertical-rl',
        textOrientation: 'upright',
        fontFamily: theme.fontFamily,
        fontWeight: 900,
        fontSize: VERT_SIZE,
        color: WHITE,
        lineHeight: 1.0,
        textShadow: HERO_SHADOW,
      }}
    >
      {text}
    </span>
  );
};

const HorizontalHalf: React.FC<{text: string}> = ({text}) => {
  const {opacity} = useReveal(HORIZONTAL_DELAY, false);
  return (
    <span style={{display: 'inline-block', opacity, whiteSpace: 'nowrap'}}>
      <GradientFillText text={text} fontSize={HORIZ_SIZE} shadow={HERO_SHADOW} />
    </span>
  );
};

export const CrossSentenceSubtitle: React.FC<SubtitleStyleProps> = ({
  segments = [],
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const [vertical, horizontal] = segments; // 第1节竖排、第2节横排
  const h = horizontal ?? '';
  const mid = Math.round(h.length / 2);
  const leftHalf = h.slice(0, mid);
  const rightHalf = h.slice(mid);

  const exitOpacity =
    durationInFrames !== undefined
      ? interpolate(
          frame,
          [durationInFrames - EXIT_FRAMES, durationInFrames - 1],
          [1, 0],
          {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'},
        )
      : 1;

  return (
    <AbsoluteFill style={{opacity: exitOpacity}}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: `${VERT_BOTTOM_FROM_BOTTOM * 100}%`, // 竖字底边对齐此线（不再居中）
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        {/* 左右等宽弹性槽，保证中间竖字始终居中；横字向中间对齐去配合竖字。 */}
        <div style={{flex: '1 1 0', textAlign: 'right', zIndex: 1}}>
          {leftHalf.length > 0 && <HorizontalHalf text={leftHalf} />}
        </div>
        {vertical !== undefined && (
          <div style={{flexShrink: 0, position: 'relative', zIndex: 3, margin: `0 ${-OVERLAP}px`}}>
            <VerticalWord text={vertical} />
          </div>
        )}
        <div style={{flex: '1 1 0', textAlign: 'left', zIndex: 1}}>
          {rightHalf.length > 0 && <HorizontalHalf text={rightHalf} />}
        </div>
      </div>
    </AbsoluteFill>
  );
};
