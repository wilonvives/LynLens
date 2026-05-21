import React from 'react';
import {SubtitleBox} from './SubtitleBox';
import type {SubtitleStyleProps} from './types';

// 样式 1 · 普通：干净白字，仅淡入上移。承载大部分叙述句。
export const PlainSubtitle: React.FC<SubtitleStyleProps> = ({text}) => {
  return <SubtitleBox>{text}</SubtitleBox>;
};
