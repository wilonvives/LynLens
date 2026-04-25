import { useEffect, useState, type RefObject } from 'react';

/**
 * Track the live size of the player wrapper element. Used by App.tsx to
 * compute the rotated `<video>`'s maxWidth/maxHeight so 90°/270° preview
 * rotations land back inside the visible area instead of overflowing.
 *
 * Plain ResizeObserver wrapped in a hook — the only reason it lives in
 * its own file is to keep App.tsx's body short and named.
 */
export function usePlayerWrapSize(
  ref: RefObject<HTMLElement | null>
): { w: number; h: number } {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
