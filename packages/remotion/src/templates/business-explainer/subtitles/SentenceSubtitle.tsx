import React from 'react';
import {AbsoluteFill, interpolate, useCurrentFrame} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {theme} from '../theme';
import {GradientFillText} from './gradientText';
import {useReveal} from './reveal';
import type {SubtitleStyleProps} from './types';

// 样式 · 重点句（sentence）：把一句话拆成三节，排成 Hero 三行。
// 读序 中 → 上 → 下：第 1 节放中间(先出现)，第 2 节放上面，第 3 节放下面。
//   中：150px 白色 · 无描边 · 高 blur 阴影 · 居中 · 大→缩定 弹现
//   上：130px 黄→白渐变(同 strongWord) · 无描边 · 高 blur 阴影 · 直接隐现
//   下：130px 黄→白渐变 · 无描边 · 高 blur 阴影 · 直接隐现
// 三行整体居中；以中间行为锚，上行向左、下行向右偏移，偏移量 = 中间行宽度 × OFFSET_RATIO，
// 因此上下行自然跟随中间行长短。最后整体隐出。
const CENTER_FROM_BOTTOM = 0.35;
const MIDDLE_SIZE = 150;
const SIDE_SIZE = 130;
const OFFSET_RATIO = 0.4; // 上下行横移量占中间行宽度的比例
const LINE_OVERLAP = 32; // 三行竖向收拢/重叠量（px），中间行压在上下行之上
const HERO_SHADOW = '0 6px 28px rgba(0,0,0,0.85)';
const WHITE = theme.colors.normal;

// 出现节奏（帧）：中先 → 上 → 下。
const MIDDLE_DELAY = 0;
const TOP_DELAY = 6;
const BOTTOM_DELAY = 12;
const EXIT_FRAMES = 8;

// 中行：白色无描边，大→缩定弹现。
const MiddleLine: React.FC<{text: string}> = ({text}) => {
  const {opacity, scale} = useReveal(MIDDLE_DELAY, true);
  return (
    <span
      style={{
        display: 'inline-block',
        opacity,
        transform: `scale(${scale})`,
        fontFamily: theme.fontFamily,
        fontWeight: 900,
        fontSize: MIDDLE_SIZE,
        color: WHITE,
        lineHeight: 1.08,
        whiteSpace: 'nowrap',
        textShadow: HERO_SHADOW,
      }}
    >
      {text}
    </span>
  );
};

// 上 / 下行：统一黄→白渐变，直接淡入；以中间行为基准横移。
const SideLine: React.FC<{text: string; delay: number; offsetX: number}> = ({
  text,
  delay,
  offsetX,
}) => {
  const {opacity} = useReveal(delay, false);
  return (
    <span style={{display: 'inline-block', opacity, transform: `translateX(${offsetX}px)`}}>
      <GradientFillText text={text} fontSize={SIDE_SIZE} shadow={HERO_SHADOW} />
    </span>
  );
};

export const SentenceSubtitle: React.FC<SubtitleStyleProps> = ({
  segments = [],
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const [middle, top, bottom] = segments; // 读序：第1节中、第2节上、第3节下

  // 以中间行宽度为基准，算出上下行的横移量。
  const midWidth = middle
    ? measureText({
        text: middle,
        fontFamily: theme.fontFamily,
        fontSize: MIDDLE_SIZE,
        fontWeight: 900,
      }).width
    : 0;
  const offset = OFFSET_RATIO * midWidth;

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
          marginLeft: 'auto',
          marginRight: 'auto',
          bottom: `${CENTER_FROM_BOTTOM * 100}%`,
          transform: 'translateY(50%)',
          width: theme.layout.maxWidth,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {top !== undefined && (
          <div style={{textAlign: 'center', position: 'relative', zIndex: 1}}>
            <SideLine text={top} delay={TOP_DELAY} offsetX={-offset} />
          </div>
        )}
        {middle !== undefined && (
          <div
            style={{
              textAlign: 'center',
              position: 'relative',
              zIndex: 3, // 最高，压在上下行之上 → 凸出感
              marginTop: -LINE_OVERLAP,
            }}
          >
            <MiddleLine text={middle} />
          </div>
        )}
        {bottom !== undefined && (
          <div
            style={{textAlign: 'center', position: 'relative', zIndex: 2, marginTop: -LINE_OVERLAP}}
          >
            <SideLine text={bottom} delay={BOTTOM_DELAY} offsetX={offset} />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
