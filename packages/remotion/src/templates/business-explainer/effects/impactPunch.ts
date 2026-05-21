import {Easing, interpolate} from 'remotion';
import type {EffectFn} from './types';

// 特效 · 冲击推近（impactPunch）：极快 snap 推近到脸部(带过冲) + 落定抖动 + 边缘压暗，
// 用在很重要 / 很震撼的点。
// 收尾：tail='release' → 推回 + 压暗淡出；tail='hold' → 保持推近交给下一个特效。
const IN_FRAMES = 3; // 推进用时（极快）
const OUT_FRAMES = 10; // 推回用时（release 时）
const PEAK_SCALE = 1.35; // 朝脸部放大（transform-origin 在脸部）
const SHAKE_FRAMES = 7; // 落定抖动衰减时长
const SHAKE_AMP = 16; // 抖动幅度 px

export const impactPunch: EffectFn = (f, len, tail) => {
  const inScale = interpolate(f, [0, IN_FRAMES], [1, PEAK_SCALE], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.back(2)), // 过冲
  });
  // 推近时的辅助压暗较浅（聚焦特效才用深压暗）。
  const PEAK_VIGNETTE = 0.5;
  const inVignette = interpolate(f, [0, IN_FRAMES], [0, PEAK_VIGNETTE], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  let scale = inScale;
  let vignette = inVignette;

  // 收尾：仅 release 时推回 + 压暗淡出；hold 保持推近状态。
  if (tail === 'release' && f >= len - OUT_FRAMES) {
    scale = interpolate(f, [len - OUT_FRAMES, len], [PEAK_SCALE, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.in(Easing.cubic),
    });
    vignette = interpolate(f, [len - OUT_FRAMES, len], [PEAK_VIGNETTE, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  }

  // 落定瞬间镜头抖动，快速衰减。
  const decay = interpolate(f, [0, SHAKE_FRAMES], [1, 0], {extrapolateRight: 'clamp'});
  const x = Math.sin(f * 2.3) * SHAKE_AMP * decay;
  const y = Math.cos(f * 2.9) * SHAKE_AMP * decay;

  return {scale, x, y, vignette};
};
