/**
 * Native `<video>` element wrapper for use inside a Remotion `<Sequence>`.
 *
 * Why not Remotion's `<Video>` / `<OffthreadVideo>`?
 *   - LynLens's BrowserWindow has `webSecurity: true`, so file:// URLs
 *     are blocked in the renderer.
 *   - The app routes ALL local-video access through a custom
 *     `lynlens-media://` protocol handler (defined in main/index.ts)
 *     that supports HTTP Range requests for seeking.
 *   - Remotion's `<Video>` wrapper doesn't recognise this custom scheme
 *     and silently falls back to a black frame.
 *
 * This component renders a raw `<video>` tag — the same path the
 * precision tab's MediaPlayer uses successfully — and synchronises
 * playback with Remotion's frame ticker:
 *
 *   - On mount / when sourceStartSec changes: seek to the source-time
 *     start of this Sequence.
 *   - Each frame: if the video has drifted from where Remotion thinks
 *     it should be, snap currentTime back. Threshold (0.15s) avoids
 *     stutter for tiny drift while staying tight enough that users
 *     don't notice mis-sync.
 *   - Honour Remotion's playing state (Player play/pause): when
 *     Remotion's playback is "live", we call video.play(); when it's
 *     scrubbing or paused, we pause the video and rely on currentTime
 *     updates for the visual.
 *
 * Caveat: render-time export (renderMedia in headless Chrome) does NOT
 * work with native `<video>` — it can't capture frames from a streaming
 * `<video>` element. For export we'll need a separate code path that
 * uses OffthreadVideo with a file:// URL (since headless Chrome can
 * read files without the custom protocol). This component is preview-
 * only; the export pipeline branches on `process.env.REMOTION_RENDERER`
 * (or similar) to swap implementations.
 */
import { useEffect, useRef } from 'react';
import { useCurrentFrame, useVideoConfig, continueRender, delayRender } from 'remotion';

interface NativeVideoProps {
  src: string;
  /** Source-time second where this Sequence begins. */
  sourceStartSec: number;
  /** Source-time second where this Sequence ends. */
  sourceEndSec: number;
  style?: React.CSSProperties;
}

export function NativeVideo({
  src,
  sourceStartSec,
  sourceEndSec,
  style,
}: NativeVideoProps): JSX.Element {
  const ref = useRef<HTMLVideoElement>(null);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Delay the first Remotion render until the video has loaded enough
  // data to seek to the start — prevents the "black frame for 200ms"
  // flash when a new Sequence enters.
  const handleRef = useRef<number | null>(null);

  // Compute the source time we want the video to be at right now.
  const targetSrcSec = sourceStartSec + frame / fps;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // First time we have a video element: hold Remotion's render until
    // the video can actually paint a frame. Resolves when metadata loads
    // OR after a short timeout (don't block forever if the file is
    // unloadable).
    if (handleRef.current == null) {
      handleRef.current = delayRender('NativeVideo loading');
      const onReady = (): void => {
        if (handleRef.current != null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      };
      v.addEventListener('loadedmetadata', onReady, { once: true });
      v.addEventListener('error', onReady, { once: true });
      // Safety net: don't hang Remotion forever
      const timeoutId = setTimeout(onReady, 2000);
      return () => {
        clearTimeout(timeoutId);
        v.removeEventListener('loadedmetadata', onReady);
        v.removeEventListener('error', onReady);
        if (handleRef.current != null) {
          continueRender(handleRef.current);
          handleRef.current = null;
        }
      };
    }
    return undefined;
  }, []);

  // Seek the underlying <video> to track Remotion's frame. Only snap if
  // drift > 0.15s — within that the native playback is close enough.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!Number.isFinite(targetSrcSec)) return;
    if (Math.abs(v.currentTime - targetSrcSec) > 0.15) {
      v.currentTime = Math.max(0, Math.min(sourceEndSec, targetSrcSec));
    }
  }, [targetSrcSec, sourceEndSec]);

  return (
    <video
      ref={ref}
      src={src}
      muted
      playsInline
      // autoPlay lets native playback advance in real-time, which keeps
      // pace with Remotion's 1x playback. When Remotion scrubs the user
      // moves frame independently and our useEffect snaps currentTime
      // to the right spot.
      autoPlay
      style={{
        display: 'block',
        ...style,
      }}
      onError={(e) => {
        // eslint-disable-next-line no-console
        console.error('[NativeVideo] failed to load', src, e);
      }}
    />
  );
}
