import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Video,
  getRemotionEnvironment,
  useCurrentFrame,
} from 'remotion';
import {impactPunch} from './impactPunch';
import {vignetteFocus} from './vignetteFocus';
import {bottomScrim} from './bottomScrim';
import {coolGrade} from './coolGrade';
import type {CameraState, EffectFn, EffectSpec} from './types';

const DEFAULT_ORIGIN = '50% 28%'; // 脸部位置（竖屏口播）
const NEUTRAL: CameraState = {scale: 1, x: 0, y: 0, vignette: 0};
const EFFECTS: Record<EffectSpec['type'], EffectFn> = {
  impactPunch,
  vignetteFocus,
  bottomScrim,
  coolGrade,
};

const SCRIM_HEIGHT = '50%'; // 底盘覆盖高度

interface CameraLayerProps {
  videoSrc: string;
  effects: EffectSpec[];
  fps: number;
}

// 背景视频 + 镜头特效层（缩放/位移/压暗/黑边）。特效只作用于视频，字幕在更上层不受影响。
export const CameraLayer: React.FC<CameraLayerProps> = ({videoSrc, effects, fps}) => {
  const frame = useCurrentFrame();

  let state = NEUTRAL;
  let origin = DEFAULT_ORIGIN;
  for (const e of effects) {
    const startFrame = Math.round(e.start * fps);
    const endFrame = Math.round(e.end * fps);
    if (frame >= startFrame && frame < endFrame) {
      state = EFFECTS[e.type](frame - startFrame, endFrame - startFrame, e.tail ?? 'release');
      origin = e.origin ?? DEFAULT_ORIGIN;
      break;
    }
  }

  const desat = state.desaturate ?? 0;

  return (
    <AbsoluteFill>
      <AbsoluteFill
        style={{
          transform: `translate(${state.x}px, ${state.y}px) scale(${state.scale})`,
          transformOrigin: origin,
          filter:
            desat > 0
              ? `saturate(${1 - desat * 0.8}) brightness(${1 - desat * 0.08})`
              : undefined,
        }}
      >
        {/* Player preview uses a single native <Video> (one element = one
            connection, no decoder/connection exhaustion when scrubbing).
            Export rendering uses OffthreadVideo (frame-accurate). */}
        {getRemotionEnvironment().isRendering ? (
          <OffthreadVideo src={videoSrc} />
        ) : (
          <Video src={videoSrc} />
        )}
      </AbsoluteFill>
      {desat > 0 && (
        <AbsoluteFill style={{backgroundColor: 'rgb(40,75,120)', opacity: desat * 0.2}} />
      )}
      {state.vignette > 0 && (
        <AbsoluteFill
          style={{
            // 黑色边框内阴影：向内压一圈黑边，凸显主体。
            boxShadow: 'inset 0 0 320px 150px rgba(0,0,0,0.95)',
            opacity: state.vignette,
          }}
        />
      )}
      {(state.scrim ?? 0) > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: SCRIM_HEIGHT,
            transform: `translateY(${(1 - (state.scrim ?? 0)) * 100}%)`,
            background:
              'linear-gradient(to top, rgba(0,0,0,0.9) 0%, rgba(0,0,0,0.55) 50%, rgba(0,0,0,0) 100%)',
          }}
        />
      )}
    </AbsoluteFill>
  );
};
