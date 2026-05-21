import {Easing, interpolate} from 'remotion';
import type {EffectFn} from './types';

// 特效 · 边缘压暗聚焦（vignetteFocus）：黑色边框阴影向内压，凸显主体。
// 用于「注意 / 听我讲 / 恐惧」内容，常用在开头。持续型：淡入 → 保持 → 淡出。
// 收尾：tail='release' → 压暗淡出；tail='hold' → 保持压暗交给下一个特效。
const IN_FRAMES = 3; // 压上来的速度（快）
const OUT_FRAMES = 12;
const DEPTH = 1; // 压暗强度（具体黑度由 CameraLayer 的内阴影决定）

export const vignetteFocus: EffectFn = (f, len, tail) => {
  const inV = interpolate(f, [0, IN_FRAMES], [0, DEPTH], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  let vignette = inV;
  if (tail === 'release' && f >= len - OUT_FRAMES) {
    vignette = interpolate(f, [len - OUT_FRAMES, len], [DEPTH, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.in(Easing.cubic),
    });
  }
  return {scale: 1, x: 0, y: 0, vignette};
};
