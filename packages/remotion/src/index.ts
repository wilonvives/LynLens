import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root';

registerRoot(RemotionRoot);

export { RemotionRoot, type PackagingProps } from './Root';
export type {
  BusinessExplainerSpec,
  Cue,
  EffectSpec,
  SoundCue,
} from './templates/business-explainer';
