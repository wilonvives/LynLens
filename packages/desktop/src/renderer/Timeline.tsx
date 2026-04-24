import { useEffect, useRef, useState } from 'react';
import {
  effectiveToSource,
  mapRangeToEffective,
  type Range,
  type Segment,
  type Transcript,
} from './core-browser';
import { formatTime } from './util';

/**
 * Stable per-speaker row tint for the timeline subtitle strip. Matches the
 * palette used by SubtitlePanel's badges, just at low alpha so underlying
 * text stays readable.
 */
const SPEAKER_ROW_PALETTE = [
  'rgba(78, 109, 159, 0.28)',   // blue
  'rgba(159, 78, 109, 0.28)',   // rose
  'rgba(109, 159, 78, 0.28)',   // green
  'rgba(159, 138, 78, 0.28)',   // amber
  'rgba(109, 78, 159, 0.28)',   // purple
  'rgba(78, 159, 138, 0.28)',   // teal
];
function speakerRowColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return SPEAKER_ROW_PALETTE[Math.abs(hash) % SPEAKER_ROW_PALETTE.length];
}

interface TimelineProps {
  /**
   * Effective duration of the compacted timeline (seconds). When cutRanges
   * is empty this equals sourceDuration and nothing changes visually.
   */
  duration: number;
  /** True source video duration — needed only to sample the waveform. */
  sourceDuration: number;
  /**
   * Source-time ranges that have been ripple-cut out. Drawing compacts them
   * away; click/drag coordinates come back in effective time.
   */
  cutRanges: readonly Range[];
  /** Current playhead in effective seconds. */
  currentTime: number;
  /**
   * True while the video is actually playing. Gates the auto-follow view
   * scroll so it only chases the playhead during real playback — never
   * while the user is manually scrubbing or dragging.
   */
  isPlaying: boolean;
  waveform: { peak: Float32Array; rms: Float32Array } | null;
  /** Segments live in SOURCE time; we map through cutRanges for rendering. */
  segments: Segment[];
  transcript: Transcript | null;
  /** Plain click: seek the playhead. Argument is EFFECTIVE seconds. */
  onSeek: (effectiveSec: number) => void;
  /** Plain drag: scrub. Arguments are EFFECTIVE seconds. */
  onScrubStart: (effectiveSec: number) => void;
  onScrubUpdate: (effectiveSec: number) => void;
  onScrubEnd: () => void;
  /** Shift+drag mark. Arguments are EFFECTIVE seconds. */
  onMarkRange: (effStart: number, effEnd: number) => void;
  /** Cmd/Ctrl+drag erase. Arguments are EFFECTIVE seconds. */
  onEraseRange: (effStart: number, effEnd: number) => void;
  /** Segment resize/move. Arguments are EFFECTIVE seconds. */
  onResizeSegment: (id: string, effStart: number, effEnd: number) => void;
  /**
   * Commit a transcript-subtitle edge resize (Cmd+Shift drag on the blue
   * frame). Times are SOURCE seconds — the renderer has already run the
   * same cascade rule the server will, so the parent just fires the IPC.
   */
  onResizeSubtitle: (segId: string, srcStart: number, srcEnd: number) => void;
}

interface View {
  offsetSec: number;
  visibleSec: number;
}

export function Timeline(props: TimelineProps) {
  const {
    duration,
    sourceDuration,
    cutRanges,
    currentTime,
    isPlaying,
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
    onResizeSubtitle,
  } = props;
  // Keep a ref so long-lived drag handlers (started via mousedown) still see
  // the latest cutRanges without having to retear down on every render.
  const cutRangesRef = useRef<readonly Range[]>(cutRanges);
  useEffect(() => {
    cutRangesRef.current = cutRanges;
  }, [cutRanges]);
  const sourceDurationRef = useRef<number>(sourceDuration);
  useEffect(() => {
    sourceDurationRef.current = sourceDuration;
  }, [sourceDuration]);
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
  /**
   * Live-preview state for Cmd+Shift drag on the active-subtitle blue frame.
   * When set: (1) blue frame locks onto this subtitle regardless of playhead,
   * (2) draw() uses these preview times instead of the segment's real times,
   * (3) neighbor (if any) is drawn with its near edge shifted too.
   * All times are SOURCE seconds — same frame as the transcript itself.
   */
  const [subEdgeDrag, setSubEdgeDrag] = useState<
    | null
    | {
        segId: string;
        edge: 'start' | 'end';
        targetStart: number;
        targetEnd: number;
        neighborId: string | null;
        neighborStart: number | null;
        neighborEnd: number | null;
      }
  >(null);

  // Initialise view once duration becomes known, and keep it in bounds when
  // duration changes (a ripple cut shrinks effectiveDuration; an undo grows
  // it back). Without this, the saved visibleSec from before the cut stays
  // wider than the new duration and the canvas shows an empty tail past
  // the end of the compacted timeline.
  //
  // Rule: if the user was viewing the full timeline (offset=0 and visible
  // >= old duration), keep showing the full new timeline. Otherwise preserve
  // the zoom level but clamp so the window can't overflow the new right edge.
  // We compare against the ref from the previous tick instead of tracking
  // prevDuration separately.
  const prevDurationRef = useRef<number>(0);
  useEffect(() => {
    if (duration <= 0) return;
    const prevDuration = prevDurationRef.current;
    prevDurationRef.current = duration;
    setView((v) => {
      if (v.visibleSec === 0) return { offsetSec: 0, visibleSec: duration };
      const wasFullView =
        prevDuration > 0 && v.offsetSec === 0 && v.visibleSec >= prevDuration - 0.01;
      const nextVisible = wasFullView ? duration : Math.min(v.visibleSec, duration);
      const maxOffset = Math.max(0, duration - nextVisible);
      const nextOffset = Math.min(v.offsetSec, maxOffset);
      if (nextVisible === v.visibleSec && nextOffset === v.offsetSec) return v;
      return { offsetSec: nextOffset, visibleSec: nextVisible };
    });
  }, [duration]);

  /**
   * Auto-follow while playing: if the playhead is past 60% of the visible
   * window, slide the view forward so the playhead stays pinned at 60%.
   *
   * Skipped when:
   *   - video is paused (user is browsing / editing, don't hijack the view)
   *   - a drag is in progress (scrub / mark / erase / subtitle-edge resize)
   *   - view is already at the right edge (duration reached — let playhead
   *     run freely to the tail; no more room to scroll)
   *   - playhead is off-screen (e.g. user seeked far away; lynlens-jump
   *     event handles recentering in that case)
   */
  useEffect(() => {
    if (!isPlaying) return;
    if (segDrag || dragging || subEdgeDrag) return;
    if (duration <= 0 || view.visibleSec <= 0) return;
    const rel = (currentTime - view.offsetSec) / view.visibleSec; // 0..1
    if (rel < 0 || rel > 1) {
      // Playhead is off-screen entirely. Recenter so it sits at 30% of
      // the visible window and playback resumes from there.
      const maxOff = Math.max(0, duration - view.visibleSec);
      const desired = Math.max(
        0,
        Math.min(maxOff, currentTime - view.visibleSec * 0.3)
      );
      if (Math.abs(desired - view.offsetSec) < 0.001) return;
      setView((v) => ({ ...v, offsetSec: desired }));
      return;
    }
    if (rel < 0.6) return; // haven't crossed the threshold yet
    const maxOffset = Math.max(0, duration - view.visibleSec);
    if (view.offsetSec >= maxOffset - 0.01) return; // already at end
    const desiredOffset = Math.min(maxOffset, currentTime - view.visibleSec * 0.6);
    if (Math.abs(desiredOffset - view.offsetSec) < 0.001) return;
    setView((v) => ({ ...v, offsetSec: desiredOffset }));
  }, [currentTime, isPlaying, duration, view, segDrag, dragging, subEdgeDrag]);

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

  /**
   * Find the ACTIVE subtitle at the current playhead. Returns the whole
   * transcript segment (source-time) or null. Locked to a specific id when
   * a subtitle-edge drag is in progress so the frame doesn't jump if the
   * playhead crosses into a neighbor mid-drag.
   */
  function getActiveSubtitleSeg() {
    if (!transcript) return null;
    if (subEdgeDrag) {
      return transcript.segments.find((t) => t.id === subEdgeDrag.segId) ?? null;
    }
    const srcNow = effectiveToSource(currentTime, cutRanges);
    return transcript.segments.find((t) => srcNow >= t.start && srcNow < t.end) ?? null;
  }

  /**
   * Given the CURRENT mouse x (px) on the canvas, return which edge of the
   * active subtitle's blue frame the mouse is over — if any. Skipped when
   * the frame is too narrow (< 20px) to reliably distinguish the two edges.
   */
  function hitTestSubEdge(
    x: number
  ): { segId: string; edge: 'start' | 'end' } | null {
    const active = getActiveSubtitleSeg();
    if (!active) return null;
    const pieces = mapRangeToEffective(
      { start: active.start, end: active.end },
      cutRanges
    );
    if (pieces.length === 0) return null;
    const first = pieces[0];
    const last = pieces[pieces.length - 1];
    const firstX = secToPx(first.start);
    const lastX = secToPx(last.end);
    if (lastX - firstX < 20) return null; // too narrow, decision 4
    const HIT = 7;
    if (Math.abs(x - firstX) <= HIT) return { segId: active.id, edge: 'start' };
    if (Math.abs(x - lastX) <= HIT) return { segId: active.id, edge: 'end' };
    return null;
  }

  /**
   * Same cascade rule as project-manager.ts's updateTranscriptSegmentTime,
   * duplicated here so the renderer can show a live preview while the user
   * drags. The final commit still goes through the IPC (which re-runs the
   * math server-side, so this is purely cosmetic). MIN_DUR = 500ms matches
   * the nudge-button behavior — one rule, one number.
   */
  function computeSubEdgeCascade(
    segId: string,
    edge: 'start' | 'end',
    newSourceSec: number
  ): {
    targetStart: number;
    targetEnd: number;
    neighborId: string | null;
    neighborStart: number | null;
    neighborEnd: number | null;
  } | null {
    if (!transcript) return null;
    const target = transcript.segments.find((s) => s.id === segId);
    if (!target) return null;
    const MIN_GAP = 0.01;
    const MIN_DUR = 0.5;
    const maxSrc = sourceDurationRef.current || Infinity;

    let tStart = target.start;
    let tEnd = target.end;
    let nId: string | null = null;
    let nS: number | null = null;
    let nE: number | null = null;

    const ordered = [...transcript.segments].sort((a, b) => a.start - b.start);
    const idx = ordered.findIndex((s) => s.id === segId);
    const prev = idx > 0 ? ordered[idx - 1] : null;
    const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;

    if (edge === 'end') {
      tEnd = Math.min(maxSrc, Math.max(tStart + MIN_DUR, newSourceSec));
      if (next && tEnd + MIN_GAP > next.start) {
        const wanted = tEnd + MIN_GAP;
        if (next.end - wanted < MIN_DUR) {
          const cappedEnd = next.end - MIN_DUR - MIN_GAP;
          if (cappedEnd <= tStart + MIN_DUR) return null;
          tEnd = cappedEnd;
          nId = next.id;
          nS = tEnd + MIN_GAP;
          nE = next.end;
        } else {
          nId = next.id;
          nS = wanted;
          nE = next.end;
        }
      }
    } else {
      tStart = Math.max(0, Math.min(tEnd - MIN_DUR, newSourceSec));
      if (prev && tStart - MIN_GAP < prev.end) {
        const wanted = tStart - MIN_GAP;
        if (wanted - prev.start < MIN_DUR) {
          const cappedStart = prev.start + MIN_DUR + MIN_GAP;
          if (cappedStart >= tEnd - MIN_DUR) return null;
          tStart = cappedStart;
          nId = prev.id;
          nS = prev.start;
          nE = tStart - MIN_GAP;
        } else {
          nId = prev.id;
          nS = prev.start;
          nE = wanted;
        }
      }
    }
    return {
      targetStart: tStart,
      targetEnd: tEnd,
      neighborId: nId,
      neighborStart: nS,
      neighborEnd: nE,
    };
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
      // Waveform buckets were extracted from the source audio, so index them
      // by source time. We translate each effective-time pixel to source time
      // before sampling. When cutRanges is empty this is effectively a no-op.
      const srcDur = sourceDurationRef.current || duration;
      const bucketsPerSec = peak.length / srcDur;
      const peakTops = new Float32Array(w);
      const rmsTops = new Float32Array(w);

      for (let x = 0; x < w; x++) {
        const effA = view.offsetSec + (x / w) * view.visibleSec;
        const effB = view.offsetSec + ((x + 1) / w) * view.visibleSec;
        if (effB < 0 || effA >= duration) continue;
        const srcA = effectiveToSource(Math.max(0, effA), cutRanges);
        const srcB = effectiveToSource(Math.min(duration, effB), cutRanges);
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
    // Segments are stored in SOURCE time. Map each through cutRanges to get
    // the effective-time pieces visible on the compacted timeline. A segment
    // that straddles a cut is drawn as multiple pieces; a segment fully
    // inside a cut disappears from view (it's now unreachable — the user can
    // still undo to restore the cut).
    for (const seg of segments) {
      const dragActive = segDrag && segDrag.id === seg.id;
      // Non-drag: map source range through cuts to get effective pieces.
      // During drag: segDrag already stores a single continuous effective
      // piece (the one the user grabbed via hitTestSegment), so draw it
      // directly without remapping.
      const pieces = dragActive
        ? [{ start: segDrag!.start, end: segDrag!.end }]
        : mapRangeToEffective({ start: seg.start, end: seg.end }, cutRanges);
      if (pieces.length === 0) continue;

      let color: string;
      let strokeColor: string;
      if (seg.status === 'rejected') {
        color = 'rgba(136,136,136,0.3)';
        strokeColor = 'rgba(136,136,136,0.6)';
      } else if (seg.source === 'ai' && seg.status === 'pending') {
        color = 'rgba(155,89,182,0.5)';
        strokeColor = 'rgba(155,89,182,0.9)';
      } else {
        color = 'rgba(255,74,74,0.55)';
        strokeColor = 'rgba(255,74,74,0.9)';
      }

      for (const piece of pieces) {
        const x1 = secToPx(piece.start);
        const x2 = secToPx(piece.end);
        if (x2 < 0 || x1 > w) continue;
        const clampedX1 = Math.max(0, x1);
        const clampedX2 = Math.min(w, x2);
        ctx.fillStyle = color;
        ctx.fillRect(clampedX1, 0, clampedX2 - clampedX1, waveHeight);
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = dragActive ? 2 : 1;
        ctx.strokeRect(clampedX1 + 0.5, 0.5, clampedX2 - clampedX1 - 1, waveHeight - 1);
        if (clampedX2 - clampedX1 > 12) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(clampedX1 + 2, waveHeight * 0.2, 2, waveHeight * 0.6);
          ctx.fillRect(clampedX2 - 4, waveHeight * 0.2, 2, waveHeight * 0.6);
        }
      }
    }

    // Cut markers intentionally not drawn here — cuts live on the segment
    // records and surface in the sidebar with a ↶ undo button. The timeline
    // itself should feel like a clean, compacted view of the final cut.

    // --- drag selection ---
    if (dragging) {
      const x1 = secToPx(Math.min(dragging.startSec, dragging.endSec));
      const x2 = secToPx(Math.max(dragging.startSec, dragging.endSec));
      ctx.fillStyle = 'rgba(14,122,254,0.3)';
      ctx.fillRect(x1, 0, x2 - x1, waveHeight);
      ctx.strokeStyle = 'rgba(14,122,254,0.9)';
      ctx.strokeRect(x1 + 0.5, 0.5, x2 - x1 - 1, waveHeight - 1);
    }

    // --- active-subtitle frame (purely visual — matches the blue border
    // on the active card in SubtitlePanel). Drawn over the waveform +
    // segments but underneath the subtitle strip so the row tint stays
    // readable. During a Cmd+Shift edge drag: (1) the frame locks onto
    // the dragged subtitle instead of following the playhead, (2) its
    // source-range comes from the preview state, (3) the neighbor being
    // shifted gets a second, fainter frame so the user sees both sides
    // move in real time.
    if (transcript) {
      const activeTSeg = getActiveSubtitleSeg();
      if (activeTSeg) {
        const rangeStart = subEdgeDrag ? subEdgeDrag.targetStart : activeTSeg.start;
        const rangeEnd = subEdgeDrag ? subEdgeDrag.targetEnd : activeTSeg.end;
        const pieces = mapRangeToEffective(
          { start: rangeStart, end: rangeEnd },
          cutRanges
        );
        for (const piece of pieces) {
          const x1 = secToPx(piece.start);
          const x2 = secToPx(piece.end);
          if (x2 < 0 || x1 > w) continue;
          const clampedX1 = Math.max(0, x1);
          const clampedX2 = Math.min(w, x2);
          const width = clampedX2 - clampedX1;
          if (width < 2) continue;
          const boxW = Math.max(0, width - 2);
          const boxH = Math.max(0, waveHeight - 2);
          const radius = Math.min(6, boxW / 2, boxH / 2);
          ctx.beginPath();
          ctx.roundRect(clampedX1 + 1, 1, boxW, boxH, radius);
          ctx.fillStyle = 'rgba(14,122,254,0.10)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(14,122,254,0.85)';
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // Edge grab markers — thin vertical bars at the first piece's
        // start and the last piece's end. Always drawn so the user has a
        // visual hint that edges are interactive; Cmd+Shift is the gate,
        // not discoverability. Only skipped when the whole frame is too
        // narrow to distinguish the two sides (same 20px rule as hit-test).
        if (pieces.length > 0) {
          const first = pieces[0];
          const last = pieces[pieces.length - 1];
          const firstX = secToPx(first.start);
          const lastX = secToPx(last.end);
          if (lastX - firstX >= 20) {
            ctx.fillStyle = subEdgeDrag
              ? 'rgba(14,122,254,1.0)'
              : 'rgba(14,122,254,0.9)';
            // 3px wide bars, full waveform height, slightly inset vertically
            const barW = 3;
            const barY = 3;
            const barH = Math.max(0, waveHeight - 6);
            if (firstX >= -barW && firstX <= w) {
              ctx.fillRect(Math.round(firstX - barW / 2), barY, barW, barH);
            }
            if (lastX >= -barW && lastX <= w) {
              ctx.fillRect(Math.round(lastX - barW / 2), barY, barW, barH);
            }
          }
        }
      }

      // Neighbor preview — during an edge drag, render the neighbor's
      // shifted range as a faint, dashed blue frame so the user sees who
      // is being pushed around. No fill (keeps underlying waveform clean).
      if (subEdgeDrag && subEdgeDrag.neighborId && subEdgeDrag.neighborStart != null && subEdgeDrag.neighborEnd != null) {
        const nPieces = mapRangeToEffective(
          { start: subEdgeDrag.neighborStart, end: subEdgeDrag.neighborEnd },
          cutRanges
        );
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(14,122,254,0.6)';
        ctx.lineWidth = 1.5;
        for (const piece of nPieces) {
          const x1 = secToPx(piece.start);
          const x2 = secToPx(piece.end);
          if (x2 < 0 || x1 > w) continue;
          const clampedX1 = Math.max(0, x1);
          const clampedX2 = Math.min(w, x2);
          const width = clampedX2 - clampedX1;
          if (width < 2) continue;
          const boxW = Math.max(0, width - 2);
          const boxH = Math.max(0, waveHeight - 2);
          const radius = Math.min(6, boxW / 2, boxH / 2);
          ctx.beginPath();
          ctx.roundRect(clampedX1 + 1, 1, boxW, boxH, radius);
          ctx.stroke();
        }
        ctx.restore();
      }
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
        // During an edge drag, substitute preview times for the two
        // subtitles being moved so the strip follows the blue frame in
        // real time instead of snapping only after the commit.
        let segStart = tseg.start;
        let segEnd = tseg.end;
        if (subEdgeDrag) {
          if (tseg.id === subEdgeDrag.segId) {
            segStart = subEdgeDrag.targetStart;
            segEnd = subEdgeDrag.targetEnd;
          } else if (
            tseg.id === subEdgeDrag.neighborId &&
            subEdgeDrag.neighborStart != null &&
            subEdgeDrag.neighborEnd != null
          ) {
            segStart = subEdgeDrag.neighborStart;
            segEnd = subEdgeDrag.neighborEnd;
          }
        }
        // Map source time → effective pieces. A subtitle fully inside a cut
        // vanishes; one straddling a cut is drawn in each kept piece.
        const pieces = mapRangeToEffective({ start: segStart, end: segEnd }, cutRanges);
        if (pieces.length === 0) continue;
        // Dim any subtitle that falls inside an approved delete-segment
        const inDelete = segments.some(
          (s) => s.status === 'approved' && tseg.start >= s.start && tseg.end <= s.end
        );

        for (const piece of pieces) {
          const x1 = secToPx(piece.start);
          const x2 = secToPx(piece.end);
          if (x2 < 0 || x1 > w) continue;
          const clampedX1 = Math.max(0, x1);
          const clampedX2 = Math.min(w, x2);
          const width = clampedX2 - clampedX1;
          if (width < 2) continue;
          // If speaker-tagged, tint the row by a stable per-speaker colour.
          // Otherwise fall back to the original neutral blue.
          let bg = 'rgba(80,130,180,0.2)';
          if (inDelete) bg = 'rgba(80,80,80,0.25)';
          else if (tseg.speaker) bg = speakerRowColor(tseg.speaker);
          ctx.fillStyle = bg;
          ctx.fillRect(clampedX1, waveHeight + 2, width, subtitleHeight - 4);
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

      // Horizontal pan. Three input paths all land here:
      //   1. Trackpad two-finger horizontal swipe — browser fires wheel
      //      events with |deltaX| >> |deltaY|. This is what the user
      //      actually wants on macOS.
      //   2. Shift + wheel on a regular mouse — common convention for
      //      horizontal scrolling, preserved for mouse users.
      //   3. Alt + wheel — legacy mapping; kept so existing muscle memory
      //      still works.
      const horizontalIntent =
        Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.altKey || e.shiftKey;
      if (horizontalIntent) {
        e.preventDefault();
        const secPerPx = view.visibleSec / rect.width;
        // Prefer deltaX when present (trackpad); fall back to deltaY so
        // Alt+wheel on a mouse still works. Multiplier tuned so trackpad
        // feels responsive without flying past the end of the clip.
        const pxDelta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        const delta = pxDelta * secPerPx * 1.2;
        const maxOffset = Math.max(0, duration - view.visibleSec);
        const newOffset = Math.max(0, Math.min(maxOffset, view.offsetSec + delta));
        if (newOffset !== view.offsetSec) {
          setView({ offsetSec: newOffset, visibleSec: view.visibleSec });
        }
        return;
      }

      // Plain vertical wheel => no action. Letting it bubble would scroll
      // whatever ancestor is scrollable; the timeline is inside a fixed
      // layout so there's usually nothing to scroll and we just eat it.
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
    | {
        segId: string;
        kind: 'resize-left' | 'resize-right' | 'move';
        /** Effective-time anchors for the segment piece under the cursor. */
        start: number;
        end: number;
      }
    | null {
    const HANDLE = 6;
    const cuts = cutRangesRef.current;
    const v = viewRef.current;
    for (const s of segments) {
      if (s.status === 'rejected') continue;
      // Each segment may be split into multiple effective-time pieces when
      // it straddles a cut. Hit-testing operates on pieces individually.
      // Resize/move returns EFFECTIVE anchors for the specific piece —
      // callers (App.tsx) convert back to source when persisting.
      const pieces = mapRangeToEffective({ start: s.start, end: s.end }, cuts);
      for (const p of pieces) {
        const sx = ((p.start - v.offsetSec) / v.visibleSec) * canvasW;
        const ex = ((p.end - v.offsetSec) / v.visibleSec) * canvasW;
        if (Math.abs(xPx - sx) <= HANDLE) {
          return { segId: s.id, kind: 'resize-left', start: p.start, end: p.end };
        }
        if (Math.abs(xPx - ex) <= HANDLE) {
          return { segId: s.id, kind: 'resize-right', start: p.start, end: p.end };
        }
        if (xPx > sx + HANDLE && xPx < ex - HANDLE) {
          return { segId: s.id, kind: 'move', start: p.start, end: p.end };
        }
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
    // Cmd+Shift (or Ctrl+Shift on non-mac) = "grab subtitle edge". Checked
    // FIRST so it never falls through to the regular shift/ctrl handlers.
    const cmdShift = (e.metaKey || e.ctrlKey) && e.shiftKey;

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

    // ── Cmd+Shift drag = ADJUST ACTIVE SUBTITLE EDGE ──────────────────────
    if (cmdShift) {
      const subHit = hitTestSubEdge(startX);
      if (!subHit) {
        // User held Cmd+Shift but missed the edge. Consume the event so we
        // don't accidentally fall through to a red mark (shift) or erase.
        e.preventDefault();
        return;
      }
      const seg = transcript?.segments.find((s) => s.id === subHit.segId);
      if (!seg) return;
      // Seed preview with the current times — mousemove updates it each
      // frame. Even a zero-move mouseup stays safe (commits no-op).
      setSubEdgeDrag({
        segId: subHit.segId,
        edge: subHit.edge,
        targetStart: seg.start,
        targetEnd: seg.end,
        neighborId: null,
        neighborStart: null,
        neighborEnd: null,
      });
      const updatePreview = () => {
        const effSec = clampSec(mouseXToSec(currentX, rect.width));
        const srcSec = effectiveToSource(effSec, cutRangesRef.current);
        const cascade = computeSubEdgeCascade(subHit.segId, subHit.edge, srcSec);
        if (cascade) {
          setSubEdgeDrag({
            segId: subHit.segId,
            edge: subHit.edge,
            targetStart: cascade.targetStart,
            targetEnd: cascade.targetEnd,
            neighborId: cascade.neighborId,
            neighborStart: cascade.neighborStart,
            neighborEnd: cascade.neighborEnd,
          });
        }
        panRaf = requestAnimationFrame(updatePreview);
      };
      panRaf = requestAnimationFrame(updatePreview);
      const move = (ev: MouseEvent) => {
        currentX = ev.clientX - rect.left;
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        cancelAnimationFrame(panRaf);
        setSubEdgeDrag((d) => {
          if (d) {
            onResizeSubtitle(d.segId, d.targetStart, d.targetEnd);
          }
          return null;
        });
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      e.preventDefault();
      return;
    }

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
    if (segDrag || dragging || subEdgeDrag) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    // Subtitle-edge grab only activates with Cmd+Shift — otherwise we fall
    // through to the normal segment hit-test so the red boxes keep working.
    const cmdShift = (e.metaKey || e.ctrlKey) && e.shiftKey;
    if (cmdShift) {
      const sub = hitTestSubEdge(x);
      if (sub) {
        setHoverCursor('ew-resize');
        return;
      }
    }
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
      style={{
        cursor: subEdgeDrag
          ? 'ew-resize'
          : segDrag
            ? segDrag.kind === 'move'
              ? 'grabbing'
              : 'ew-resize'
            : hoverCursor,
      }}
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
