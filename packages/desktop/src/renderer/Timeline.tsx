import { useEffect, useRef, useState } from 'react';
import type { Segment, Transcript } from '@lynlens/core';
import { formatTime } from './util';

interface TimelineProps {
  duration: number;
  currentTime: number;
  waveform: { peak: Float32Array; rms: Float32Array } | null;
  segments: Segment[];
  transcript: Transcript | null;
  /** Plain click: just seek the playhead (no playback). */
  onSeek: (time: number) => void;
  /** Plain drag: scrub (video follows mouse live). Start → update → end. */
  onScrubStart: (time: number) => void;
  onScrubUpdate: (time: number) => void;
  onScrubEnd: () => void;
  /** Shift+drag: add a delete-mark region. */
  onMarkRange: (start: number, end: number) => void;
  /** Ctrl+drag: erase any existing marks in this range. */
  onEraseRange: (start: number, end: number) => void;
  /** Drag segment edge or body to adjust its start/end. Called on release. */
  onResizeSegment: (id: string, start: number, end: number) => void;
}

interface View {
  offsetSec: number;
  visibleSec: number;
}

export function Timeline(props: TimelineProps) {
  const {
    duration,
    currentTime,
    waveform,
    segments,
    transcript,
    onSeek,
    onScrubStart,
    onScrubUpdate,
    onScrubEnd,
    onMarkRange,
    onEraseRange,
    onResizeSegment,
  } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ offsetSec: 0, visibleSec: 0 });
  const viewRef = useRef<View>(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  const [dragging, setDragging] = useState<{ startSec: number; endSec: number } | null>(null);
  /** Live preview of a segment being resized/moved; committed to IPC on mouseup. */
  const [segDrag, setSegDrag] = useState<
    | { id: string; kind: 'resize-left' | 'resize-right' | 'move'; start: number; end: number }
    | null
  >(null);
  const [hoverCursor, setHoverCursor] = useState<'default' | 'ew-resize' | 'grab'>('default');

  // initialize view once duration becomes known
  useEffect(() => {
    if (duration > 0 && view.visibleSec === 0) {
      setView({ offsetSec: 0, visibleSec: duration });
    }
  }, [duration]);

  // Resize canvas to container pixel ratio
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Redraw whenever any input changes
  useEffect(() => {
    draw();
  });

  function pxToSec(px: number): number {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const w = canvas.clientWidth;
    if (w <= 0 || !Number.isFinite(view.visibleSec) || view.visibleSec <= 0) return 0;
    return view.offsetSec + (px / w) * view.visibleSec;
  }

  function secToPx(sec: number): number {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const w = canvas.clientWidth;
    if (w <= 0 || view.visibleSec <= 0) return 0;
    return ((sec - view.offsetSec) / view.visibleSec) * w;
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);

    if (duration <= 0 || view.visibleSec <= 0) return;

    // Layout: [waveform | subtitle strip (22px if transcript) | time scale (24px)]
    const subtitleHeight = transcript && transcript.segments.length > 0 ? 22 : 0;
    const scaleHeight = 24;
    const waveHeight = h - subtitleHeight - scaleHeight;
    const cy = waveHeight / 2;

    // --- waveform (peak outer + rms inner, filled polygons) ---
    if (waveform && waveform.peak.length > 0) {
      const halfH = waveHeight * 0.46;
      const peakScale = 1.4;
      const rmsScale = 2.0;
      const { peak, rms } = waveform;
      const bucketsPerSec = peak.length / duration;
      const peakTops = new Float32Array(w);
      const rmsTops = new Float32Array(w);

      for (let x = 0; x < w; x++) {
        const secA = view.offsetSec + (x / w) * view.visibleSec;
        const secB = view.offsetSec + ((x + 1) / w) * view.visibleSec;
        if (secB < 0 || secA >= duration) continue;
        const aClamped = Math.max(0, secA);
        const bClamped = Math.min(duration, secB);
        const idxA = Math.floor(aClamped * bucketsPerSec);
        const idxB = Math.max(idxA + 1, Math.ceil(bClamped * bucketsPerSec));
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

      // Outer envelope (peak) — darker teal fill
      ctx.fillStyle = '#1f6a5f';
      ctx.beginPath();
      ctx.moveTo(0, cy - peakTops[0]);
      for (let x = 1; x < w; x++) ctx.lineTo(x, cy - peakTops[x]);
      for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, cy + peakTops[x]);
      ctx.closePath();
      ctx.fill();

      // Crisp 1px outer stroke so transient peaks are visible even as hairline.
      ctx.strokeStyle = '#4ec9b0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, cy - peakTops[0]);
      for (let x = 1; x < w; x++) ctx.lineTo(x, cy - peakTops[x]);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, cy + peakTops[0]);
      for (let x = 1; x < w; x++) ctx.lineTo(x, cy + peakTops[x]);
      ctx.stroke();

      // Inner envelope (RMS = perceived loudness) — brighter fill
      ctx.fillStyle = '#4ec9b0';
      ctx.beginPath();
      ctx.moveTo(0, cy - rmsTops[0]);
      for (let x = 1; x < w; x++) ctx.lineTo(x, cy - rmsTops[x]);
      for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, cy + rmsTops[x]);
      ctx.closePath();
      ctx.fill();

      // Center baseline
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, cy, w, 1);
    } else {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, cy - 1, w, 2);
      ctx.fillStyle = '#666';
      ctx.font = '11px sans-serif';
      ctx.fillText('正在生成波形...', 10, cy + 4);
    }

    // --- segments ---
    for (const seg of segments) {
      // If this segment is currently being dragged, use the live preview values
      const dragActive = segDrag && segDrag.id === seg.id;
      const segStart = dragActive ? segDrag!.start : seg.start;
      const segEnd = dragActive ? segDrag!.end : seg.end;
      const x1 = secToPx(segStart);
      const x2 = secToPx(segEnd);
      if (x2 < 0 || x1 > w) continue;
      const clampedX1 = Math.max(0, x1);
      const clampedX2 = Math.min(w, x2);
      let color: string;
      if (seg.status === 'rejected') color = 'rgba(136,136,136,0.3)';
      else if (seg.source === 'ai' && seg.status === 'pending')
        color = 'rgba(155,89,182,0.5)';
      else color = 'rgba(255,74,74,0.55)';
      ctx.fillStyle = color;
      ctx.fillRect(clampedX1, 0, clampedX2 - clampedX1, waveHeight);
      ctx.strokeStyle = seg.source === 'ai' && seg.status === 'pending'
        ? 'rgba(155,89,182,0.9)'
        : 'rgba(255,74,74,0.9)';
      ctx.lineWidth = dragActive ? 2 : 1;
      ctx.strokeRect(clampedX1 + 0.5, 0.5, clampedX2 - clampedX1 - 1, waveHeight - 1);
      // Edge resize handles — small vertical bars on inside of each edge,
      // visible when segment is wide enough.
      if (clampedX2 - clampedX1 > 12) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.fillRect(clampedX1 + 2, waveHeight * 0.2, 2, waveHeight * 0.6);
        ctx.fillRect(clampedX2 - 4, waveHeight * 0.2, 2, waveHeight * 0.6);
      }
    }

    // --- drag selection ---
    if (dragging) {
      const x1 = secToPx(Math.min(dragging.startSec, dragging.endSec));
      const x2 = secToPx(Math.max(dragging.startSec, dragging.endSec));
      ctx.fillStyle = 'rgba(14,122,254,0.3)';
      ctx.fillRect(x1, 0, x2 - x1, waveHeight);
      ctx.strokeStyle = 'rgba(14,122,254,0.9)';
      ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, waveHeight - 1);
    }

    // --- subtitle strip ---
    if (subtitleHeight > 0 && transcript) {
      ctx.fillStyle = '#1f1f1f';
      ctx.fillRect(0, waveHeight, w, subtitleHeight);
      ctx.strokeStyle = '#333';
      ctx.beginPath();
      ctx.moveTo(0, waveHeight + 0.5);
      ctx.lineTo(w, waveHeight + 0.5);
      ctx.stroke();

      ctx.font = '11px sans-serif';
      ctx.textBaseline = 'middle';
      const midY = waveHeight + subtitleHeight / 2;
      for (const tseg of transcript.segments) {
        const x1 = secToPx(tseg.start);
        const x2 = secToPx(tseg.end);
        if (x2 < 0 || x1 > w) continue;
        const clampedX1 = Math.max(0, x1);
        const clampedX2 = Math.min(w, x2);
        const width = clampedX2 - clampedX1;
        if (width < 2) continue;
        // Dim any subtitle that falls inside an approved delete-segment
        const inDelete = segments.some(
          (s) => s.status === 'approved' && tseg.start >= s.start && tseg.end <= s.end
        );
        // Alternating background so adjacent segments are distinguishable
        ctx.fillStyle = inDelete ? 'rgba(80,80,80,0.25)' : 'rgba(80,130,180,0.2)';
        ctx.fillRect(clampedX1, waveHeight + 2, width, subtitleHeight - 4);
        // Text (truncated)
        ctx.fillStyle = inDelete ? '#666' : '#d8d8d8';
        ctx.save();
        ctx.beginPath();
        ctx.rect(clampedX1 + 3, waveHeight, Math.max(0, width - 6), subtitleHeight);
        ctx.clip();
        const decoration = inDelete ? '(已删) ' : '';
        ctx.fillText(decoration + tseg.text.trim(), clampedX1 + 5, midY);
        ctx.restore();
      }
    }

    // --- time scale ---
    const scaleY = waveHeight + subtitleHeight;
    ctx.fillStyle = '#252526';
    ctx.fillRect(0, scaleY, w, scaleHeight);
    ctx.strokeStyle = '#444';
    ctx.beginPath();
    ctx.moveTo(0, scaleY + 0.5);
    ctx.lineTo(w, scaleY + 0.5);
    ctx.stroke();

    const tickSpacing = pickTickSpacing(view.visibleSec, w);
    ctx.fillStyle = '#aaa';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'alphabetic';
    const firstTick = Math.ceil(view.offsetSec / tickSpacing) * tickSpacing;
    for (let t = firstTick; t < view.offsetSec + view.visibleSec; t += tickSpacing) {
      const x = secToPx(t);
      ctx.fillRect(x, scaleY, 1, 6);
      ctx.fillText(formatTime(t), x + 2, scaleY + 16);
    }

    // --- playhead ---
    const px = secToPx(currentTime);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = '#ff3131';
      ctx.fillRect(px - 1, 0, 2, h);
    }
  }

  function pickTickSpacing(visibleSec: number, canvasWidth: number): number {
    const minPx = 70;
    const secPerPx = visibleSec / canvasWidth;
    const raw = secPerPx * minPx;
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800, 3600];
    for (const c of candidates) if (c >= raw) return c;
    return 3600;
  }

  // Native wheel handler attached with { passive: false } so preventDefault works.
  // React's synthetic onWheel is attached as passive by default in Chromium.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (duration <= 0) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();

      // Ctrl/Cmd + wheel => zoom (anchored at mouse)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const px = e.clientX - rect.left;
        const anchorSec = pxToSec(px);
        const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
        const newVisible = Math.max(0.2, Math.min(duration, view.visibleSec * factor));
        let newOffset = anchorSec - (px / rect.width) * newVisible;
        newOffset = Math.max(0, Math.min(duration - newVisible, newOffset));
        setView({ offsetSec: newOffset, visibleSec: newVisible });
        return;
      }

      // Alt + wheel => horizontal pan
      if (e.altKey) {
        e.preventDefault();
        // deltaY > 0 (scroll down) pans forward in time
        const secPerPx = view.visibleSec / rect.width;
        const delta = e.deltaY * secPerPx * 2;
        const newOffset = Math.max(
          0,
          Math.min(Math.max(0, duration - view.visibleSec), view.offsetSec + delta)
        );
        setView({ offsetSec: newOffset, visibleSec: view.visibleSec });
        return;
      }

      // Plain wheel => no action (caller's page scroll is also none here)
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [duration, view]);

  /**
   * Convert a mouse X (relative to canvas) to seconds using the LATEST view
   * state (read from viewRef, not a closed-over render snapshot). Used inside
   * long-lived mouse drag loops so conversions stay correct as the view
   * auto-pans.
   */
  function mouseXToSec(xPx: number, canvasW: number): number {
    const v = viewRef.current;
    if (canvasW <= 0 || v.visibleSec <= 0) return 0;
    return v.offsetSec + (xPx / canvasW) * v.visibleSec;
  }

  /**
   * Detect whether the mouse at `xPx` (canvas space) is over a segment's left
   * edge, right edge, or body. Rejected segments are ignored.
   */
  function hitTestSegment(xPx: number, canvasW: number):
    | { segId: string; kind: 'resize-left' | 'resize-right' | 'move'; start: number; end: number }
    | null {
    const HANDLE = 6;
    for (const s of segments) {
      if (s.status === 'rejected') continue;
      const sx = ((s.start - viewRef.current.offsetSec) / viewRef.current.visibleSec) * canvasW;
      const ex = ((s.end - viewRef.current.offsetSec) / viewRef.current.visibleSec) * canvasW;
      if (Math.abs(xPx - sx) <= HANDLE) {
        return { segId: s.id, kind: 'resize-left', start: s.start, end: s.end };
      }
      if (Math.abs(xPx - ex) <= HANDLE) {
        return { segId: s.id, kind: 'resize-right', start: s.start, end: s.end };
      }
      if (xPx > sx + HANDLE && xPx < ex - HANDLE) {
        return { segId: s.id, kind: 'move', start: s.start, end: s.end };
      }
    }
    return null;
  }

  function onMouseDown(e: React.MouseEvent) {
    if (duration <= 0 || e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const startX = e.clientX - rect.left;
    const startSec = clampSec(mouseXToSec(startX, rect.width));
    const shift = e.shiftKey;
    const ctrl = e.ctrlKey || e.metaKey;

    const EDGE = 50;
    let currentX = startX;
    let moved = false;

    // Shared RAF: (1) emit time-under-mouse to the active consumer every frame
    // so view panning stays in sync with playhead; (2) auto-pan view when mouse
    // is near canvas edge.
    let panRaf = 0;
    const tick = () => {
      const w = rect.width;
      // During mark/erase drag, clamp cursor X to the canvas so the mouse
      // leaving the canvas (past the right edge) doesn't let mouseXToSec
      // return a value beyond the visible range — otherwise clampSec would
      // pin it to `duration`, silently extending a Cmd-drag erase all the
      // way to the end of the video and wiping every red box after the
      // click point.
      const effectiveX = shift || ctrl ? Math.max(0, Math.min(w, currentX)) : currentX;
      const t = clampSec(mouseXToSec(effectiveX, w));

      // Emit time update for current mode
      if (shift || ctrl) {
        setDragging((d) => (d ? { ...d, endSec: t } : d));
      } else if (moved) {
        onScrubUpdate(t);
      }

      // Auto-pan if near edge — scrub only. During mark/erase drag we skip
      // on purpose: panning while the mouse is stationary would make the same
      // pixel map to a later second every frame, silently extending the
      // selection far past where the user released.
      if (!shift && !ctrl) {
        let delta = 0;
        if (currentX < EDGE) delta = -((EDGE - currentX) / EDGE);
        else if (currentX > w - EDGE) delta = (currentX - (w - EDGE)) / EDGE;
        if (delta !== 0) {
          setView((v) => {
            const panAmount = delta * v.visibleSec * 0.02;
            const maxOffset = Math.max(0, duration - v.visibleSec);
            const newOffset = Math.max(0, Math.min(maxOffset, v.offsetSec + panAmount));
            return newOffset === v.offsetSec ? v : { ...v, offsetSec: newOffset };
          });
        }
      }

      panRaf = requestAnimationFrame(tick);
    };

    // ── Shift+drag = MARK, Ctrl+drag = ERASE ──────────────────────────────
    if (shift || ctrl) {
      setDragging({ startSec, endSec: startSec });
      panRaf = requestAnimationFrame(tick);
      const move = (ev: MouseEvent) => {
        currentX = ev.clientX - rect.left;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        cancelAnimationFrame(panRaf);
        setDragging((d) => {
          if (d) {
            const s = Math.min(d.startSec, d.endSec);
            const e2 = Math.max(d.startSec, d.endSec);
            if (e2 - s > 0.05) {
              if (shift) onMarkRange(s, e2);
              else onEraseRange(s, e2);
            } else {
              onSeek(startSec);
            }
          }
          return null;
        });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }

    // ── No modifier: first check if mouse is over a segment edge/body ────
    const hit = hitTestSegment(startX, rect.width);
    if (hit) {
      // Record initial drag state; defer preview state until actual move so a
      // click (no drag) inside a segment still counts as a click-seek.
      const anchorStart = hit.start;
      const anchorEnd = hit.end;
      const anchorSec = startSec;
      let segMoved = false;
      const segTick = () => {
        const w = rect.width;
        const curSec = clampSec(mouseXToSec(currentX, w));
        const dSec = curSec - anchorSec;
        let newStart = anchorStart;
        let newEnd = anchorEnd;
        if (hit.kind === 'resize-left') {
          newStart = Math.max(0, Math.min(anchorEnd - 0.05, anchorStart + dSec));
        } else if (hit.kind === 'resize-right') {
          newEnd = Math.min(duration, Math.max(anchorStart + 0.05, anchorEnd + dSec));
        } else {
          // move: shift both by dSec, keep length
          const len = anchorEnd - anchorStart;
          newStart = Math.max(0, Math.min(duration - len, anchorStart + dSec));
          newEnd = newStart + len;
        }
        if (segMoved) setSegDrag({ id: hit.segId, kind: hit.kind, start: newStart, end: newEnd });

        // Auto-pan at edges
        let panDelta = 0;
        if (currentX < EDGE) panDelta = -((EDGE - currentX) / EDGE);
        else if (currentX > w - EDGE) panDelta = (currentX - (w - EDGE)) / EDGE;
        if (panDelta !== 0) {
          setView((v) => {
            const panAmount = panDelta * v.visibleSec * 0.02;
            const maxOffset = Math.max(0, duration - v.visibleSec);
            const newOffset = Math.max(0, Math.min(maxOffset, v.offsetSec + panAmount));
            return newOffset === v.offsetSec ? v : { ...v, offsetSec: newOffset };
          });
        }
        panRaf = requestAnimationFrame(segTick);
      };
      panRaf = requestAnimationFrame(segTick);
      const move = (ev: MouseEvent) => {
        const xx = ev.clientX - rect.left;
        currentX = xx;
        if (!segMoved && Math.abs(xx - startX) > 2) segMoved = true;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        cancelAnimationFrame(panRaf);
        if (segMoved) {
          setSegDrag((d) => {
            if (d) {
              void onResizeSegment(d.id, d.start, d.end);
            }
            return null;
          });
        } else {
          // Tiny click inside segment → treat as click-to-seek
          onSeek(startSec);
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      return;
    }

    // ── Plain click / drag = SCRUB ────────────────────────────────────────
    onSeek(startSec); // immediate jump for responsive click-to-seek
    panRaf = requestAnimationFrame(tick);
    const move = (ev: MouseEvent) => {
      const xx = ev.clientX - rect.left;
      currentX = xx;
      if (!moved && Math.abs(xx - startX) > 2) {
        moved = true;
        onScrubStart(clampSec(mouseXToSec(xx, rect.width)));
      }
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      cancelAnimationFrame(panRaf);
      if (moved) onScrubEnd();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  function clampSec(t: number): number {
    return Math.max(0, Math.min(duration, t));
  }

  function zoomIn() {
    const newVisible = Math.max(0.5, view.visibleSec / 1.5);
    setView({ offsetSec: view.offsetSec, visibleSec: newVisible });
  }
  function zoomOut() {
    const newVisible = Math.min(duration, view.visibleSec * 1.5);
    setView({ offsetSec: view.offsetSec, visibleSec: newVisible });
  }
  function fitAll() {
    setView({ offsetSec: 0, visibleSec: duration });
  }

  // expose view control via custom events
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const zoom = (ev: Event) => {
      const { detail } = ev as CustomEvent<string>;
      if (detail === 'in') zoomIn();
      else if (detail === 'out') zoomOut();
      else if (detail === 'fit') fitAll();
    };
    const jump = (ev: Event) => {
      const { detail } = ev as CustomEvent<number>;
      if (!Number.isFinite(detail)) return;
      // If the target time is currently off-screen or near the edge, recenter
      // the view on it. Otherwise leave the view where it is.
      setView((v) => {
        const margin = v.visibleSec * 0.08;
        if (detail < v.offsetSec + margin || detail > v.offsetSec + v.visibleSec - margin) {
          const maxOffset = Math.max(0, duration - v.visibleSec);
          const newOffset = Math.max(0, Math.min(maxOffset, detail - v.visibleSec / 2));
          return { ...v, offsetSec: newOffset };
        }
        return v;
      });
    };
    el.addEventListener('lynlens-zoom', zoom);
    el.addEventListener('lynlens-jump', jump);
    return () => {
      el.removeEventListener('lynlens-zoom', zoom);
      el.removeEventListener('lynlens-jump', jump);
    };
  }, [view, duration]);

  function onMouseMove(e: React.MouseEvent) {
    // Update hover cursor based on what's under the mouse (only when not dragging).
    if (segDrag || dragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const hit = hitTestSegment(x, rect.width);
    if (!hit) setHoverCursor('default');
    else if (hit.kind === 'move') setHoverCursor('grab');
    else setHoverCursor('ew-resize');
  }

  return (
    <div
      className="timeline-wrap"
      ref={containerRef}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      style={{ cursor: segDrag ? (segDrag.kind === 'move' ? 'grabbing' : 'ew-resize') : hoverCursor }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
