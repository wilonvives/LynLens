/**
 * Drop-in `<Player>` wrapping the PackagingComposition. The HighlightPanel
 * shows this instead of the native `<video>` element when a packaging
 * plan is loaded for the current variant.
 *
 * Why a wrapper instead of inlining `<Player>` at the call site:
 *   1. Computing total duration in frames from segments (Player needs
 *      durationInFrames up front; we derive from sum of segment lengths)
 *   2. Centralising the file:// URL conversion (renderer can't load raw
 *      filesystem paths without the scheme)
 *   3. Sensible defaults for controls / clickToPlay / loop that match
 *      LynLens's existing video player UX
 */
import { Player } from '@remotion/player';
import { useMemo } from 'react';
import type { PackagingPlan } from '@lynlens/core';
import { PackagingComposition } from './PackagingComposition';

interface PackagingPreviewProps {
  /** Absolute filesystem path to the source video. */
  videoPath: string;
  /** Source-time segments to play in order. */
  segments: Array<{ start: number; end: number; text?: string }>;
  /** Packaging plan to apply. null → render with defaults (no decorations). */
  plan: PackagingPlan | null;
  /** Video dimensions — Player needs these to scale correctly. */
  width: number;
  height: number;
  /** Frame rate (typically 30 or 60). */
  fps?: number;
  /** Player styling — let parent control the box size. */
  style?: React.CSSProperties;
  /** Whether to show Remotion's built-in controls (default false; LynLens has its own). */
  showControls?: boolean;
}

export function PackagingPreview({
  videoPath,
  segments,
  plan,
  width,
  height,
  fps = 30,
  style,
  showControls = true,
}: PackagingPreviewProps): JSX.Element {
  // Player wants a file:// URL for local files when running in Electron.
  const videoUrl = useMemo(() => {
    if (videoPath.startsWith('file://') || videoPath.startsWith('http')) {
      return videoPath;
    }
    return `file://${videoPath}`;
  }, [videoPath]);

  // Total frames = sum of all segment durations in source time.
  const durationInFrames = useMemo(() => {
    const totalSec = segments.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
    return Math.max(1, Math.round(totalSec * fps));
  }, [segments, fps]);

  return (
    <Player
      component={PackagingComposition}
      durationInFrames={durationInFrames}
      compositionWidth={width}
      compositionHeight={height}
      fps={fps}
      inputProps={{
        videoPath: videoUrl,
        segments,
        plan,
        fps,
        width,
        height,
      }}
      style={{
        width: '100%',
        height: '100%',
        ...style,
      }}
      controls={showControls}
      acknowledgeRemotionLicense
    />
  );
}
