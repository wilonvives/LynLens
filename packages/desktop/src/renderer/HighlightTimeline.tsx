import { useEffect, useRef, useState, useCallback } from 'react';
import { effectiveToSource, sourceToEffective, type HighlightVariant, type Range } from './core-browser';
import { formatTime } from './util';

/**
 * Full-width timeline that doubles as scrubber AND segment editor for the
 * highlight tab. Replaces the old in-player progress bar + the separate
 * mini-timeline editor below — one widget owns "where are we in the
 * video" + "which parts are picked for this variant".
 *
 * Features:
 *   - Waveform background (peak + RMS, same render as precision Timeline)
 *   - Variant segments as orange overlays at their effective-time positions
 *   - Drag segment edges to resize (commit on mouseup via IPC)
 *   - Click anywhere to seek the video
 *   - Mouse wheel to zoom (Cmd/Ctrl+wheel) or pan (plain wheel)
 *   - Playhead cursor follows video.currentTime (passed as prop)
 *   - Per-segment delete `×` button on hover (consolidates mini-timeline)
 *
 * Out of scope (intentional — keep the component manageable):
 *   - Drag to MOVE a segment (resize only). Move via delete + add elsewhere.
 *   - Drag to add a new segment by sweeping. Use the explicit `+ 加段` button.
 *   - Multi-select. Edit one at a time.
 */
interface Props {
  variant: HighlightVariant | null;
  /** Post-cut effective video length in seconds. */
  effectiveDuration: number;
  /** Ripple cut ranges (source time). Drives effective↔source conversion. */
  cutRanges: readonly Range[];
  /** Pre-extracted waveform envelope. Null = "drawing waveform..." placeholder. */
  waveform: { peak: Float32Array; rms: Float32Array } | null;
  /** Current playhead position — SOURCE seconds. */
  currentTimeSrc: number;
  /**
   * True while the video is actually playing. Drives auto-follow (slides
   * the view forward when the playhead approaches the right edge).
   */
  isPlaying: boolean;
  /** Currently-playing variant segment index — drives "current" highlight. */
  playingSegIdx: number;
  /** Seek the player to a SOURCE-second position. */
  onSeek: (srcSec: number) => void;
  /**
   * Continuous scrub: called on every mousemove during a playhead drag.
   * Lets the parent update video.currentTime live so the preview frame
   * matches the cursor without waiting for mouseup.
   */
  onScrub?: (srcSec: number) => void;
  /** Set the playing-segment index (when user clicks on a segment marker). */
  onSetPlayingSegIdx: (idx: number) => void;
  /** Resize a segment to (newStart, newEnd) — SOURCE seconds. */
  onResizeSegment: (segIdx: number, newStart: number, newEnd: number) => void;
  /** Delete a segment by index. */
  onDeleteSegment: (segIdx: number) => void;
  /**
   * Shift+drag → mark a new segment range. (srcStart, srcEnd) are
   * source seconds, already clamped + converted from effective by
   * the timeline. Parent applies to the currently-selected variant
   * via the add-highlight-variant-segment-range IPC.
   *
   * Optional — if not provided, shift+drag falls back to plain seek.
   */
  onMarkRange?: (srcStart: number, srcEnd: number) => void;
  /**
   * Premiere-style timeline markers (M-key bookmarks). Source-time.
   * Each rendered as a small flag above the segment area. Click flag
   * → onMarkerSeek; drag flag → onMarkerMove; × button → onMarkerRemove.
   */
  markers?: Array<{ id: string; srcSec: number; label?: string; color?: string }>;
  onMarkerSeek?: (srcSec: number) => void;
  onMarkerMove?: (id: string, newSrcSec: number) => void;
  onMarkerRemove?: (id: string) => void;
}

interface View {
  /** Left edge of visible region, in effective seconds. */
  offsetSec: number;
  /** Width of visible region, in effective seconds. */
  visibleSec: number;
}

interface SegDrag {
  segIdx: number;
  /**
   * 'start' / 'end' = drag one edge (the small coloured handle).
   * 'move'          = drag the whole segment (grabbed from the body),
   *                   shifting start AND end by the same delta.
   */
  kind: 'start' | 'end' | 'move';
  /** For edge drags: source-time value of the dragged edge right now.
   *  For move drags: the segment's new start right now (end = start + len). */
  previewSrcSec: number;
  /** For move drags: original segment length, kept constant during drag. */
  moveLen?: number;
}

export function HighlightTimeline({
  variant,
  effectiveDuration,
  cutRanges,
  waveform,
  currentTimeSrc,
  isPlaying,
  playingSegIdx,
  onSeek,
  onScrub,
  onSetPlayingSegIdx,
  onResizeSegment,
  onDeleteSegment,
  onMarkRange,
  markers,
  onMarkerSeek,
  onMarkerMove,
  onMarkerRemove,
}: Props): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ offsetSec: 0, visibleSec: 0 });
  const [segDrag, setSegDrag] = useState<SegDrag | null>(null);
  /** True while the user is dragging the playhead. Used to suppress the
   *  click handler that would otherwise also fire seek when mouseup
   *  happens at the same point — and to disable auto-follow during scrub
   *  so the view doesn't fight the user. */
  const [scrubbing, setScrubbing] = useState(false);
  /**
   * Active shift+drag mark in EFFECTIVE seconds. While the user holds
   * shift and drags, this defines the visual rectangle being painted
   * over the timeline. On mouseup the parent commits it via the
   * onMarkRange callback. Null when no shift+drag in progress.
   */
  const [markDrag, setMarkDrag] = useState<
    | { startEff: number; endEff: number }
    | null
  >(null);
  /**
   * Bookmarked view (zoom level + scroll position). Click on the zoom-
   * level chip in the corner overlay to save the current view; click it
   * again from a different view to jump back. Shift+click clears.
   * Persisted in localStorage so the bookmark survives page reload.
   * Null = no bookmark saved yet.
   */
  const [bookmark, setBookmark] = useState<View | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem('lynlens.highlightZoomBookmark');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<View>;
      if (
        typeof parsed.offsetSec === 'number' &&
        typeof parsed.visibleSec === 'number' &&
        parsed.visibleSec > 0
      ) {
        return { offsetSec: parsed.offsetSec, visibleSec: parsed.visibleSec };
      }
    } catch {
      /* ignore */
    }
    return null;
  });
  // Mirror cutRanges + duration into refs so mousemove handlers (registered
  // once per drag, not per render) see fresh values without re-binding.
  const cutRangesRef = useRef<readonly Range[]>(cutRanges);
  const viewRef = useRef<View>(view);
  const sizeRef = useRef<{ w: number; h: number }>(size);
  useEffect(() => {
    cutRangesRef.current = cutRanges;
  }, [cutRanges]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  // Resize observer.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-follow while playing: when the playhead crosses 60% of the
  // visible window, slide the view forward to keep it pinned there.
  // Mirrors the precision Timeline so muscle memory transfers between
  // tabs. Skipped while:
  //   - paused (user is browsing, don't hijack the view)
  //   - dragging a segment edge or the playhead (would fight the user)
  //   - the view already shows the whole video (nothing to scroll past)
  //   - playhead is way off-screen (let lynlens-jump events handle that)
  useEffect(() => {
    if (!isPlaying) return;
    if (segDrag || scrubbing) return;
    if (effectiveDuration <= 0 || view.visibleSec <= 0) return;
    if (view.visibleSec >= effectiveDuration - 0.01) return;
    const playheadEff = sourceToEffective(currentTimeSrc, cutRanges);
    const rel = (playheadEff - view.offsetSec) / view.visibleSec;
    if (rel >= 0 && rel < 0.6) return; // still inside the comfortable zone
    if (rel < 0 || rel > 1.5) {
      // Far off-screen — recenter so the playhead sits ~30% from the left.
      const maxOff = Math.max(0, effectiveDuration - view.visibleSec);
      const desired = Math.max(
        0,
        Math.min(maxOff, playheadEff - view.visibleSec * 0.3)
      );
      if (Math.abs(desired - view.offsetSec) < 0.001) return;
      setView({ ...view, offsetSec: desired });
      return;
    }
    // Inside the right edge zone (60–150%): slide so playhead lands at 60%.
    const desired = Math.max(
      0,
      Math.min(
        effectiveDuration - view.visibleSec,
        playheadEff - view.visibleSec * 0.6
      )
    );
    if (Math.abs(desired - view.offsetSec) < 0.001) return;
    setView({ ...view, offsetSec: desired });
  }, [
    currentTimeSrc,
    isPlaying,
    effectiveDuration,
    view,
    cutRanges,
    segDrag,
    scrubbing,
  ]);

  // Initialise view to "show the whole video" once duration is known.
  // Re-clamp when duration changes (cuts / undo can shrink/grow it).
  const prevDurRef = useRef(0);
  useEffect(() => {
    if (effectiveDuration <= 0) return;
    const prevDur = prevDurRef.current;
    prevDurRef.current = effectiveDuration;
    setView((v) => {
      if (v.visibleSec === 0) return { offsetSec: 0, visibleSec: effectiveDuration };
      const wasFullView = prevDur > 0 && v.offsetSec === 0 && v.visibleSec >= prevDur - 0.01;
      const nextVisible = wasFullView ? effectiveDuration : Math.min(v.visibleSec, effectiveDuration);
      const maxOffset = Math.max(0, effectiveDuration - nextVisible);
      const nextOffset = Math.min(v.offsetSec, maxOffset);
      return { offsetSec: nextOffset, visibleSec: nextVisible };
    });
  }, [effectiveDuration]);

  // ---------- waveform draw ----------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size;
    if (w === 0 || h === 0) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (effectiveDuration <= 0 || view.visibleSec <= 0) return;
    const cy = h / 2;
    if (!waveform || waveform.peak.length === 0) {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, cy - 1, w, 2);
      ctx.fillStyle = '#666';
      ctx.font = '11px sans-serif';
      ctx.fillText('正在生成波形...', 10, cy + 4);
      return;
    }
    const halfH = h * 0.46;
    const peakScale = 1.4;
    const rmsScale = 2.0;
    const { peak, rms } = waveform;
    // Source duration to map source-indexed buckets back through cuts.
    const srcDur = effectiveToSource(effectiveDuration, cutRanges) || effectiveDuration;
    const bucketsPerSec = peak.length / srcDur;
    const peakTops = new Float32Array(w);
    const rmsTops = new Float32Array(w);
    for (let x = 0; x < w; x++) {
      const effA = view.offsetSec + (x / w) * view.visibleSec;
      const effB = view.offsetSec + ((x + 1) / w) * view.visibleSec;
      if (effB < 0 || effA >= effectiveDuration) continue;
      const srcA = effectiveToSource(Math.max(0, effA), cutRanges);
      const srcB = effectiveToSource(Math.min(effectiveDuration, effB), cutRanges);
      const idxA = Math.floor(srcA * bucketsPerSec);
      const idxB = Math.max(idxA + 1, Math.ceil(srcB * bucketsPerSec));
      let p = 0;
      let rSum = 0;
      let count = 0;
      const end = Math.min(idxB, peak.length);
      for (let i = Math.max(0, idxA); i < end; i++) {
        if (peak[i] > p) p = peak[i];
        rSum += rms[i];
        count++;
      }
      const r = count > 0 ? rSum / count : 0;
      peakTops[x] = Math.min(1, p * peakScale) * halfH;
      rmsTops[x] = Math.min(1, r * rmsScale) * halfH;
    }
    // Outer peak
    ctx.fillStyle = '#1f6a5f';
    ctx.beginPath();
    ctx.moveTo(0, cy - peakTops[0]);
    for (let x = 1; x < w; x++) ctx.lineTo(x, cy - peakTops[x]);
    for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, cy + peakTops[x]);
    ctx.closePath();
    ctx.fill();
    // Inner RMS
    ctx.fillStyle = '#4ec9b0';
    ctx.beginPath();
    ctx.moveTo(0, cy - rmsTops[0]);
    for (let x = 1; x < w; x++) ctx.lineTo(x, cy - rmsTops[x]);
    for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, cy + rmsTops[x]);
    ctx.closePath();
    ctx.fill();
    // Subtle baseline + edges
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, cy, w, 1);
  }, [waveform, effectiveDuration, cutRanges, size, view]);

  // ---------- coordinate helpers ----------
  /** Pixel x → effective seconds. */
  const xToEff = useCallback(
    (x: number): number => {
      const { w } = sizeRef.current;
      if (w === 0) return 0;
      return viewRef.current.offsetSec + (x / w) * viewRef.current.visibleSec;
    },
    []
  );
  /** Effective seconds → CSS left % within the timeline. */
  const effToLeftPct = (effSec: number): number => {
    if (view.visibleSec <= 0) return 0;
    return ((effSec - view.offsetSec) / view.visibleSec) * 100;
  };

  // ---------- mousedown: shift+drag = mark, plain click = seek ----------
  // Mirrors the precision Timeline.tsx pattern. Shift+drag paints a
  // range that's committed as a new variant segment on mouseup; plain
  // click (no movement) is a seek; click+drag without shift is no-op
  // (the playhead has its own drag handler).
  const onContainerMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (segDrag || scrubbing) return;
    // Ignore right-click / aux buttons.
    if (e.button !== 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const startX = e.clientX - rect.left;
    const startEff = Math.max(
      0,
      Math.min(effectiveDuration, xToEff(startX))
    );

    if (e.shiftKey && onMarkRange) {
      // SHIFT+drag → mark a range. Bail if there's no variant selected.
      if (!variant) {
        const srcSec = effectiveToSource(startEff, cutRanges);
        onSeek(srcSec);
        return;
      }
      e.preventDefault();
      // CRITICAL: track the latest drag state in a CLOSURE LOCAL, not
      // inside a setState updater. React 18 StrictMode runs updater
      // functions twice in dev to catch impurity — putting onMarkRange()
      // inside `setMarkDrag(d => {...; onMarkRange(); return null})`
      // makes it fire TWICE per drag, creating duplicate segments
      // (user reported "shift 拖一次, 会生成两个"). Side effects must
      // live OUTSIDE the updater.
      let latest = { startEff, endEff: startEff };
      setMarkDrag(latest);
      const move = (ev: MouseEvent): void => {
        const x = ev.clientX - rect.left;
        const eff = Math.max(0, Math.min(effectiveDuration, xToEff(x)));
        latest = { startEff, endEff: eff };
        setMarkDrag(latest);
      };
      const up = (): void => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        setMarkDrag(null);
        const a = Math.min(latest.startEff, latest.endEff);
        const b = Math.max(latest.startEff, latest.endEff);
        // Require ≥ 0.1s of drag — anything less is a misclick.
        if (b - a >= 0.1) {
          const srcA = effectiveToSource(a, cutRanges);
          const srcB = effectiveToSource(b, cutRanges);
          onMarkRange(srcA, srcB);
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }

    // No shift → plain click-to-seek. Use mouseup on the container so
    // we don't fight the playhead-drag handler (which has its own
    // mousedown on the playhead element + stopPropagation).
    const srcSec = effectiveToSource(startEff, cutRanges);
    onSeek(srcSec);
    if (variant) {
      for (let i = 0; i < variant.segments.length; i++) {
        const s = variant.segments[i];
        if (srcSec >= s.start && srcSec < s.end) {
          onSetPlayingSegIdx(i);
          break;
        }
      }
    }
  };

  // ---------- playhead drag (scrub) ----------
  // Press the playhead knob → live-scrub video.currentTime on mousemove.
  // Mirrors how a desktop editor's timeline plays the frame under your
  // cursor as you drag. Stops the click-to-seek handler from also firing
  // by setting `scrubbing` (checked in onContainerClick).
  //
  // Auto-pan: when the cursor approaches the left/right edge of the
  // visible window (within EDGE_PCT of the bar width), pan the view in
  // that direction so the user can keep dragging past the current visible
  // range. Pan rate scales with how far INTO the edge zone the cursor is,
  // up to MAX_PAN_PX/frame. Mirrors the precision Timeline's behaviour.
  const startPlayheadDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    setScrubbing(true);
    const EDGE_PCT = 0.08;
    const MAX_PAN_PX = 18; // per frame
    let lastClientX = e.clientX;
    let panRaf = 0;
    const seekFromX = (clientX: number): void => {
      const rect = container.getBoundingClientRect();
      const effSec = Math.max(
        0,
        Math.min(
          effectiveDuration,
          viewRef.current.offsetSec +
            ((clientX - rect.left) / sizeRef.current.w) *
              viewRef.current.visibleSec
        )
      );
      const srcSec = effectiveToSource(effSec, cutRangesRef.current);
      (onScrub ?? onSeek)(srcSec);
    };
    const tick = (): void => {
      const rect = container.getBoundingClientRect();
      const w = sizeRef.current.w;
      const visible = viewRef.current.visibleSec;
      const maxOffset = Math.max(0, effectiveDuration - visible);
      // Distance from each edge in [0, 1].
      const xInBar = lastClientX - rect.left;
      const leftEdge = xInBar / w;
      const rightEdge = (w - xInBar) / w;
      let panPx = 0;
      if (leftEdge < EDGE_PCT) {
        const ratio = Math.max(0, (EDGE_PCT - leftEdge) / EDGE_PCT);
        panPx = -ratio * MAX_PAN_PX;
      } else if (rightEdge < EDGE_PCT) {
        const ratio = Math.max(0, (EDGE_PCT - rightEdge) / EDGE_PCT);
        panPx = ratio * MAX_PAN_PX;
      }
      if (panPx !== 0 && visible > 0 && visible < effectiveDuration) {
        const panSec = panPx * (visible / w);
        const nextOffset = Math.max(
          0,
          Math.min(maxOffset, viewRef.current.offsetSec + panSec)
        );
        if (nextOffset !== viewRef.current.offsetSec) {
          setView({ ...viewRef.current, offsetSec: nextOffset });
        }
        // After the view shifts, re-seek using the same cursor X — that
        // pixel now maps to a different effective second, which is the
        // whole point: the playhead "drags" the view along.
        seekFromX(lastClientX);
      }
      panRaf = requestAnimationFrame(tick);
    };
    panRaf = requestAnimationFrame(tick);
    const onMove = (ev: MouseEvent): void => {
      lastClientX = ev.clientX;
      seekFromX(ev.clientX);
    };
    const onUp = (): void => {
      cancelAnimationFrame(panRaf);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // Defer scrubbing=false so the post-mouseup click is still suppressed.
      setTimeout(() => setScrubbing(false), 0);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---------- wheel: zoom (Cmd/Ctrl+wheel) or pan (plain wheel) ----------
  const onWheel = (e: React.WheelEvent<HTMLDivElement>): void => {
    if (effectiveDuration <= 0) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom around the pointer position.
      const rect = e.currentTarget.getBoundingClientRect();
      const anchorFrac = (e.clientX - rect.left) / rect.width; // 0..1
      const anchorEff = view.offsetSec + anchorFrac * view.visibleSec;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const nextVisible = Math.max(
        0.5,
        Math.min(effectiveDuration, view.visibleSec * factor)
      );
      const nextOffset = Math.max(
        0,
        Math.min(
          effectiveDuration - nextVisible,
          anchorEff - anchorFrac * nextVisible
        )
      );
      setView({ offsetSec: nextOffset, visibleSec: nextVisible });
    } else {
      // Pan horizontally — delta scaled by visible window so feel is consistent.
      const panSec = (e.deltaY + e.deltaX) * (view.visibleSec / size.w);
      const maxOffset = Math.max(0, effectiveDuration - view.visibleSec);
      setView({
        ...view,
        offsetSec: Math.max(0, Math.min(maxOffset, view.offsetSec + panSec)),
      });
    }
  };

  // ---------- segment drag (edge resize OR whole-segment move) ----------
  // Edge drag: handle on left/right of a segment shifts THAT edge.
  // Move drag: pressing the segment BODY grabs the whole range and
  // shifts both edges by the same delta (length preserved). When one
  // edge hits a video boundary we clamp the whole segment instead of
  // letting it deform.
  const startEdgeDrag = (
    e: React.MouseEvent,
    segIdx: number,
    edge: 'start' | 'end'
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!variant) return;
    const seg = variant.segments[segIdx];
    const initialSrc = edge === 'start' ? seg.start : seg.end;
    setSegDrag({ segIdx, kind: edge, previewSrcSec: initialSrc });
    const container = containerRef.current;
    if (!container) return;
    const onMove = (ev: MouseEvent): void => {
      const rect = container.getBoundingClientRect();
      const effSec = Math.max(
        0,
        Math.min(
          effectiveDuration,
          viewRef.current.offsetSec +
            ((ev.clientX - rect.left) / sizeRef.current.w) *
              viewRef.current.visibleSec
        )
      );
      const srcSec = effectiveToSource(effSec, cutRangesRef.current);
      setSegDrag((cur) => (cur ? { ...cur, previewSrcSec: srcSec } : null));
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setSegDrag((cur) => {
        if (!cur || !variant) return null;
        const s = variant.segments[cur.segIdx];
        let newStart = s.start;
        let newEnd = s.end;
        if (cur.kind === 'start') newStart = cur.previewSrcSec;
        else if (cur.kind === 'end') newEnd = cur.previewSrcSec;
        if (Math.abs(cur.previewSrcSec - (cur.kind === 'start' ? s.start : s.end)) >= 0.02) {
          onResizeSegment(cur.segIdx, newStart, newEnd);
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /**
   * Grab the segment body to MOVE the whole range. Preserves length;
   * clamps when an edge hits [0, videoDuration] so the segment slides
   * along the boundary instead of stretching. Click-without-drag (< 3px
   * total movement + < 250ms) is treated as a "select this segment"
   * click — bubbles to the container's click handler so the playhead
   * jumps inside the segment.
   */
  const startMoveDrag = (e: React.MouseEvent, segIdx: number): void => {
    if (!variant) return;
    // Only react to plain left-click on the body. Right-click / modifier
    // clicks pass through (could be wired to context menu later).
    if (e.button !== 0) return;
    const seg = variant.segments[segIdx];
    const len = seg.end - seg.start;
    const downX = e.clientX;
    const downT = Date.now();
    const container = containerRef.current;
    if (!container) return;
    const rect0 = container.getBoundingClientRect();
    const anchorEff =
      viewRef.current.offsetSec +
      ((downX - rect0.left) / sizeRef.current.w) * viewRef.current.visibleSec;
    const anchorSrc = effectiveToSource(anchorEff, cutRangesRef.current);
    /** Offset from segment.start at the time we pressed down, in src sec. */
    const grabOffset = anchorSrc - seg.start;
    /** Source-time duration of the video (used to clamp). */
    const videoSrcDur = effectiveToSource(effectiveDuration, cutRangesRef.current);
    let moved = false;
    e.preventDefault();
    e.stopPropagation();
    const onMove = (ev: MouseEvent): void => {
      if (!moved && Math.abs(ev.clientX - downX) < 3) return;
      moved = true;
      const rect = container.getBoundingClientRect();
      const effSec = Math.max(
        0,
        Math.min(
          effectiveDuration,
          viewRef.current.offsetSec +
            ((ev.clientX - rect.left) / sizeRef.current.w) *
              viewRef.current.visibleSec
        )
      );
      const srcSec = effectiveToSource(effSec, cutRangesRef.current);
      // Desired new start = where the cursor is, minus where we grabbed
      // INSIDE the segment when drag started.
      let nextStart = srcSec - grabOffset;
      // Clamp so segment stays inside [0, videoSrcDur].
      nextStart = Math.max(0, Math.min(videoSrcDur - len, nextStart));
      setSegDrag({
        segIdx,
        kind: 'move',
        previewSrcSec: nextStart,
        moveLen: len,
      });
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const dt = Date.now() - downT;
      setSegDrag((cur) => {
        // No real drag → treat as a normal click on the body (let parent's
        // onContainerClick handle it via re-dispatch). We skip dispatching
        // the resize and let the click bubble.
        if (!cur || !moved || cur.kind !== 'move' || dt < 80) {
          return null;
        }
        const s = variant.segments[cur.segIdx];
        const newStart = cur.previewSrcSec;
        const newEnd = newStart + (cur.moveLen ?? s.end - s.start);
        if (Math.abs(newStart - s.start) >= 0.02) {
          onResizeSegment(cur.segIdx, newStart, newEnd);
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // ---------- zoom controls ----------
  const zoomBy = (factor: number): void => {
    if (effectiveDuration <= 0) return;
    const center = view.offsetSec + view.visibleSec / 2;
    const nextVisible = Math.max(
      0.5,
      Math.min(effectiveDuration, view.visibleSec * factor)
    );
    const nextOffset = Math.max(
      0,
      Math.min(effectiveDuration - nextVisible, center - nextVisible / 2)
    );
    setView({ offsetSec: nextOffset, visibleSec: nextVisible });
  };

  const zoomToFit = (): void => {
    setView({ offsetSec: 0, visibleSec: effectiveDuration });
  };

  /**
   * Click the zoom-level chip → save current view as bookmark (if none)
   * OR jump to bookmark (if we're not at it). Shift+click clears the
   * bookmark. The chip glows when a bookmark exists and is "armed"
   * (current view ≠ bookmark) so the user knows clicking will jump.
   *
   * Persists to localStorage so bookmarks survive reload — power users
   * usually settle on one "preferred zoom" for editing.
   */
  const isAtBookmark = (): boolean => {
    if (!bookmark) return false;
    return (
      Math.abs(bookmark.visibleSec - view.visibleSec) < 0.01 &&
      Math.abs(bookmark.offsetSec - view.offsetSec) < 0.01
    );
  };
  const saveBookmark = (next: View | null): void => {
    setBookmark(next);
    try {
      if (next) {
        window.localStorage.setItem(
          'lynlens.highlightZoomBookmark',
          JSON.stringify(next)
        );
      } else {
        window.localStorage.removeItem('lynlens.highlightZoomBookmark');
      }
    } catch {
      /* ignore quota errors */
    }
  };
  const onZoomChipClick = (e: React.MouseEvent): void => {
    if (e.shiftKey) {
      saveBookmark(null);
      return;
    }
    if (!bookmark) {
      saveBookmark({ ...view });
      return;
    }
    if (isAtBookmark()) {
      // Already at bookmark — re-save as a no-op (cheap, lets the user
      // "update" the bookmark by clicking when they want it pinned to
      // a slightly tweaked view).
      saveBookmark({ ...view });
      return;
    }
    // Different view → jump to bookmark. Clamp to current duration in case
    // a cut shrunk it since the bookmark was saved.
    const visible = Math.min(effectiveDuration, Math.max(0.5, bookmark.visibleSec));
    const offset = Math.max(
      0,
      Math.min(effectiveDuration - visible, bookmark.offsetSec)
    );
    setView({ offsetSec: offset, visibleSec: visible });
  };

  // ---------- render ----------
  const segments = variant?.segments ?? [];
  const playheadEff = sourceToEffective(currentTimeSrc, cutRanges);
  const playheadVisible =
    playheadEff >= view.offsetSec && playheadEff <= view.offsetSec + view.visibleSec;
  const zoomLevel = effectiveDuration > 0
    ? Math.round((effectiveDuration / view.visibleSec) * 100) / 100
    : 1;

  return (
    <div className="hl-timeline">
      <div
        className="hl-timeline-canvas-wrap"
        ref={containerRef}
        onMouseDown={onContainerMouseDown}
        onWheel={onWheel}
        title={
          variant && onMarkRange
            ? '点击跳到该位置 · Shift+拖动 = 给当前变体加一段'
            : '点击跳到该位置'
        }
      >
        <canvas ref={canvasRef} className="hl-timeline-canvas" />
        {/* Timeline markers (Premiere-style bookmarks). Small flag at
            each marker's source-time position. Hover shows tooltip +
            × delete button. Drag the flag body to reposition. */}
        {markers && markers.length > 0 && markers.map((m) => {
          const effSec = sourceToEffective(m.srcSec, cutRanges);
          if (effSec < view.offsetSec || effSec > view.offsetSec + view.visibleSec) {
            return null; // off-screen, skip render
          }
          const leftPct = effToLeftPct(effSec);
          return (
            <TimelineMarker
              key={m.id}
              marker={m}
              leftPct={leftPct}
              containerRef={containerRef}
              xToEff={xToEff}
              cutRanges={cutRanges}
              effectiveDuration={effectiveDuration}
              onMarkerSeek={onMarkerSeek}
              onMarkerMove={onMarkerMove}
              onMarkerRemove={onMarkerRemove}
            />
          );
        })}
        {/* Shift+drag visual feedback: translucent amber rect over the
            range being marked. Disappears on mouseup (when markDrag is
            cleared). Pointer-events: none so it doesn't eat the
            mousemove the drag handler is listening for. */}
        {markDrag && (() => {
          const a = Math.min(markDrag.startEff, markDrag.endEff);
          const b = Math.max(markDrag.startEff, markDrag.endEff);
          const leftPct = effToLeftPct(a);
          const widthPct = effToLeftPct(b) - leftPct;
          return (
            <div
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: 0,
                bottom: 0,
                width: `${widthPct}%`,
                background: 'rgba(243, 156, 18, 0.25)',
                border: '1.5px solid rgba(243, 156, 18, 0.9)',
                pointerEvents: 'none',
                zIndex: 5,
              }}
            />
          );
        })()}
        {/* Shared zoom-controls overlay (.tl-zoom-*) — used by both this
            timeline and the precision tab's Timeline.
            Wrapper-level stopPropagation: without it, any click in the
            zoom bar bubbled up to the container's onContainerClick →
            onSeek(srcSec) → video jumped to wherever on the timeline
            the chip happened to sit (user saw it as "auto-play to
            random position"). */}
        <div
          className="tl-zoom-controls"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            className="tl-zoom-btn"
            onClick={() => zoomBy(1 / 1.5)}
            title="放大 (⌘+滚轮)"
            disabled={view.visibleSec <= 1}
          >
            +
          </button>
          <button
            className={`tl-zoom-chip${
              bookmark ? ' has-bookmark' : ''
            }${bookmark && isAtBookmark() ? ' at-bookmark' : ''}`}
            onClick={onZoomChipClick}
            title={
              !bookmark
                ? '点击记住当前缩放/位置 (再点回到这里;Shift+点击清除)'
                : isAtBookmark()
                  ? '已在书签位置·再点更新书签到当前视图;Shift+点击清除'
                  : `点击回到书签位置 (${(effectiveDuration > 0 ? effectiveDuration / bookmark.visibleSec : 1).toFixed(1)}×);Shift+点击清除`
            }
          >
            {bookmark && <span className="tl-zoom-pin">📌</span>}
            {zoomLevel.toFixed(1)}×
          </button>
          <button
            className="tl-zoom-btn"
            onClick={() => zoomBy(1.5)}
            title="缩小"
            disabled={view.visibleSec >= effectiveDuration}
          >
            −
          </button>
          <button
            className="tl-zoom-btn"
            onClick={zoomToFit}
            title="适应屏幕"
            disabled={view.visibleSec >= effectiveDuration - 0.01}
          >
            ⇱⇲
          </button>
        </div>
        {/* Segment overlays */}
        {segments.map((s, i) => {
          // Use drag preview while this segment is being dragged. Three
          // cases: edge=start (shift left edge), edge=end (shift right),
          // kind=move (shift both edges by the same delta preserving len).
          const isDragging = segDrag != null && segDrag.segIdx === i;
          let dragStart = s.start;
          let dragEnd = s.end;
          if (isDragging) {
            if (segDrag.kind === 'start') dragStart = segDrag.previewSrcSec;
            else if (segDrag.kind === 'end') dragEnd = segDrag.previewSrcSec;
            else if (segDrag.kind === 'move') {
              dragStart = segDrag.previewSrcSec;
              dragEnd = dragStart + (segDrag.moveLen ?? s.end - s.start);
            }
          }
          const effStart = sourceToEffective(dragStart, cutRanges);
          const effEnd = sourceToEffective(dragEnd, cutRanges);
          const leftPct = effToLeftPct(effStart);
          const widthPct = effToLeftPct(effEnd) - leftPct;
          if (widthPct <= 0) return null;
          if (leftPct > 100 || leftPct + widthPct < 0) return null; // off-screen
          return (
            <div
              key={i}
              className={`hl-timeline-seg${i === playingSegIdx ? ' current' : ''}${
                isDragging ? ' dragging' : ''
              }`}
              style={{ left: `${leftPct}%`, width: `${Math.max(0.6, widthPct)}%` }}
              title={`#${i + 1} ${formatTime(effStart)} – ${formatTime(effEnd)}`}
            >
              <div
                className="hl-timeline-seg-handle left"
                onMouseDown={(e) => startEdgeDrag(e, i, 'start')}
                title="拖拽调整起点"
              />
              <div
                className="hl-timeline-seg-body"
                onMouseDown={(e) => startMoveDrag(e, i)}
                title="按住拖动整段·或拖两端调长度"
              >
                <span className="hl-timeline-seg-idx">#{i + 1}</span>
                <span className="hl-timeline-seg-time">
                  {formatTime(effStart)} – {formatTime(effEnd)}
                </span>
                {segments.length > 1 && (
                  <button
                    className="hl-timeline-seg-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteSegment(i);
                    }}
                    title="删除这一段"
                  >
                    ×
                  </button>
                )}
              </div>
              <div
                className="hl-timeline-seg-handle right"
                onMouseDown={(e) => startEdgeDrag(e, i, 'end')}
                title="拖拽调整终点"
              />
            </div>
          );
        })}
        {/* Playhead — draggable for scrub. The knob (::before) is the
            actual grab target; clicking the thin line (covered by knob's
            negative-space-hit area) starts a drag too. While dragging,
            the click-to-seek handler is suppressed via `scrubbing`. */}
        {playheadVisible && view.visibleSec > 0 && (
          <div
            className={`hl-timeline-playhead${scrubbing ? ' scrubbing' : ''}`}
            style={{ left: `${effToLeftPct(playheadEff)}%` }}
            onMouseDown={startPlayheadDrag}
            title="拖动滚动播放头"
          />
        )}
      </div>
    </div>
  );
}

/**
 * One Premiere-style flag on the timeline. Renders as a small triangle
 * + colored stem at the marker's X position. Click body = seek; drag
 * body = move (commits on mouseup); × button (on hover) = delete.
 */
function TimelineMarker({
  marker,
  leftPct,
  containerRef,
  xToEff,
  cutRanges,
  effectiveDuration,
  onMarkerSeek,
  onMarkerMove,
  onMarkerRemove,
}: {
  marker: { id: string; srcSec: number; label?: string; color?: string };
  leftPct: number;
  containerRef: React.RefObject<HTMLDivElement | null>;
  xToEff: (px: number) => number;
  cutRanges: readonly Range[];
  effectiveDuration: number;
  onMarkerSeek?: (srcSec: number) => void;
  onMarkerMove?: (id: string, newSrcSec: number) => void;
  onMarkerRemove?: (id: string) => void;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  /**
   * Live drag position as a left-% across the bar. Non-null only while the
   * user is dragging this flag — overrides the committed `leftPct` prop so
   * the marker FOLLOWS THE CURSOR in real time (跟手) instead of snapping to
   * the new spot only on mouseup. Cleared on release.
   */
  const [dragLeftPct, setDragLeftPct] = useState<number | null>(null);
  const accent = marker.color ?? '#7aa2f7';

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    if (!onMarkerMove) {
      // No move handler → treat as plain click-to-seek.
      onMarkerSeek?.(marker.srcSec);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const startClientX = e.clientX;
    let moved = false;
    let latestSrcSec = marker.srcSec;
    const move = (ev: MouseEvent): void => {
      const dx = Math.abs(ev.clientX - startClientX);
      if (!moved && dx < 3) return; // jitter threshold
      moved = true;
      const rect = container.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      // Follow the cursor: the flag's left-% IS the cursor's % across the bar
      // (equals effToLeftPct(eff) by construction — no view math needed here).
      setDragLeftPct(Math.max(0, Math.min(100, (x / rect.width) * 100)));
      const eff = Math.max(0, Math.min(effectiveDuration, xToEff(x)));
      // Markers are stored in source time. Use the real ripple conversion —
      // a hand-rolled loop here mis-placed markers sitting after multiple cuts.
      latestSrcSec = effectiveToSource(eff, cutRanges);
    };
    const up = (): void => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDragLeftPct(null);
      if (moved) {
        onMarkerMove(marker.id, latestSrcSec);
      } else {
        onMarkerSeek?.(marker.srcSec);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'absolute',
        left: `${dragLeftPct ?? leftPct}%`,
        top: 0,
        bottom: 0,
        width: 2,
        background: accent,
        pointerEvents: 'auto',
        zIndex: dragLeftPct != null ? 7 : 6,
        transform: 'translateX(-50%)',
      }}
    >
      {/* Flag head at the top — triangle pointing down */}
      <div
        onMouseDown={startDrag}
        title={
          marker.label
            ? `🏷️ ${marker.label} · 点击跳到 · 拖动移动`
            : `🏷️ ${formatSrcTime(marker.srcSec)} · 点击跳到 · 拖动移动`
        }
        style={{
          position: 'absolute',
          top: -2,
          left: '50%',
          transform: 'translateX(-50%)',
          width: 12,
          height: 14,
          background: accent,
          clipPath: 'polygon(0 0, 100% 0, 100% 60%, 50% 100%, 0 60%)',
          cursor: 'grab',
          pointerEvents: 'auto',
        }}
      />
      {/* Hover × delete button */}
      {hover && onMarkerRemove && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMarkerRemove(marker.id);
          }}
          title="删除标签"
          style={{
            position: 'absolute',
            top: 14,
            left: '50%',
            transform: 'translateX(-50%)',
            width: 16,
            height: 16,
            border: 'none',
            borderRadius: 8,
            background: '#222',
            color: '#fff',
            fontSize: 10,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/** Formatter for marker tooltips. m:ss.cs at 100ms precision. */
function formatSrcTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = s - m * 60;
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
}
