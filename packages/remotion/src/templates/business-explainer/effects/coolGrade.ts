import {Easing, interpolate} from 'remotion';
import type {EffectFn} from './types';

// 特效 · 去色冷调（coolGrade）：抽掉饱和度 + 压一点亮度 + 叠冷蓝，画面转冷。
// 用于沉重 / 恐惧 / 严肃时刻。收尾：release → 调回正常；hold → 保持冷调。
const IN_FRAMES = 6;
const OUT_FRAMES = 12;
const DEPTH = 1;

export const coolGrade: EffectFn = (f, len, tail) => {
  const inP = interpolate(f, [0, IN_FRAMES], [0, DEPTH], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  let desaturate = inP;
  if (tail === 'release' && f >= len - OUT_FRAMES) {
    desaturate = interpolate(f, [len - OUT_FRAMES, len], [DEPTH, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.in(Easing.cubic),
    });
  }
  return {scale: 1, x: 0, y: 0, vignette: 0, desaturate};
};
