import type React from 'react';
import {PlainSubtitle} from './PlainSubtitle';
import {StrongSubtitle} from './StrongSubtitle';
import {SentenceSubtitle} from './SentenceSubtitle';
import {CrossSentenceSubtitle} from './CrossSentenceSubtitle';
import type {SubtitleStyleProps} from './types';

// 字幕样式注册表：spec 里的 style 字段就是这里的 key。
// 新增样式 = 写一个组件 + 在这里注册一行。
export const SUBTITLE_STYLES = {
  plain: PlainSubtitle, // 普通
  strong: StrongSubtitle, // 加强普通（更大更高，超界阶梯换行）
  strongWord: StrongSubtitle, // 加强普通 + 词级强调（黄色凸起重点词）
  sentence: SentenceSubtitle, // 重点句（上/中/下三行 Hero）
  cross: CrossSentenceSubtitle, // 十字交叉重点句（竖排 + 横排两半）
} satisfies Record<string, React.FC<SubtitleStyleProps>>;

export type SubtitleStyleId = keyof typeof SUBTITLE_STYLES;

export type {SubtitleStyleProps};
