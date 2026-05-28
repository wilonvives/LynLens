import React from 'react';
import { Composition, staticFile } from 'remotion';
import {
  BusinessExplainer,
  type BusinessExplainerSpec,
} from './templates/business-explainer';
import { ep8Spec } from './poc/ep8.spec';

/**
 * LynLens packaging render entry.
 *
 * Unlike the workshop host project (one hardcoded Composition per demo
 * episode), LynLens drives a SINGLE parametrized composition. Everything
 * that varies per export — the trimmed variant clip, the generated spec,
 * the duration, the canvas size — arrives through input props at render
 * time (renderMedia `inputProps`) and is resolved by `calculateMetadata`.
 *
 * This is the exact mechanism the desktop main process uses for
 * packaging-tab export. The defaultProps below only seed Remotion Studio /
 * a no-arg CLI render with the ep8 PoC so the composition is previewable
 * standalone.
 */
// NOTE: must be a `type`, not an `interface`. Remotion's <Composition>
// constrains props to `Record<string, unknown>`; TS interfaces don't get an
// implicit index signature (they can be augmented) and fail that constraint,
// which silently degrades inference to `Record<string, unknown>` and makes
// `props.*` resolve to `unknown` inside calculateMetadata. A type alias
// satisfies the constraint and keeps inference.
export type PackagingProps = {
  /** staticFile(...) path or a file:// URL to the trimmed variant clip. */
  videoSrc: string;
  /** Generated subtitle/effect/sound spec (variant-time, 0-based). */
  spec: BusinessExplainerSpec;
  /** Clip duration in seconds — drives durationInFrames. */
  durationInSeconds: number;
  fps: number;
  width: number;
  height: number;
  /**
   * Optional kept ranges (source seconds). When set, `videoSrc` is the RAW
   * source and the composition stitches these slices live (整片 preview path)
   * instead of expecting a pre-rendered concat. Absent → `videoSrc` whole.
   */
  clips?: Array<{ fromSec: number; toSec: number }>;
};

const POC_DEFAULTS: PackagingProps = {
  videoSrc: staticFile('ep8.mp4'),
  spec: ep8Spec,
  durationInSeconds: 70.94,
  fps: 30,
  width: 1080,
  height: 1920,
};

const PackagingComp: React.FC<PackagingProps> = ({ videoSrc, spec, clips }) => {
  // Resolve the clip source: absolute paths / file: / http(s) URLs pass
  // through; a bare relative name (e.g. "ep8.mp4") is resolved against the
  // bundle's public dir via staticFile. LynLens export passes an absolute
  // path to the trimmed variant clip; the PoC passes a public asset name.
  const resolved = /^(https?:|file:|\/)/.test(videoSrc)
    ? videoSrc
    : staticFile(videoSrc);
  return <BusinessExplainer videoSrc={resolved} spec={spec} clips={clips} />;
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Packaging"
      component={PackagingComp}
      defaultProps={POC_DEFAULTS}
      // Duration + canvas come from props so one composition serves every
      // variant. calculateMetadata runs before render with the resolved
      // inputProps.
      calculateMetadata={({ props }) => ({
        durationInFrames: Math.max(
          1,
          Math.round(props.durationInSeconds * props.fps)
        ),
        fps: props.fps,
        width: props.width,
        height: props.height,
      })}
      // Placeholders; calculateMetadata overrides these.
      durationInFrames={Math.round(POC_DEFAULTS.durationInSeconds * POC_DEFAULTS.fps)}
      fps={POC_DEFAULTS.fps}
      width={POC_DEFAULTS.width}
      height={POC_DEFAULTS.height}
    />
  );
};
