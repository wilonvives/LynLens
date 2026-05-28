import React from 'react';
import {Audio, Sequence, staticFile} from 'remotion';
import {SOUND_BY_ID} from './sounds';
import type {SoundCue} from './types';

const DEFAULT_VOLUME = 0.85;

interface SoundLayerProps {
  sounds: SoundCue[];
  fps: number;
  /** Master multiplier for ALL sfx (0..1, default 1). Final per-sound volume
   *  = (cue.volume ?? 0.85) × masterVolume. */
  masterVolume?: number;
}

// 声音层：在各时间点触发一次性音效。无视觉，挂在合成树里即可。
export const SoundLayer: React.FC<SoundLayerProps> = ({sounds, fps, masterVolume = 1}) => {
  const master = Math.max(0, Math.min(1, masterVolume));
  return (
    <>
      {sounds.map((cue, i) => {
        const def = SOUND_BY_ID[cue.id];
        if (!def) {
          return null;
        }
        const vol = Math.max(0, Math.min(1, (cue.volume ?? DEFAULT_VOLUME) * master));
        return (
          <Sequence key={i} from={Math.round(cue.start * fps)} name={def.label}>
            <Audio
              src={staticFile(`business-explainer/sfx/${def.file}`)}
              volume={vol}
            />
          </Sequence>
        );
      })}
    </>
  );
};
