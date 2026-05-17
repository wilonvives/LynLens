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
  /**
   * Source-time segments to play in order. Each entry is ONE transcript
   * line (single subtitle), NOT a variant chunk — keeps the subtitle
   * cadence right. `segmentIdx` is the original transcript index used
   * to look up the per-segment recipe in the PackagingPlan.
   */
  segments: Array<{
    start: number;
    end: number;
    text: string;
    segmentIdx: number;
  }>;
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
  // Pass the URL through unchanged if it already has a protocol (handles
  // file://, http(s)://, AND the app's custom lynlens-media:// scheme).
  // Otherwise treat as a raw filesystem path and prepend file://. The
  // lynlens-media handler is the normal LynLens way to load source video
  // in the renderer (registered in main/index.ts).
  const videoUrl = useMemo(() => {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(videoPath)) {
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
