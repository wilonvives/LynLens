import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {measureText} from '@remotion/layout-utils';
import {theme} from '../theme';
import {GradientFillText} from './gradientText';
import type {SubtitleStyleProps} from './types';

// 样式 · 加强普通（strong）/ 加强普通+词级（strongWord）
// 基础（与普通字不同，专属设计）：
//   · 大粗字重（思源宋 Heavy）· 无黑边无投影
//   · 每个字「由左白 → 右侧约 20% 渐隐透明」· 字距收紧
// 版式：更大（1.5×=96）、更高（距底部 35%）；超界换两行 → 阶梯式。
// 词级强调：句中重点词放大到 120px、淡黄色、细黑边、高 blur 黑阴影，
//          微微凸出并叠在白字之上（可微微覆盖相邻白字）。
const SIZE = Math.round(theme.sizes.normal * 1.5); // 96
const WEIGHT = 900;
const LETTER_SPACING = '-0.05em';
const CENTER_FROM_BOTTOM = 0.35;
const MAX_WIDTH_RATIO = 0.86;
const STAGGER_FRAMES = 7;
const CHAR_FADE = 'linear-gradient(90deg, #ffffff 0%, #ffffff 80%, rgba(255,255,255,0) 100%)';

// 不可拆词表：Intl.Segmenter 靠词典分词，认不出的新词/专有词（如「钱骡」）会被当成单字、
// 从中间切开。把这些词列在这里，阶梯换行时强制不在其内部切。新主题/新词记得往这里加。
const PROTECTED_TERMS = ['钱骡', '数码谋杀', '数码人权', '黑户', '苦主'];

// 重点词外观
const HOT_SIZE = 120;
const HOT_SHADOW = '0 4px 26px rgba(0,0,0,0.9)'; // 高 blur 黑阴影

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const measure = (text: string): number =>
  measureText({
    text,
    fontFamily: theme.fontFamily,
    fontSize: SIZE,
    fontWeight: WEIGHT,
    letterSpacing: LETTER_SPACING,
  }).width;

// 不允许把切分点落在重点词内部（避免重点词被拆到两行）。
const forbiddenSplitIndices = (text: string, words: string[]): Set<number> => {
  const set = new Set<number>();
  for (const w of words) {
    let idx = text.indexOf(w);
    while (idx >= 0) {
      for (let k = idx + 1; k < idx + w.length; k += 1) set.add(k);
      idx = text.indexOf(w, idx + 1);
    }
  }
  return set;
};

// 词边界（用 Intl.Segmenter 分词）：只在这些位置切，中英文的词都不会被拆断。
const wordBoundaries = (text: string): Set<number> => {
  const set = new Set<number>([0, text.length]);
  try {
    const seg = new Intl.Segmenter('zh', {granularity: 'word'});
    let idx = 0;
    for (const part of seg.segment(text)) {
      idx += part.segment.length;
      set.add(idx);
    }
  } catch {
    for (let i = 0; i <= text.length; i += 1) set.add(i);
  }
  return set;
};

// 尽量平均地切两行，两行都不超过 maxPx，不在重点词内部切，且优先在词边界切（不拆词/字母）。
const splitIntoTwoLines = (
  text: string,
  maxPx: number,
  words: string[],
): [string, string] => {
  const n = text.length;
  // 重点词 + 不可拆词表，内部都不许切。
  const forbidden = forbiddenSplitIndices(text, [...words, ...PROTECTED_TERMS]);
  const boundaries = wordBoundaries(text);

  const search = (boundaryOnly: boolean): [string, string] | null => {
    let best: [string, string] | null = null;
    let bestScore = Infinity;
    for (let i = 1; i < n; i += 1) {
      if (forbidden.has(i)) continue;
      if (boundaryOnly && !boundaries.has(i)) continue;
      const a = text.slice(0, i);
      const b = text.slice(i);
      const wa = measure(a);
      const wb = measure(b);
      if (wa <= maxPx && wb <= maxPx && Math.abs(wa - wb) < bestScore) {
        bestScore = Math.abs(wa - wb);
        best = [a, b];
      }
    }
    return best;
  };

  // 优先词边界切；都放不下才退回任意位置；再不行用中点。
  return (
    search(true) ??
    search(false) ?? [text.slice(0, Math.ceil(n / 2)), text.slice(Math.ceil(n / 2))]
  );
};

type Segment = {hot: boolean; text: string};

const segmentize = (text: string, words: string[]): Segment[] => {
  if (words.length === 0) return [{hot: false, text}];
  const re = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'g');
  return text
    .split(re)
    .filter((s) => s.length > 0)
    .map((s) => ({hot: words.includes(s), text: s}));
};

// 仅中文/CJK 标点收紧字距；英文与空格保持正常，避免粘连。
const isCJK = (ch: string): boolean =>
  /[㐀-鿿豈-﫿　-〿＀-￯]/.test(ch);

const FadeChar: React.FC<{ch: string}> = ({ch}) => (
  <span
    style={{
      display: 'inline-block',
      whiteSpace: 'pre', // 保留空格宽度，避免英文单词粘连
      marginRight: isCJK(ch) ? LETTER_SPACING : undefined,
      backgroundImage: CHAR_FADE,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
      WebkitTextFillColor: 'transparent',
    }}
  >
    {ch}
  </span>
);

// 重点词：用统一的逐字黄→白渐变（无描边 + 高 blur 阴影），并微微凸出、叠在白字上层。
const HotWord: React.FC<{text: string}> = ({text}) => (
  <span
    style={{
      display: 'inline-block',
      position: 'relative',
      zIndex: 2,
      margin: '0 -0.06em', // 微微覆盖相邻白字
      transform: 'translateY(-0.04em)', // 微微凸出
      verticalAlign: 'middle',
    }}
  >
    <GradientFillText text={text} fontSize={HOT_SIZE} shadow={HOT_SHADOW} fontWeight={WEIGHT} />
  </span>
);

// 一行文字：普通字渐隐白，重点词黄色凸起。
const StrongLine: React.FC<{text: string; highlight: string[]}> = ({text, highlight}) => (
  <span
    style={{
      fontFamily: theme.fontFamily,
      fontSize: SIZE,
      fontWeight: WEIGHT,
      lineHeight: 1.25,
      whiteSpace: 'nowrap',
      position: 'relative',
    }}
  >
    {segmentize(text, highlight).map((seg, si) =>
      seg.hot ? (
        <HotWord key={si} text={seg.text} />
      ) : (
        Array.from(seg.text).map((ch, ci) => <FadeChar key={`${si}-${ci}`} ch={ch} />)
      ),
    )}
  </span>
);

const useEntrance = (delay: number) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const appear = spring({frame: frame - delay, fps, durationInFrames: 9, config: {damping: 200}});
  return {
    opacity: interpolate(appear, [0, 1], [0, 1]),
    rise: interpolate(appear, [0, 1], [22, 0]),
    slide: interpolate(appear, [0, 1], [1, 0]),
  };
};

const StaircaseLine: React.FC<{
  text: string;
  highlight: string[];
  align: 'left' | 'right';
  delay: number;
}> = ({text, highlight, align, delay}) => {
  const {opacity, rise, slide} = useEntrance(delay);
  const dx = (align === 'left' ? -36 : 36) * slide;
  return (
    <div
      style={{
        textAlign: align,
        whiteSpace: 'nowrap',
        opacity,
        transform: `translate(${dx}px, ${rise}px)`,
      }}
    >
      <StrongLine text={text} highlight={highlight} />
    </div>
  );
};

export const StrongSubtitle: React.FC<SubtitleStyleProps> = ({text, highlight = []}) => {
  const {width} = useVideoConfig();
  const maxPx = width * MAX_WIDTH_RATIO;
  const single = useEntrance(0);

  // 一行能放下 → 单行（居中）。
  if (measure(text) <= maxPx) {
    return (
      <AbsoluteFill>
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            marginLeft: 'auto',
            marginRight: 'auto',
            bottom: `${CENTER_FROM_BOTTOM * 100}%`,
            transform: `translateY(calc(50% + ${single.rise}px))`,
            opacity: single.opacity,
            maxWidth: theme.layout.maxWidth,
            textAlign: 'center',
          }}
        >
          <StrongLine text={text} highlight={highlight} />
        </div>
      </AbsoluteFill>
    );
  }

  // 放不下 → 阶梯式两行。
  const [line1, line2] = splitIntoTwoLines(text, maxPx, highlight);
  return (
    <AbsoluteFill>
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
        <StaircaseLine text={line1} highlight={highlight} align="left" delay={0} />
        <StaircaseLine text={line2} highlight={highlight} align="right" delay={STAGGER_FRAMES} />
      </div>
    </AbsoluteFill>
  );
};
