import {interpolate, spring, useCurrentFrame, useVideoConfig} from 'remotion';

// 共享的「出现节奏」：快速淡入；punch=true 时附带「大→缩定」弹现。
// 给重点句（sentence）和十字交叉句（cross）等 Hero 样式复用。
export const useReveal = (delay: number, punch: boolean) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const local = frame - delay;
  const opacity = interpolate(local, [0, punch ? 4 : 5], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const grow = spring({frame: local, fps, durationInFrames: 8, config: {damping: 200}});
  const scale = punch ? interpolate(grow, [0, 1], [1.6, 1]) : 1;
  return {opacity, scale};
};
