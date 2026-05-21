import React, {useEffect, useState} from 'react';
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  Sequence,
  useVideoConfig,
} from 'remotion';
import {SUBTITLE_STYLES} from './subtitles';
import {CameraLayer} from './effects/CameraLayer';
import {SoundLayer} from './sound/SoundLayer';
import {loadTemplateFonts} from './fonts';
import type {BusinessExplainerSpec} from './spec';

interface BusinessExplainerProps {
  videoSrc: string; // staticFile(...) 指向消费者自己的视频
  spec: BusinessExplainerSpec; // 字幕 / 特效 / 音效
}

// 「商务讲解」模板入口：吃一条视频 + 一份 spec，输出包装后的成片。
// 适配任意视频——换视频只换 videoSrc + spec。
export const BusinessExplainer: React.FC<BusinessExplainerProps> = ({videoSrc, spec}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const {cues, effects = [], sounds = []} = spec;
  const [handle] = useState(() => delayRender('loading-fonts'));

  useEffect(() => {
    loadTemplateFonts()
      .then(() => continueRender(handle))
      .catch((err) => cancelRender(err));
  }, [handle]);

  return (
    <AbsoluteFill style={{backgroundColor: 'black'}}>
      <CameraLayer videoSrc={videoSrc} effects={effects} fps={fps} />
      {cues.map((cue, i) => {
        const from = Math.round(cue.start * fps);
        const next = i + 1 < cues.length ? cues[i + 1].start : null;
        const end = next === null ? durationInFrames : Math.round(next * fps);
        const length = Math.max(1, end - from);
        const StyleComponent =
          SUBTITLE_STYLES[cue.style as keyof typeof SUBTITLE_STYLES] ?? SUBTITLE_STYLES.plain;

        return (
          <Sequence key={i} from={from} durationInFrames={length}>
            <StyleComponent
              text={cue.text}
              highlight={cue.highlight}
              segments={cue.segments}
              durationInFrames={length}
            />
          </Sequence>
        );
      })}
      <SoundLayer sounds={sounds} fps={fps} />
    </AbsoluteFill>
  );
};
