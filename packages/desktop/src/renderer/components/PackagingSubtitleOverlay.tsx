/**
 * Subtitle overlay for the 包装 tab — renders the current line and,
 * when the user clicks it, switches into an EDIT MODE with direct-
 * manipulation drag handles (move / scale / rotate) à la Figma/开拍.
 *
 * Coordinate system for transforms:
 *   - `transform.x`, `transform.y` are 0-1 FRACTIONS of the video frame
 *     (so they survive across preview/export resolutions).
 *   - `transform.scale` multiplies the base font-size.
 *   - `transform.rotation` is degrees, clockwise.
 *
 * Edit mode lifecycle (driven by parent state via props):
 *   - Click subtitle text → onEnterEdit(segmentIdx).
 *   - Parent flips `editingSegmentIdx`; this component re-renders with
 *     bounding box + 4 corner scale handles + 1 rotation handle.
 *   - On pointer-down on a handle, drag logic kicks in (move/scale/
 *     rotate). On move, fires onTransformChange so parent can persist.
 *   - Click outside (on the transparent overlay surface) → onExitEdit().
 *
 * Export note: ASS \pos and \frz tags for the burned-in export need to
 * use these transforms too — that's a separate change in ass-generator,
 * deferred for now (preview is what the user is iterating on).
 */
import { useMemo, useRef } from 'react';
import type {
  PackagingPlan,
  PreviewPlaylistEntry,
  SubtitleStyle,
  SubtitleTransform,
  Transcript,
  WordEffect,
} from '@lynlens/core';

interface Props {
  transcript: Transcript;
  plan: PackagingPlan | null;
  currentTimeSec: number;
  playlist?: PreviewPlaylistEntry[];
  orientation?: 'portrait' | 'landscape' | 'unknown';
  sourceHeight: number;
  displayHeight: number;
  /** Index of the segment currently in edit mode (handles visible). */
  editingSegmentIdx?: number | null;
  /** User clicked subtitle text → request to enter edit mode. */
  onEnterEdit?: (segmentIdx: number) => void;
  /** User clicked outside subtitle → request to exit edit mode. */
  onExitEdit?: () => void;
  /** Drag/scale/rotate delta — persist to plan. */
  onTransformChange?: (segmentIdx: number, t: SubtitleTransform) => void;
}

const FALLBACK_STYLE: SubtitleStyle = {
  font: "'PingFang SC', 'Source Han Sans CN', 'Helvetica Neue', sans-serif",
  size: 36,
  color: '#ffffff',
  outline: { color: '#000000', width: 3 },
  position: 'bottom',
};

/** Defensive font-size cap (mirrors packaging-plan parser cap). */
function clampSize(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 56;
  return Math.min(120, Math.max(16, v));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Derive an initial transform from the resolved style.position so that
 * when the user first clicks a subtitle (no transform yet), the handles
 * appear AT the visual position the subtitle is currently rendered.
 */
function deriveInitialTransform(
  position: 'top' | 'center' | 'bottom'
): SubtitleTransform {
  return {
    x: 0.5,
    y: position === 'top' ? 0.12 : position === 'center' ? 0.5 : 0.88,
    scale: 1.0,
    rotation: 0,
  };
}

export function PackagingSubtitleOverlay({
  transcript,
  plan,
  currentTimeSec,
  playlist,
  orientation,
  sourceHeight,
  displayHeight,
  editingSegmentIdx,
  onEnterEdit,
  onExitEdit,
  onTransformChange,
}: Props): JSX.Element | null {
  const sourceTimeSec = useMemo<number | null>(() => {
    if (!playlist || playlist.length === 0) return currentTimeSec;
    for (const e of playlist) {
      if (currentTimeSec >= e.variantStart && currentTimeSec < e.variantEnd) {
        return e.srcStart + (currentTimeSec - e.variantStart);
      }
    }
    const last = playlist[playlist.length - 1];
    if (currentTimeSec >= last.variantEnd) return last.srcEnd - 0.001;
    return null;
  }, [playlist, currentTimeSec]);

  const { activeSeg, activeIdx } = useMemo(() => {
    if (sourceTimeSec === null) return { activeSeg: null, activeIdx: -1 };
    for (let i = 0; i < transcript.segments.length; i++) {
      const s = transcript.segments[i];
      if (sourceTimeSec >= s.start && sourceTimeSec < s.end) {
        return { activeSeg: s, activeIdx: i };
      }
    }
    return { activeSeg: null, activeIdx: -1 };
  }, [transcript.segments, sourceTimeSec]);

  // Resolve style (defaults only — segment-level non-wordEffects/transform
  // overrides are stripped). transform IS read per-segment because that's
  // explicitly user-set via drag handles. role IS read per-segment because
  // it's an explicit AI judgement to switch the segment's visual treatment.
  const recipe = plan?.segments.find((s) => s.segmentIdx === activeIdx);
  const merged: SubtitleStyle = {
    ...FALLBACK_STYLE,
    ...(plan?.defaults.subtitle ?? {}),
  };
  const wordEffects: WordEffect[] = recipe?.subtitle?.wordEffects ?? [];
  const userTransform = recipe?.subtitle?.transform;
  const role: 'narrate' | 'emphasis' =
    recipe?.subtitle?.role === 'emphasis' ? 'emphasis' : 'narrate';

  const font = merged.font ?? FALLBACK_STYLE.font!;
  const baseSize = clampSize(merged.size ?? FALLBACK_STYLE.size!);
  const defaultColor = merged.color ?? FALLBACK_STYLE.color!;
  const baseOutline = merged.outline ?? FALLBACK_STYLE.outline!;
  const bgColor = merged.bgColor;
  const position = merged.position ?? 'bottom';
  // Bold + shadow — mirror the ASS-export defaults (see ass-generator).
  // bold defaults to TRUE because video subtitles look weak at regular
  // weight. Shadow is opt-in.
  const isBold = merged.bold ?? true;
  const shadowSpec = merged.shadow;

  // Per-role visual treatment.
  //
  // narrate (default ~80% of segments): yellow text + thick black outline +
  //   subtle white top-edge highlight (gives a faux-3D bevel feel). Matches
  //   the dominant style in the reference video the user shared (5月16日_
  //   edited_高光_SLAPP).
  //
  // emphasis (~10-20%): white CAPSULE background + drop shadow + thin
  //   black text outline + white text body with RED keywords. Matches the
  //   reference's "现在你在网络上 [乱讲话]" punchline frames. The keyword
  //   color (#ff3333) overrides the white default for highlighted words.
  const rolePalette =
    role === 'emphasis'
      ? {
          // base text + outline
          textColor: '#ffffff',
          keywordColor: '#ff3333',
          outlineColor: '#000000',
          outlineWidth: 1.5,
          topHighlight: false,
          // background pill
          pillBg: '#ffffff',
          pillPaddingY: 8,
          pillPaddingX: 22,
          pillRadius: 999,
          pillShadow: '0 6px 18px rgba(0,0,0,0.45)',
        }
      : {
          textColor: defaultColor === '#ffffff' ? '#fed800' : defaultColor,
          keywordColor: '#ff3333',
          outlineColor: baseOutline.color,
          outlineWidth: Math.max(baseOutline.width, 4),
          topHighlight: true,
          pillBg: undefined,
          pillPaddingY: 6,
          pillPaddingX: 18,
          pillRadius: 0,
          pillShadow: undefined,
        };

  const scale =
    sourceHeight > 0 && displayHeight > 0 ? displayHeight / sourceHeight : 1;
  const size = Math.max(8, Math.round(baseSize * scale));

  const orientedSize =
    merged.size === undefined && orientation === 'portrait'
      ? Math.round(size * 1.15)
      : size;

  const isEditing = editingSegmentIdx === activeIdx && activeIdx >= 0;
  const effectiveTransform = userTransform ?? null;

  // Drag state — refs (not state) so pointermove updates don't re-render.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  type DragState =
    | { type: 'move'; startX: number; startY: number; start: SubtitleTransform }
    | {
        type: 'scale';
        startX: number;
        startY: number;
        start: SubtitleTransform;
        centerX: number;
        centerY: number;
        startDist: number;
      }
    | {
        type: 'rotate';
        start: SubtitleTransform;
        centerX: number;
        centerY: number;
        startAngle: number;
      };
  const dragRef = useRef<DragState | null>(null);

  /**
   * Start a drag. Creates fresh `move` + `end` handlers each invocation
   * so addEventListener / removeEventListener always see the same
   * reference (avoiding stale-closure leaks when the component re-
   * renders mid-drag).
   */
  function startDrag(
    kind: 'move' | 'scale' | 'rotate',
    e: React.PointerEvent
  ): void {
    e.stopPropagation();
    e.preventDefault();
    if (activeIdx < 0 || !onTransformChange) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const t = userTransform ?? deriveInitialTransform(position);
    // First click that hasn't established a transform yet → commit the
    // derived one so handles render around the visual baseline.
    if (!userTransform) onTransformChange(activeIdx, t);

    let state: DragState;
    if (kind === 'move') {
      state = {
        type: 'move',
        startX: e.clientX,
        startY: e.clientY,
        start: t,
      };
    } else if (kind === 'scale') {
      const centerX = rect.left + rect.width * t.x;
      const centerY = rect.top + rect.height * t.y;
      const startDist = Math.hypot(e.clientX - centerX, e.clientY - centerY);
      state = {
        type: 'scale',
        startX: e.clientX,
        startY: e.clientY,
        start: t,
        centerX,
        centerY,
        startDist: startDist || 1,
      };
    } else {
      const centerX = rect.left + rect.width * t.x;
      const centerY = rect.top + rect.height * t.y;
      const startAngle =
        (Math.atan2(e.clientY - centerY, e.clientX - centerX) * 180) / Math.PI;
      state = {
        type: 'rotate',
        start: t,
        centerX,
        centerY,
        startAngle,
      };
    }
    dragRef.current = state;

    // Capture refs once at drag start so the move handler keeps using
    // the SAME wrap rect even if a re-render replaces wrapRef.current.
    const capturedRect = rect;
    const capturedActiveIdx = activeIdx;
    const capturedOnChange = onTransformChange;

    const move = (ev: PointerEvent): void => {
      const s = dragRef.current;
      if (!s) return;
      if (s.type === 'move') {
        const dx = (ev.clientX - s.startX) / capturedRect.width;
        const dy = (ev.clientY - s.startY) / capturedRect.height;
        capturedOnChange(capturedActiveIdx, {
          ...s.start,
          x: clamp(s.start.x + dx, 0.05, 0.95),
          y: clamp(s.start.y + dy, 0.05, 0.95),
        });
      } else if (s.type === 'scale') {
        const d = Math.hypot(ev.clientX - s.centerX, ev.clientY - s.centerY);
        const ratio = d / s.startDist;
        capturedOnChange(capturedActiveIdx, {
          ...s.start,
          scale: clamp(s.start.scale * ratio, 0.3, 3.0),
        });
      } else {
        const now =
          (Math.atan2(ev.clientY - s.centerY, ev.clientX - s.centerX) * 180) /
          Math.PI;
        const delta = now - s.startAngle;
        let r = s.start.rotation + delta;
        while (r > 180) r -= 360;
        while (r < -180) r += 360;
        capturedOnChange(capturedActiveIdx, { ...s.start, rotation: r });
      }
    };
    const end = (): void => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }

  if (!activeSeg) return null;

  // Tokenise for wordEffects mapping.
  const tokens = activeSeg.text.split(/\s+/).filter((t) => t.length > 0);
  const effectByIdx = new Map<number, WordEffect>();
  wordEffects.forEach((w) => effectByIdx.set(w.wordIdx, w));

  // Outline (8-direction text-shadow ring) plus, for `narrate` role
  // only, an additional white 3D-bevel top-edge highlight that gives
  // the bold yellow chars a glossy reflective feel — matches the
  // reference video's signature look. Without this highlight the
  // yellow looks flat and the role looks bland.
  const effOutlineWidth = Math.max(0.5, rolePalette.outlineWidth * scale);
  const outlineRing = effOutlineWidth > 0
    ? Array.from({ length: 8 })
        .map((_, i) => {
          const angle = (i * Math.PI) / 4;
          const dx = Math.cos(angle) * effOutlineWidth;
          const dy = Math.sin(angle) * effOutlineWidth;
          return `${dx.toFixed(1)}px ${dy.toFixed(1)}px 0 ${rolePalette.outlineColor}`;
        })
        .join(', ')
    : '';
  // Top-edge highlight: a single white shadow offset UPWARD creates a
  // glossy bevel on top of each glyph. Layer ABOVE the outline ring
  // so the white shows through. Scale with display.
  const topHighlight = rolePalette.topHighlight
    ? `0 -${Math.max(1, effOutlineWidth * 0.5).toFixed(1)}px 0 #ffffff`
    : '';
  // Drop shadow — mirrors ASS \shad. Offset down+right, scaled by
  // display ratio so it looks consistent across preview/export sizes.
  // depth=0 (or no shadow specified) → omitted.
  const shadowLayer = shadowSpec
    ? (() => {
        const d = Math.max(0, shadowSpec.depth * scale);
        const c = shadowSpec.color ?? '#000000';
        return `${d.toFixed(1)}px ${d.toFixed(1)}px ${(d * 0.6).toFixed(1)}px ${c}`;
      })()
    : '';
  const textShadow =
    [topHighlight, outlineRing, shadowLayer].filter(Boolean).join(', ') ||
    'none';

  // Resolve transform to actually apply (null = use flex baseline).
  const renderTransform = effectiveTransform;

  // Text container — when transform set: absolutely placed at (x, y) with
  // CSS transform for scale + rotation. Otherwise: flex-positioned via
  // outer container's verticalStyle.
  //
  // `width: max-content` is CRITICAL: without it, absolutely-positioned
  // elements with `left: X%` and `width: auto` get sized to the
  // available space from `left` to the right edge of the containing
  // block. Drag the subtitle to x=90% → available width = 10% → the
  // container shrinks to 10% of frame → CJK text wraps one char per
  // line. Dragging LEFT (x=10%) leaves 90% available so it looked fine.
  // `max-content` makes the container size to its natural content
  // width (one-line preferred), with `maxWidth: 92%` still capping it.
  const containerCommon: React.CSSProperties = {
    width: 'max-content',
    maxWidth: '92%',
    padding: `${rolePalette.pillPaddingY}px ${rolePalette.pillPaddingX}px`,
    background: rolePalette.pillBg ?? bgColor ?? 'transparent',
    borderRadius: rolePalette.pillRadius || (bgColor ? 6 : 0),
    boxShadow: rolePalette.pillShadow,
    textAlign: 'center' as const,
    lineHeight: 1.2,
  };

  const textContainerStyle: React.CSSProperties = renderTransform
    ? {
        ...containerCommon,
        position: 'absolute',
        left: `${renderTransform.x * 100}%`,
        top: `${renderTransform.y * 100}%`,
        transform: `translate(-50%, -50%) scale(${renderTransform.scale}) rotate(${renderTransform.rotation}deg)`,
        transformOrigin: 'center center',
        pointerEvents: 'auto',
        cursor: isEditing ? 'move' : 'pointer',
        outline: isEditing ? '1.5px dashed rgba(122, 162, 247, 0.9)' : 'none',
        outlineOffset: 2,
      }
    : {
        ...containerCommon,
        textAlign: 'center',
        lineHeight: 1.2,
        pointerEvents: onEnterEdit ? 'auto' : 'none',
        cursor: onEnterEdit ? 'pointer' : 'default',
      };

  // verticalStyle only matters when there's no transform.
  const verticalStyle: React.CSSProperties =
    position === 'top'
      ? { justifyContent: 'flex-start', paddingTop: '8%' }
      : position === 'center'
        ? { justifyContent: 'center' }
        : { justifyContent: 'flex-end', paddingBottom: '12%' };

  return (
    <div
      ref={wrapRef}
      onClick={(e) => {
        // Click on the empty (transparent) overlay area → exit edit
        // mode if we're in one. When not editing, this div has
        // pointerEvents: none so clicks pass through to the video for
        // play/pause.
        if (isEditing && e.target === e.currentTarget && onExitEdit) {
          onExitEdit();
        }
      }}
      style={{
        position: 'absolute',
        inset: 0,
        display: renderTransform ? 'block' : 'flex',
        // Column direction so justify=flex-end goes BOTTOM (was a CSS bug
        // before — used row direction which pushed to the right edge).
        flexDirection: 'column',
        alignItems: 'center',
        // Outer overlay needs pointer-events only when in edit mode (so
        // we can catch click-outside to exit). Otherwise pass clicks
        // through to the video for play/pause.
        pointerEvents: isEditing ? 'auto' : 'none',
        ...(renderTransform ? {} : verticalStyle),
      }}
    >
      <div
        onClick={(e) => {
          if (!onEnterEdit) return;
          e.stopPropagation();
          if (!isEditing) onEnterEdit(activeIdx);
        }}
        onPointerDown={(e) => {
          if (isEditing && e.button === 0) startDrag('move', e);
        }}
        style={textContainerStyle}
        title={
          isEditing
            ? '拖动移动 · 拖角缩放 · 拖顶旋转 · 点外面退出'
            : onEnterEdit
              ? '点字幕 → 拖动编辑'
              : undefined
        }
      >
        {tokens.map((tok, i) => {
          const eff = effectByIdx.get(i);
          // For narrate role: base = yellow, keyword highlight override
          //   color if AI provided one.
          // For emphasis role: base = white (sits on white pill), keyword
          //   override = red (the punchline word). If AI explicitly
          //   provided highlight, use that; otherwise fall back to the
          //   role's keywordColor.
          const baseColor = rolePalette.textColor;
          const tokColor = eff?.highlight ?? baseColor;
          const tokSize = eff?.size
            ? Math.max(8, Math.round(clampSize(eff.size) * scale))
            : orientedSize;
          return (
            <span
              key={i}
              style={{
                fontFamily: font,
                fontSize: tokSize,
                color: tokColor,
                textShadow,
                marginRight: i < tokens.length - 1 ? '0.25em' : 0,
                fontWeight: isBold ? 900 : 400,
                display: 'inline-block',
                verticalAlign: 'baseline',
              }}
            >
              {tok}
            </span>
          );
        })}

        {/* Drag handles — only when in edit mode. Positioned relative
            to the text container so they hug the actual content. */}
        {isEditing && onTransformChange && (
          <>
            <ScaleHandle pos="tl" onPointerDown={(e) => startDrag('scale', e)} />
            <ScaleHandle pos="tr" onPointerDown={(e) => startDrag('scale', e)} />
            <ScaleHandle pos="bl" onPointerDown={(e) => startDrag('scale', e)} />
            <ScaleHandle pos="br" onPointerDown={(e) => startDrag('scale', e)} />
            <RotateHandle onPointerDown={(e) => startDrag('rotate', e)} />
          </>
        )}
      </div>
    </div>
  );
}

// --- Handle subcomponents ----------------------------------------------

const HANDLE_SIZE = 12;

function ScaleHandle({
  pos,
  onPointerDown,
}: {
  pos: 'tl' | 'tr' | 'bl' | 'br';
  onPointerDown: (e: React.PointerEvent) => void;
}): JSX.Element {
  const top = pos.startsWith('t') ? -HANDLE_SIZE / 2 : undefined;
  const bottom = pos.startsWith('b') ? -HANDLE_SIZE / 2 : undefined;
  const left = pos.endsWith('l') ? -HANDLE_SIZE / 2 : undefined;
  const right = pos.endsWith('r') ? -HANDLE_SIZE / 2 : undefined;
  const cursor =
    pos === 'tl' || pos === 'br' ? 'nwse-resize' : 'nesw-resize';
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        top, bottom, left, right,
        width: HANDLE_SIZE,
        height: HANDLE_SIZE,
        background: '#fff',
        border: '2px solid #7aa2f7',
        borderRadius: '50%',
        cursor,
        pointerEvents: 'auto',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
      }}
    />
  );
}

function RotateHandle({
  onPointerDown,
}: {
  onPointerDown: (e: React.PointerEvent) => void;
}): JSX.Element {
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        top: -28,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 20,
        height: 20,
        background: '#7aa2f7',
        borderRadius: '50%',
        cursor: 'grab',
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        color: '#fff',
        boxShadow: '0 2px 4px rgba(0,0,0,0.4)',
        userSelect: 'none',
      }}
      title="拖动旋转"
    >
      ↻
    </div>
  );
}
