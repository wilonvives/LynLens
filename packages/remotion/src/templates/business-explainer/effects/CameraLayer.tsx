import React from 'react';
import {
  AbsoluteFill,
  OffthreadVideo,
  Series,
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

/** One kept slice of the SOURCE video, played at its compacted position. */
export interface Clip {
  fromSec: number;
  toSec: number;
}

interface CameraLayerProps {
  videoSrc: string;
  effects: EffectSpec[];
  fps: number;
  /**
   * When present, `videoSrc` is the RAW source and these are the kept ranges
   * (source seconds, in playback order). The layer stitches them live via a
   * <Series> of trimmed source clips instead of relying on a pre-rendered
   * concat. This avoids handing the browser preview player a huge
   * many-segment concat it can't decode (整片 with ~180 ripple cuts → black
   * + PIPELINE_ERROR_DECODE). Each clip decodes a slice of the raw source,
   * which the browser handles fine. When absent, `videoSrc` is played whole
   * (variant preview + export keep using their concat, untouched).
   */
  clips?: Clip[];
}

/** Render the base video element (render path = OffthreadVideo, preview = Video).
 *  Optional trim plays only source frames [trimBefore, trimAfter). */
function BaseVideo({
  src,
  trimBefore,
  trimAfter,
}: {
  src: string;
  trimBefore?: number;
  trimAfter?: number;
}): React.ReactElement {
  const isRendering = getRemotionEnvironment().isRendering;
  const trim =
    trimBefore != null ? {trimBefore, ...(trimAfter != null ? {trimAfter} : {})} : {};
  return isRendering ? (
    <OffthreadVideo src={src} {...trim} />
  ) : (
    <Video src={src} {...trim} />
  );
}

// 背景视频 + 镜头特效层（缩放/位移/压暗/黑边）。特效只作用于视频，字幕在更上层不受影响。
export const CameraLayer: React.FC<CameraLayerProps> = ({videoSrc, effects, fps, clips}) => {
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
        {/* No clips → play the source whole (variant preview + export use a
            pre-rendered concat here). With clips → stitch the raw source's
            kept slices live via <Series>, so the browser never has to decode
            a giant many-segment concat (整片 fix). */}
        {clips && clips.length > 0 ? (
          <Series>
            {clips
              .map((c) => ({
                fromF: Math.round(c.fromSec * fps),
                toF: Math.round(c.toSec * fps),
              }))
              // Drop sub-frame slivers: a kept range shorter than one frame
              // rounds to fromF === toF, i.e. trimBefore === trimAfter, which
              // Remotion's OffthreadVideo rejects (validateMediaTrimProps →
              // render crash). These come from two ripple cuts ~0.01s apart;
              // < 1 frame of footage, safe to skip.
              .filter((c) => c.toF > c.fromF)
              .map((c, i) => (
                // premountFor mounts each clip's <Video> ~1s early (invisibly)
                // so the browser has finished seeking + buffering to trimBefore
                // before the clip becomes visible — kills the "切口黑闪".
                <Series.Sequence
                  key={i}
                  durationInFrames={c.toF - c.fromF}
                  premountFor={Math.round(fps)}
                >
                  <BaseVideo src={videoSrc} trimBefore={c.fromF} trimAfter={c.toF} />
                </Series.Sequence>
              ))}
          </Series>
        ) : (
          <BaseVideo src={videoSrc} />
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
