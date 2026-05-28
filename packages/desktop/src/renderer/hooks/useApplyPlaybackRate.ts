import { useEffect, useRef, type RefObject } from 'react';

/**
 * Keep a `<video>` element's playbackRate in sync with the chosen speed.
 *
 * Two non-obvious things this handles:
 *   1. HTML5 resets `video.playbackRate` to 1.0 every time a new source
 *      loads. So we re-apply on `loadedmetadata` + `play`, not just when the
 *      rate changes — otherwise switching videos silently drops you back to
 *      1×.
 *   2. The React ref to the <video> is unreliable in dev (StrictMode + Vite
 *      Fast Refresh), so we fall back to a DOM querySelector — the same
 *      pattern usePlaybackLoop uses (see CLAUDE.md "React patterns").
 *
 * `reloadKey` (typically the videoUrl) re-runs the effect when the element /
 * source changes so the listeners bind to the live element.
 */
export function useApplyPlaybackRate(
  videoRef: RefObject<HTMLVideoElement | null>,
  rate: number,
  reloadKey: string | null,
  selector = '.player-wrap video'
): void {
  const rateRef = useRef(rate);
  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  useEffect(() => {
    const resolve = (): HTMLVideoElement | null =>
      videoRef.current ?? document.querySelector<HTMLVideoElement>(selector);
    const apply = (): void => {
      const v = resolve();
      if (v && v.playbackRate !== rateRef.current) v.playbackRate = rateRef.current;
    };
    apply();
    const v = resolve();
    if (!v) return;
    v.addEventListener('loadedmetadata', apply);
    v.addEventListener('play', apply);
    return () => {
      v.removeEventListener('loadedmetadata', apply);
      v.removeEventListener('play', apply);
    };
  }, [rate, reloadKey, videoRef, selector]);
}
