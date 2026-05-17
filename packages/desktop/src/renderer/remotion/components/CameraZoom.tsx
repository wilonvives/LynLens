/**
 * Static "camera zoom" wrapper — applies CSS transform: scale + translate
 * to children so the underlying video appears zoomed/recentered.
 *
 * v0.5 is static: zoom value held constant for the segment's full duration
 * (the "钱骡" video reference uses this — middle segment zoom 1.3,
 * punchline zoom 1.5, no Ken Burns animation).
 *
 * v0.6 will read camera.zoomFrom / camera.zoomTo + easing and interpolate
 * across frames using Remotion's `useCurrentFrame()` + `interpolate()` —
 * but that's strictly an additive change to this component, not a new
 * data structure.
 *
 * Focus point (0..1 normalised) is applied via transform-origin so zooming
 * "into the face" works: focus={x:0.5,y:0.4} keeps the head centred when
 * the frame zooms in.
 */
import { AbsoluteFill } from 'remotion';

interface CameraZoomProps {
  zoom: number;
  focus: { x: number; y: number };
  children: React.ReactNode;
}

export function CameraZoom({ zoom, focus, children }: CameraZoomProps): JSX.Element {
  return (
    <AbsoluteFill
      style={{
        transform: `scale(${zoom})`,
        transformOrigin: `${(focus.x * 100).toFixed(1)}% ${(focus.y * 100).toFixed(1)}%`,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}
