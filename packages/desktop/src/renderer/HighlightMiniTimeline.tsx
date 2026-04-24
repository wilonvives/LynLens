import { useEffect, useRef, useState } from 'react';
import type { HighlightVariant } from './core-browser';
import { formatTime } from './util';

/**
 * Mini-timeline for fine-tuning a highlight variant's segment boundaries.
 *
 * Shown beneath the player in the 高光 tab when "编辑段落" mode is on.
 * Each segment is a block whose width is proportional to its source-time
 * duration (so the user sees the playback rhythm at a glance). The left
 * and right edges of every block are drag handles — pull them to extend
 * or shorten that segment's (start, end) in SOURCE time. Commit happens
 * on mouseup via IPC; local preview makes the drag feel immediate.
 *
 * What this component intentionally does NOT do (scope-keeping for the
 * first iteration):
 *   - add / remove segments
 *   - re-order segments
 *   - let the user edit source-time numerically (keyboard input)
 *   - snap to playhead
 * Any of those can grow in as method C / D once we validate the drag flow.
 */
interface Props {
  projectId: string;
  variant: HighlightVariant;
  /** Called after a successful edit so the parent can refresh its copy. */
  onVariantChanged: () => void;
  /**
   * Getter for "where the playhead is right now" in source time. Called
   * when the user hits `+ 加段` so the new segment starts at the video
   * cursor. Passed as a getter instead of a value so we don't need the
   * parent to re-render this panel on every timeupdate.
   */
  getPlayheadSourceSec?: () => number | null;
}

interface DragState {
  segIdx: number;
  edge: 'start' | 'end';
  /** Source time the edge SHOULD be at right now (updated on mousemove). */
  previewValue: number;
  /** Original mouse x and source value, so we can compute delta. */
  anchorX: number;
  anchorValue: number;
}

export function HighlightMiniTimeline({
  projectId,
  variant,
  onVariantChanged,
  getPlayheadSourceSec,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Auto-dismiss the error banner after a few seconds so it doesn't linger
  // when the user moves on to another segment.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(t);
  }, [error]);

  const total = variant.segments.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (total <= 0) return null;

  function startDrag(
    e: React.MouseEvent,
    segIdx: number,
    edge: 'start' | 'end'
  ): void {
    e.stopPropagation();
    e.preventDefault();
    const seg = variant.segments[segIdx];
    const anchor: DragState = {
      segIdx,
      edge,
      previewValue: edge === 'start' ? seg.start : seg.end,
      anchorX: e.clientX,
      anchorValue: edge === 'start' ? seg.start : seg.end,
    };
    setDrag(anchor);

    // Convert mouse delta → source-time delta.
    //
    // We want a consistent "pixels per second" feel regardless of variant
    // length. Fixed rate of 50ms/px gives 1cm of mouse travel ≈ 2s which
    // feels natural on trackpad without being so sensitive that single
    // frame accuracy is lost. The user can always nudge further by
    // dragging more.
    const SEC_PER_PX = 0.05;

    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - anchor.anchorX;
      const rawValue = anchor.anchorValue + dx * SEC_PER_PX;
      setDrag({ ...anchor, previewValue: rawValue });
    };
    const onUp = async (): Promise<void> => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setDrag((current) => {
        if (!current) return null;
        // Commit asynchronously; don't hold the state transition.
        void commit(current);
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  async function deleteSegment(segIdx: number): Promise<void> {
    if (variant.segments.length <= 1) {
      setError('至少要保留一段。如果想整体丢弃,用卡片右上角的「删除」。');
      return;
    }
    try {
      const ok = await window.lynlens.deleteHighlightVariantSegment(
        projectId,
        variant.id,
        segIdx
      );
      if (!ok) {
        setError('删除失败 —— 可能是最后一段或编号越界。');
        return;
      }
      onVariantChanged();
    } catch (err) {
      setError(`删除失败: ${(err as Error).message}`);
    }
  }

  async function addSegment(): Promise<void> {
    try {
      const hint = getPlayheadSourceSec?.() ?? null;
      const slot = await window.lynlens.addHighlightVariantSegment(
        projectId,
        variant.id,
        // Prefer placing the new segment at the current playhead; main
        // validates and falls back automatically if that spot is taken.
        hint
      );
      if (!slot) {
        setError('找不到合适的空位放新段 —— 试试先拖短某些段腾出空间。');
        return;
      }
      onVariantChanged();
    } catch (err) {
      setError(`添加失败: ${(err as Error).message}`);
    }
  }

  async function commit(d: DragState): Promise<void> {
    const seg = variant.segments[d.segIdx];
    let newStart = seg.start;
    let newEnd = seg.end;
    if (d.edge === 'start') newStart = d.previewValue;
    else newEnd = d.previewValue;
    // Tiny no-op — don't fire IPC for sub-frame jitter that wouldn't
    // survive rounding.
    if (Math.abs(d.previewValue - d.anchorValue) < 0.02) return;
    try {
      const ok = await window.lynlens.updateHighlightVariantSegment(
        projectId,
        variant.id,
        d.segIdx,
        newStart,
        newEnd
      );
      if (!ok) {
        setError(
          '调整失败 —— 可能和隔壁段重叠了,或边界超出视频范围,或段长 < 0.2 秒'
        );
        return;
      }
      onVariantChanged();
    } catch (err) {
      setError(`调整失败: ${(err as Error).message}`);
    }
  }

  return (
    <div className="hl-mini-timeline-wrap">
      {error && <div className="hl-mini-err">{error}</div>}
      <div className="hl-mini-toolbar">
        <span className="hl-mini-toolbar-hint">
          拖两端调整 · 悬停显示删除
        </span>
        <button
          className="hl-mini-add"
          onClick={() => void addSegment()}
          title="从视频当前位置开始加 3 秒段;如果位置被占了,自动放到末尾。加完再拖边调整。"
        >
          + 加段
        </button>
      </div>
      <div className="hl-mini-timeline" ref={wrapRef}>
        {variant.segments.map((s, i) => {
          // Use the drag preview for the segment being dragged; original
          // otherwise. This lets adjacent segments render at their real
          // widths even while one is in motion.
          const activeStart = drag && drag.segIdx === i && drag.edge === 'start'
            ? drag.previewValue
            : s.start;
          const activeEnd = drag && drag.segIdx === i && drag.edge === 'end'
            ? drag.previewValue
            : s.end;
          const len = Math.max(0, activeEnd - activeStart);
          const frac = len / total;
          const isDragging = !!drag && drag.segIdx === i;
          return (
            <div
              key={i}
              className={`hl-mini-seg${isDragging ? ' dragging' : ''}`}
              style={{ flex: `0 0 ${frac * 100}%` }}
            >
              <div
                className="hl-mini-handle left"
                onMouseDown={(e) => startDrag(e, i, 'start')}
                title="拖拽调整起点"
              />
              <div className="hl-mini-body">
                <span className="hl-mini-idx">#{i + 1}</span>
                <span className="hl-mini-time">
                  {formatTime(activeStart)} – {formatTime(activeEnd)}
                </span>
                {variant.segments.length > 1 && (
                  <button
                    className="hl-mini-del"
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteSegment(i);
                    }}
                    title="删除这一段"
                  >
                    ×
                  </button>
                )}
              </div>
              <div
                className="hl-mini-handle right"
                onMouseDown={(e) => startDrag(e, i, 'end')}
                title="拖拽调整终点"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
