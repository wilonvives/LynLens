/**
 * 字幕 tab — inline list editor for every transcript segment in the
 * current variant (or all of 整片). Replaces the old PackagingMicroEditor
 * popup. Inspired by 开拍's 文字快剪.
 *
 * For each transcript segment that falls inside the variant's playable
 * source ranges:
 *   - Show a card with timestamp (variant time), text, and editing
 *     controls (PackagingSegmentCard).
 *   - Clicking the timestamp seeks the player there.
 *   - Toggling a token chip adds/removes a wordEffect highlight.
 *
 * Top section:
 *   - "默认样式" controls — the plan-level default font color (applies to
 *     everything except segments with their own overrides).
 *
 * On any edit, this component computes the next plan and bubbles it up
 * via `onPlanChange`. Parent debounces the persistence to setPackagingPlan
 * so we don't spam IPC on every color-picker change.
 */
import { useEffect, useMemo, useRef } from 'react';
import type {
  PackagingPlan,
  PackagingSegment,
  PreviewPlaylistEntry,
  Transcript,
} from '@lynlens/core';
import { PackagingSegmentCard } from './PackagingSegmentCard';

interface Props {
  transcript: Transcript;
  /** Source↔variant playlist; gates which transcript lines show + how to label time. */
  playlist: PreviewPlaylistEntry[];
  /** Current packaging plan (drives the recipe per segment). */
  plan: PackagingPlan;
  /** Current playhead in VARIANT seconds (highlights the active card). */
  currentTimeSec: number;
  /**
   * When set, scrolls the matching segment card into view and pulses it.
   * Driven by clicks on the preview subtitle overlay. Re-set with the
   * same value to re-trigger the scroll/pulse.
   */
  scrollToSegmentIdx?: number | null;
  /** Bumped whenever the parent wants to force a re-scroll on the same idx. */
  scrollToken?: number;
  /** Seek the player to a specific variant time. */
  onSeek: (variantSec: number) => void;
  /** Bubble up plan edits. Parent persists via setPackagingPlan IPC. */
  onPlanChange: (next: PackagingPlan) => void;
}

/** Resolved fallback so the color picker always has a sane initial value. */
const FALLBACK_COLOR = '#ffffff';

function formatVariantTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Map source time → variant time using the playlist; null = outside any range. */
function srcToVariant(srcSec: number, playlist: PreviewPlaylistEntry[]): number | null {
  for (const e of playlist) {
    if (srcSec >= e.srcStart && srcSec <= e.srcEnd) {
      return e.variantStart + (srcSec - e.srcStart);
    }
  }
  return null;
}

export function PackagingSubtitlesTab({
  transcript,
  playlist,
  plan,
  currentTimeSec,
  scrollToSegmentIdx,
  scrollToken,
  onSeek,
  onPlanChange,
}: Props): JSX.Element {
  // Card-DOM map for scroll-into-view when user clicks the preview subtitle.
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  // Scroll the requested segment card into view + pulse it briefly.
  useEffect(() => {
    if (scrollToSegmentIdx === undefined || scrollToSegmentIdx === null) return;
    const el = cardRefs.current.get(scrollToSegmentIdx);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Pulse flash: temporarily add a class via inline style swap. Simpler
    // than CSS keyframes here.
    const prev = el.style.boxShadow;
    el.style.boxShadow = '0 0 0 3px rgba(122, 162, 247, 0.6)';
    el.style.transition = 'box-shadow 0.4s ease';
    const t = setTimeout(() => {
      el.style.boxShadow = prev;
    }, 1000);
    return () => clearTimeout(t);
  }, [scrollToSegmentIdx, scrollToken]);
  // Build the visible list: transcript segments whose midpoint lies
  // inside one of the playlist's source ranges. Carry along the variant-
  // time mapping so each card can display its timestamp + seek correctly.
  const visibleSegments = useMemo(() => {
    type Row = {
      segmentIdx: number;
      text: string;
      variantStart: number;
      variantEnd: number;
    };
    const rows: Row[] = [];
    transcript.segments.forEach((seg, idx) => {
      // A transcript line is "inside" the playlist if its midpoint is
      // inside any playlist entry. Robust against tiny boundary float
      // differences.
      const mid = (seg.start + seg.end) / 2;
      const vStart = srcToVariant(seg.start, playlist);
      const vEnd = srcToVariant(seg.end, playlist);
      const vMid = srcToVariant(mid, playlist);
      if (vMid === null) return;
      rows.push({
        segmentIdx: idx,
        text: seg.text,
        variantStart: vStart ?? vMid,
        variantEnd: vEnd ?? vMid + (seg.end - seg.start),
      });
    });
    return rows.sort((a, b) => a.variantStart - b.variantStart);
  }, [transcript.segments, playlist]);

  const defaultColor = plan.defaults.subtitle?.color ?? FALLBACK_COLOR;

  function upsertSegment(
    segmentIdx: number,
    mutator: (s: PackagingSegment) => PackagingSegment
  ): void {
    const existing = plan.segments.find((s) => s.segmentIdx === segmentIdx);
    const base: PackagingSegment = existing ?? { segmentIdx };
    const nextRecipe = mutator(base);

    // Drop the recipe entirely if every field is empty (clean plan).
    const isEmpty =
      !nextRecipe.subtitle &&
      !nextRecipe.camera &&
      !nextRecipe.transitionToNext &&
      !nextRecipe.textOverlay;
    const isSubtitleEmpty =
      nextRecipe.subtitle &&
      !nextRecipe.subtitle.color &&
      !nextRecipe.subtitle.size &&
      !nextRecipe.subtitle.font &&
      !nextRecipe.subtitle.outline &&
      !nextRecipe.subtitle.bgColor &&
      !nextRecipe.subtitle.position &&
      (!nextRecipe.subtitle.wordEffects || nextRecipe.subtitle.wordEffects.length === 0);
    const stripped: PackagingSegment = {
      ...nextRecipe,
      subtitle: isSubtitleEmpty ? undefined : nextRecipe.subtitle,
    };

    const others = plan.segments.filter((s) => s.segmentIdx !== segmentIdx);
    const nextSegments =
      isEmpty || (isSubtitleEmpty && !stripped.camera && !stripped.transitionToNext && !stripped.textOverlay)
        ? others
        : [...others, stripped].sort((a, b) => a.segmentIdx - b.segmentIdx);

    onPlanChange({ ...plan, segments: nextSegments });
  }

  function setDefaultColor(color: string): void {
    onPlanChange({
      ...plan,
      defaults: {
        ...plan.defaults,
        subtitle: { ...(plan.defaults.subtitle ?? {}), color },
      },
    });
  }

  function setDefaultPosition(position: 'top' | 'center' | 'bottom'): void {
    onPlanChange({
      ...plan,
      defaults: {
        ...plan.defaults,
        subtitle: { ...(plan.defaults.subtitle ?? {}), position },
      },
    });
  }

  const defaultPosition = plan.defaults.subtitle?.position ?? 'bottom';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Plan-level default style — applies to every line unless that
          line has its own override. */}
      <div
        style={{
          padding: 10,
          background: '#181820',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
        }}
      >
        <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 8 }}>
          默认样式 (所有段共用)
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            fontSize: 12,
            color: 'var(--text2)',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            位置
            <div style={{ display: 'inline-flex', border: '1px solid #333', borderRadius: 4, overflow: 'hidden' }}>
              {(['top', 'center', 'bottom'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setDefaultPosition(p)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    background: defaultPosition === p ? 'var(--accent)' : '#181820',
                    color: defaultPosition === p ? '#fff' : 'var(--text2)',
                    border: 'none',
                    borderRight: p !== 'bottom' ? '1px solid #333' : 'none',
                    cursor: 'pointer',
                  }}
                  title={p === 'top' ? '顶部' : p === 'center' ? '中间' : '底部'}
                >
                  {p === 'top' ? '↑' : p === 'center' ? '●' : '↓'}
                </button>
              ))}
            </div>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            颜色
            <input
              type="color"
              value={defaultColor}
              onChange={(e) => setDefaultColor(e.target.value)}
              style={{
              width: 40,
              height: 24,
              padding: 0,
              border: '1px solid #333',
              borderRadius: 3,
              cursor: 'pointer',
              background: 'transparent',
            }}
          />
          </label>
          <span style={{ color: 'var(--text3)', fontSize: 10, flexBasis: '100%' }}>
            字号 / 字体 / 每段单独定位留给 v0.6+。当前所有段共用一个位置 + 颜色。
          </span>
        </div>
      </div>

      {/* Segment list */}
      <div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text3)',
            marginBottom: 6,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>共 {visibleSegments.length} 段</span>
          <span>点段时间跳到该段 · 点词高亮花字</span>
        </div>
        {visibleSegments.length === 0 && (
          <div
            style={{
              padding: 20,
              textAlign: 'center',
              color: 'var(--text3)',
              fontSize: 12,
            }}
          >
            当前变体内没有可显示的字幕段。
          </div>
        )}
        {visibleSegments.map((row) => {
          const recipe = plan.segments.find((s) => s.segmentIdx === row.segmentIdx);
          const isActive =
            currentTimeSec >= row.variantStart && currentTimeSec < row.variantEnd;
          return (
            <div
              key={row.segmentIdx}
              ref={(el) => {
                if (el) cardRefs.current.set(row.segmentIdx, el);
                else cardRefs.current.delete(row.segmentIdx);
              }}
              style={{ borderRadius: 6 }}
            >
            <PackagingSegmentCard
              segmentIdx={row.segmentIdx}
              timeLabel={formatVariantTime(row.variantStart)}
              text={row.text}
              recipe={recipe}
              defaultColor={defaultColor}
              active={isActive}
              onSeek={() => onSeek(row.variantStart)}
              onChange={upsertSegment}
            />
            </div>
          );
        })}
      </div>
    </div>
  );
}
