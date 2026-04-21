import { useCallback, useEffect, useRef } from 'react';

interface ResizerProps {
  /** 'horizontal' = vertical bar dragged left/right (resizes width). 'vertical' = horizontal bar dragged up/down (resizes height). */
  direction: 'horizontal' | 'vertical';
  /** Current value in px (width for horizontal, height for vertical). */
  value: number;
  /** Called with the new value while dragging and on release. */
  onChange: (next: number) => void;
  /** Minimum allowed size in px. */
  min: number;
  /** Maximum allowed size in px. */
  max: number;
  /**
   * Direction the value grows when dragging.
   *  - For a sidebar attached to the right edge of the screen (sidebar, chat panel),
   *    dragging LEFT should INCREASE width → `invert: true`.
   *  - For a panel attached to the bottom (timeline), dragging UP should INCREASE
   *    height → `invert: true` for vertical.
   *  - Default `invert: false` means drag-right/drag-down increases the value.
   */
  invert?: boolean;
}

export function Resizer({ direction, value, onChange, min, max, invert = false }: ResizerProps) {
  const dragRef = useRef<{ startPos: number; startValue: number } | null>(null);

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const cur = direction === 'horizontal' ? e.clientX : e.clientY;
      const rawDelta = cur - drag.startPos;
      const delta = invert ? -rawDelta : rawDelta;
      const next = Math.min(max, Math.max(min, drag.startValue + delta));
      onChange(next);
    },
    [direction, invert, max, min, onChange]
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragRef.current = {
      startPos: direction === 'horizontal' ? e.clientX : e.clientY,
      startValue: value,
    };
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [onPointerMove, onPointerUp]);

  return (
    <div
      className={`resizer resizer-${direction}`}
      onPointerDown={onPointerDown}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    />
  );
}
