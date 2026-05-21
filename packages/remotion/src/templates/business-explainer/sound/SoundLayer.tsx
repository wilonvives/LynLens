import React from 'react';
import {Audio, Sequence, staticFile} from 'remotion';
import {SOUND_BY_ID} from './sounds';
import type {SoundCue} from './types';

const DEFAULT_VOLUME = 0.85;

interface SoundLayerProps {
  sounds: SoundCue[];
  fps: number;
}

// 声音层：在各时间点触发一次性音效。无视觉，挂在合成树里即可。
export const SoundLayer: React.FC<SoundLayerProps> = ({sounds, fps}) => {
  return (
    <>
      {sounds.map((cue, i) => {
        const def = SOUND_BY_ID[cue.id];
        if (!def) {
          return null;
        }
        return (
          <Sequence key={i} from={Math.round(cue.start * fps)} name={def.label}>
            <Audio
              src={staticFile(`business-explainer/sfx/${def.file}`)}
              volume={cue.volume ?? DEFAULT_VOLUME}
            />
          </Sequence>
        );
      })}
    </>
  );
};
