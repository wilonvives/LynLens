import { useEffect, useRef, type RefObject } from 'react';
import type { Segment } from '../core-browser';

interface PlaybackLoopArgs {
  /**
   * Ref to the active `<video>` element. The hook also falls back to
   * `document.querySelector('.player-wrap video')` if the React ref is
   * unreliable — see comment inside `tick` for why. This pattern is
   * documented in CLAUDE.md as the "refs are unreliable in dev" rule.
   */
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Live segments list (used to skip cut zones during playback). */
  segments: Segment[];
  /** Whether the user is in "preview rippled timeline" mode. */
  previewMode: boolean;
  /** Active project id — re-mounts the loop on project change. */
  projectId: string | null;
  /** State setter for currentTime — called every animation frame. */
  setCurrentTime: (t: number) => void;
}

/**
 * Drive the playhead's React state via requestAnimationFrame, plus enforce
 * cut-skip + preview-mode-skip rules. This is intentionally NOT depending
 * on `segments` / `previewMode` directly (mirror refs read inside the
 * tick) — putting those in the dep array tears down the RAF every time
 * a segment ref changes, which during project load (N replayed
 * segment.added events) means the loop never fires its first frame.
 *
 * See CLAUDE.md "React patterns" for the full backstory.
 */
export function usePlaybackLoop({
  videoRef,
  segments,
  previewMode,
  projectId,
  setCurrentTime,
}: PlaybackLoopArgs): void {
  const segmentsRef = useRef(segments);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  const previewModeRef = useRef(previewMode);
  useEffect(() => {
    previewModeRef.current = previewMode;
  }, [previewMode]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // Resolve <video> via DOM querySelector if the React ref is null.
      // dev-mode StrictMode + Vite Fast Refresh occasionally leave the
      // closure pointing at a stale ref instance while the real <video>
      // is alive in the DOM. The DOM is the single source of truth.
      const v =
        videoRef.current ??
        document.querySelector<HTMLVideoElement>('.player-wrap video');
      if (v && videoRef.current !== v) {
        (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = v;
      }
      if (v) {
        setCurrentTime(v.currentTime);
        // Committed ripple cuts: ALWAYS skip. Number.isFinite guards
        // against NaN before loadedmetadata fires (writing currentTime =
        // NaN throws TypeError, which would kill the entire RAF chain).
        const segs = segmentsRef.current;
        const cut = segs.find(
          (s) =>
            s.status === 'cut' && v.currentTime >= s.start && v.currentTime < s.end
        );
        if (cut && Number.isFinite(v.duration)) {
          const target = Math.min(v.duration, cut.end + 0.02);
          if (Number.isFinite(target)) v.currentTime = target;
        }
        // Preview mode: also skip approved (not-yet-committed) deletes.
        if (previewModeRef.current && !v.paused) {
          const currentSeg = segs.find(
            (s) =>
              s.status === 'approved' &&
              v.currentTime >= s.start &&
              v.currentTime < s.end
          );
          if (currentSeg && Number.isFinite(v.duration)) {
            const target = Math.min(v.duration, currentSeg.end + 0.02);
            if (Number.isFinite(target)) v.currentTime = target;
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [projectId, videoRef, setCurrentTime]);
}
