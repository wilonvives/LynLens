/**
 * Live @remotion/player preview for the 商务讲解 template.
 *
 * This is the real thing — the SAME React composition the export renders,
 * running live in the packaging tab. It plays + scrubs in real time and
 * reflects spec changes instantly (data-driven). No "click to render"
 * round-trip: the player IS the preview.
 *
 * The template source is imported via the `@remotion-template` Vite alias
 * (compiled from packages/remotion/src so the JSX transform applies; the
 * package entry is avoided because it calls registerRoot()).
 *
 * Hard-won setup notes:
 *   - `videoSrc` MUST be an HTTP URL (the localhost media server). Remotion's
 *     media components can't load our lynlens-media:// scheme, and the CSP
 *     must allow the media-server origin (http://127.0.0.1:*).
 *   - The template's SoundLayer can need >5 simultaneous <Audio> tags; the
 *     player's default cap is 5 and it CRASHES (blanks) when exceeded — hence
 *     numberOfSharedAudioTags below. This was the cause of "scrub a few times
 *     → whole player goes black".
 */
import { Player as RemotionPlayer } from '@remotion/player';
// eslint-disable-next-line import/no-unresolved -- Vite alias to template src
import { BusinessExplainer } from '@remotion-template';
import type { BusinessExplainerSpec } from '@lynlens/core';

// @remotion/player ships types built against @types/react@19; the renderer
// is on @types/react@18. The two ReactElement/ReactNode shapes are
// structurally incompatible, so tsc rejects <Player> as a JSX element. The
// runtime is fine (one React instance via Vite dedupe) — cast to a
// permissive component type to bypass the cross-version typing only here.
const Player = RemotionPlayer as unknown as React.ComponentType<
  Record<string, unknown>
>;

interface Props {
  /** HTTP URL (localhost media server) to the trimmed variant clip. */
  videoSrc: string;
  spec: BusinessExplainerSpec;
  durationInSeconds: number;
  fps: number;
  width: number;
  height: number;
}

type BusinessExplainerProps = {
  videoSrc: string;
  spec: BusinessExplainerSpec;
};

/** Surface composition crashes on screen instead of a silent blank player. */
function ErrorFallback({ error }: { error: Error }): React.ReactNode {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: '#1a0000',
        color: '#ff8080',
        padding: 16,
        fontSize: 12,
        fontFamily: 'monospace',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
      }}
    >
      {`预览出错: ${error.message}`}
    </div>
  );
}

export function PackagingRemotionPlayer({
  videoSrc,
  spec,
  durationInSeconds,
  fps,
  width,
  height,
}: Props): JSX.Element {
  const durationInFrames = Math.max(1, Math.round(durationInSeconds * fps));
  const inputProps: BusinessExplainerProps = { videoSrc, spec };
  return (
    <Player
      component={BusinessExplainer}
      inputProps={inputProps}
      durationInFrames={durationInFrames}
      compositionWidth={width}
      compositionHeight={height}
      fps={fps}
      style={{ width: '100%', height: '100%' }}
      controls
      acknowledgeRemotionLicense
      numberOfSharedAudioTags={25}
      errorFallback={ErrorFallback}
    />
  );
}
