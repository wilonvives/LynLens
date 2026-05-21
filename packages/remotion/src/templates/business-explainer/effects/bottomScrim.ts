import {Easing, interpolate} from 'remotion';
import type {EffectFn} from './types';

// 特效 · 底部阴影底盘（bottomScrim）：黑色柔和阴影从底部升起、覆盖约 30%，
// 承托大量 / 长段重点信息，让下方文字清晰。时长由窗口决定。
// 收尾：tail='release' → 降回；tail='hold' → 保持。
const IN_FRAMES = 3; // 升起速度（快）
const OUT_FRAMES = 10;

export const bottomScrim: EffectFn = (f, len, tail) => {
  const inP = interpolate(f, [0, IN_FRAMES], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  let progress = inP;
  if (tail === 'release' && f >= len - OUT_FRAMES) {
    progress = interpolate(f, [len - OUT_FRAMES, len], [1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.in(Easing.cubic),
    });
  }
  return {scale: 1, x: 0, y: 0, vignette: 0, scrim: progress};
};
