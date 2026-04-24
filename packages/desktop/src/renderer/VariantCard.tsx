import { useState } from 'react';
import type { HighlightVariant, Transcript, VariantStatus } from '@lynlens/core';
import { formatTime } from './util';

interface Props {
  variant: HighlightVariant;
  index: number;
  /** Whether this card is the one currently cued up in the player. */
  active: boolean;
  /** Which segment is currently playing (only meaningful when active). */
  playingSegIdx: number | null;
  /**
   * Validity of the variant relative to the current project state. See
   * core/variant-status.ts. Drives the banner + disables playback when
   * the variant has been broken by later cut / transcript changes.
   */
  status: VariantStatus;
  /**
   * The full transcript (source time). Used to assemble the variant's
   * text content when the user hits 「复制文案」.
   */
  transcript: Transcript | null;
  /** Active project id — needed for the segment-edit IPCs. */
  projectId: string | null;
  onSelect: (variant: HighlightVariant) => void;
  onSelectSegment: (variant: HighlightVariant, segIdx: number) => void;
  onExport: (variant: HighlightVariant) => Promise<void>;
  onTogglePin: (variant: HighlightVariant) => Promise<void>;
  onDelete: (variant: HighlightVariant) => Promise<void>;
  /**
   * Any segment-list edit succeeded — parent should refetch the variant
   * list so the UI reflects the new times / reason / order.
   */
  onVariantChanged: () => void | Promise<void>;
}

const STYLE_LABEL: Record<HighlightVariant['style'], string> = {
  default: '默认',
  hero: '片头',
  'ai-choice': 'AI 自由',
};

// ─────────────────────────────────────────────────────────────────────
// Module-level helpers + subcomponents.
// These MUST live outside the VariantCard function body. Defining them
// inline would recreate the component identity on every parent render,
// which React treats as a fresh mount — any <input> inside loses focus
// and cursor position on every keystroke (the "cursor jumps to front"
// bug we hit). Hoisting them up fixes it.
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse a human-typed timestamp. Accepts "SS", "SS.ms", "MM:SS",
 * "MM:SS.ms", or "H:MM:SS[.ms]". Returns null if unparseable.
 */
function parseTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3) return null;
  let h = 0;
  let m = 0;
  let sec = 0;
  if (parts.length === 1) sec = Number(parts[0]);
  else if (parts.length === 2) {
    m = Number(parts[0]);
    sec = Number(parts[1]);
  } else {
    h = Number(parts[0]);
    m = Number(parts[1]);
    sec = Number(parts[2]);
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  if (h < 0 || m < 0 || sec < 0) return null;
  return h * 3600 + m * 60 + sec;
}

interface TimeCellProps {
  value: number;
  editing: { draft: string } | null;
  onJump: () => void;
  onBeginEdit: (initial: string) => void;
  onDraftChange: (draft: string) => void;
  onCommit: (newValueSec: number | null) => void | Promise<void>;
  onNudge: (deltaSec: number) => void;
}

function EditableTimeCell({
  value,
  editing,
  onJump,
  onBeginEdit,
  onDraftChange,
  onCommit,
  onNudge,
}: TimeCellProps): JSX.Element {
  if (editing) {
    return (
      <span className="variant-seg-time-edit">
        <input
          autoFocus
          className="variant-seg-time-input"
          value={editing.draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const parsed = parseTime(editing.draft);
              void onCommit(parsed);
            } else if (e.key === 'Escape') {
              void onCommit(null);
            }
          }}
          onBlur={() => {
            const parsed = parseTime(editing.draft);
            void onCommit(parsed);
          }}
        />
        <span className="variant-seg-nudge">
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onNudge(-0.5)}>
            −0.5
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onNudge(-0.1)}>
            −0.1
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onNudge(0.1)}>
            +0.1
          </button>
          <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => onNudge(0.5)}>
            +0.5
          </button>
        </span>
      </span>
    );
  }
  return (
    <span
      className="variant-seg-time"
      onClick={(e) => {
        e.stopPropagation();
        // Alt/⌘-click = jump to this segment; plain click = inline edit.
        if (e.altKey || e.metaKey) {
          onJump();
          return;
        }
        onBeginEdit(formatTime(value));
      }}
      title="点击编辑 (Alt/⌘-click 跳转播放)"
    >
      {formatTime(value)}
    </span>
  );
}

interface ReasonProps {
  value: string;
  editing: { draft: string } | null;
  onBeginEdit: (initial: string) => void;
  onDraftChange: (draft: string) => void;
  onCommit: (newValue: string | null) => void | Promise<void>;
}

function EditableReason({
  value,
  editing,
  onBeginEdit,
  onDraftChange,
  onCommit,
}: ReasonProps): JSX.Element {
  if (editing) {
    return (
      <textarea
        autoFocus
        className="variant-seg-reason-input"
        value={editing.draft}
        rows={2}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void onCommit(editing.draft);
          } else if (e.key === 'Escape') {
            void onCommit(null);
          }
        }}
        onBlur={() => void onCommit(editing.draft)}
      />
    );
  }
  return (
    <div
      className={`variant-seg-reason${value ? '' : ' empty'}`}
      onClick={(e) => {
        e.stopPropagation();
        onBeginEdit(value);
      }}
      title="点击编辑描述"
    >
      {value || '(点击添加描述)'}
    </div>
  );
}

/**
 * One-stop display for a highlight variant. Click the card to cue it up in
 * the left-side player; click a segment row to jump straight to that piece.
 * An active card gets an amber outline so the user can see which variant is
 * currently playing.
 */
export function VariantCard({
  variant,
  index,
  active,
  playingSegIdx,
  status,
  transcript,
  projectId,
  onSelect,
  onSelectSegment,
  onExport,
  onTogglePin,
  onDelete,
  onVariantChanged,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    | null
    | { segIdx: number; kind: 'start' | 'end' | 'reason'; draft: string }
  >(null);
  // Drag-and-drop reorder state. `dragSrcIdx` = the segment being dragged;
  // `dragHoverIdx` = the row the cursor is over right now (null = none).
  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null);
  const [dragHoverIdx, setDragHoverIdx] = useState<number | null>(null);
  const isBroken = status === 'cut-invalidated' || status === 'transcript-missing';
  const isStale = status === 'transcript-stale';
  const isPinned = !!variant.pinned;

  async function commitTimeEdit(
    segIdx: number,
    edge: 'start' | 'end',
    newValueSec: number
  ): Promise<boolean> {
    if (!projectId) return false;
    const seg = variant.segments[segIdx];
    const newStart = edge === 'start' ? newValueSec : seg.start;
    const newEnd = edge === 'end' ? newValueSec : seg.end;
    try {
      const ok = await window.lynlens.updateHighlightVariantSegment(
        projectId,
        variant.id,
        segIdx,
        newStart,
        newEnd
      );
      if (!ok) {
        setEditError(
          '调整失败 —— 可能和其他段重叠,或边界超出视频,或长度 < 0.2 秒'
        );
        return false;
      }
      setEditError(null);
      await onVariantChanged();
      return true;
    } catch (err) {
      setEditError(`失败: ${(err as Error).message}`);
      return false;
    }
  }

  function nudgeTime(
    segIdx: number,
    edge: 'start' | 'end',
    deltaSec: number
  ): void {
    const seg = variant.segments[segIdx];
    const cur = edge === 'start' ? seg.start : seg.end;
    const next = Math.max(0, cur + deltaSec);
    // Optimistic draft update so the input's number jumps immediately.
    // Same pattern as SubtitlePanel's TimestampEditor.
    setEditing((prev) =>
      prev && prev.segIdx === segIdx && prev.kind === edge
        ? { ...prev, draft: formatTime(next) }
        : prev
    );
    void commitTimeEdit(segIdx, edge, next);
  }

  async function commitReasonEdit(segIdx: number, newReason: string): Promise<void> {
    if (!projectId) return;
    const seg = variant.segments[segIdx];
    try {
      const ok = await window.lynlens.updateHighlightVariantSegment(
        projectId,
        variant.id,
        segIdx,
        seg.start,
        seg.end,
        newReason
      );
      if (!ok) {
        setEditError('描述保存失败');
        return;
      }
      setEditError(null);
      await onVariantChanged();
    } catch (err) {
      setEditError(`失败: ${(err as Error).message}`);
    }
  }

  async function deleteSegment(segIdx: number): Promise<void> {
    if (!projectId) return;
    if (variant.segments.length <= 1) {
      setEditError('至少要保留一段。如果想整体丢弃,用卡片上的「删除」。');
      return;
    }
    try {
      const ok = await window.lynlens.deleteHighlightVariantSegment(
        projectId,
        variant.id,
        segIdx
      );
      if (!ok) {
        setEditError('删除失败');
        return;
      }
      setEditError(null);
      await onVariantChanged();
    } catch (err) {
      setEditError(`失败: ${(err as Error).message}`);
    }
  }

  async function moveSegmentTo(fromIdx: number, toIdx: number): Promise<void> {
    if (!projectId) return;
    if (fromIdx === toIdx) return;
    try {
      const ok = await window.lynlens.reorderHighlightVariantSegment(
        projectId,
        variant.id,
        fromIdx,
        toIdx
      );
      if (!ok) {
        setEditError('重排失败');
        return;
      }
      setEditError(null);
      await onVariantChanged();
    } catch (err) {
      setEditError(`失败: ${(err as Error).message}`);
    }
  }

  async function addSegment(): Promise<void> {
    if (!projectId) return;
    try {
      const slot = await window.lynlens.addHighlightVariantSegment(
        projectId,
        variant.id,
        null
      );
      if (!slot) {
        setEditError('找不到空位放新段 —— 试试先拖短某些段腾出空间。');
        return;
      }
      setEditError(null);
      setExpanded(true);
      await onVariantChanged();
    } catch (err) {
      setEditError(`失败: ${(err as Error).message}`);
    }
  }

  async function doExport(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (exporting) return;
    setExporting(true);
    try {
      await onExport(variant);
    } finally {
      setExporting(false);
    }
  }

  function collectVariantText(): string {
    if (!transcript) return '';
    const lines: string[] = [];
    for (const vs of variant.segments) {
      for (const t of transcript.segments) {
        if (t.end <= vs.start || t.start >= vs.end) continue;
        const txt = t.text.trim();
        if (txt) lines.push(txt);
      }
    }
    return lines.join('\n');
  }

  async function doCopy(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    const text = collectVariantText();
    if (!text) {
      alert('这个变体对应的字幕段为空。');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch (err) {
      alert(`复制失败: ${(err as Error).message}`);
    }
  }

  const cardClass = [
    'variant-card',
    active ? 'active' : '',
    isBroken ? 'broken' : '',
    isStale ? 'stale' : '',
    isPinned ? 'pinned' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cardClass}
      onClick={() => !isBroken && onSelect(variant)}
      role="button"
    >
      <div className="variant-card-head">
        <div className="variant-card-title-row">
          <span className="variant-card-index">#{index}</span>
          <span className="variant-card-title">{variant.title}</span>
          <span className="variant-card-style">{STYLE_LABEL[variant.style]}</span>
          {isPinned && (
            <span className="variant-card-pin-badge" title="已收藏,不会被「生成新一批」覆盖">
              已收藏
            </span>
          )}
          {active && !isBroken && <span className="variant-card-playing">正在播放</span>}
        </div>
        <div className="variant-card-meta">
          {variant.durationSeconds.toFixed(1)} 秒 · {variant.segments.length} 段
        </div>
      </div>

      {isBroken && (
        <div className="variant-card-banner broken">
          {status === 'cut-invalidated'
            ? '有段落落入新的剪切里,无法播放。回到粗剪撤销剪切可恢复,或重新生成这个变体。'
            : '项目的转录丢失,无法验证此变体。重新生成转录后再试。'}
        </div>
      )}
      {isStale && (
        <div className="variant-card-banner stale">
          粗剪或转录被修改过,选段位置可能偏移。仍可播放,但结果可能和当初预期不一样。
        </div>
      )}

      <div className="variant-card-actions" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((v) => !v);
          }}
        >
          {expanded ? '收起段落' : '查看段落'}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void addSegment();
          }}
          disabled={!projectId || isBroken}
          title="在变体末尾追加一段(默认 3 秒,加完可在展开视图里调)"
        >
          + 加段
        </button>
        <button
          className="primary"
          onClick={doExport}
          disabled={exporting || isBroken}
          title={isBroken ? '变体已失效,无法导出' : undefined}
        >
          {exporting ? '导出中...' : '导出'}
        </button>
        <button onClick={doCopy} disabled={!transcript} title="把这个变体对应的字幕拼起来复制到剪贴板">
          {copied ? '已复制' : '复制文案'}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            void onTogglePin(variant);
          }}
          className={isPinned ? 'pin-on' : 'pin-off'}
          title={isPinned ? '取消收藏(下次生成会覆盖)' : '收藏,防止被下次生成覆盖'}
        >
          {isPinned ? '取消收藏' : '收藏'}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm('永久删除这个变体?')) void onDelete(variant);
          }}
          title="永久删除这个变体"
        >
          删除
        </button>
      </div>

      {expanded && (
        <div className="variant-card-segments" onClick={(e) => e.stopPropagation()}>
          {editError && <div className="variant-seg-err">{editError}</div>}
          {variant.segments.map((s, i) => {
            const isPlayingRow = active && playingSegIdx === i;
            const editingThis = editing && editing.segIdx === i ? editing : null;
            const isDragSrc = dragSrcIdx === i;
            const isDragHover = dragHoverIdx === i && dragSrcIdx !== null && dragSrcIdx !== i;
            return (
              <div
                key={i}
                className={
                  'variant-seg-row editable' +
                  (isPlayingRow ? ' playing' : '') +
                  (isDragSrc ? ' drag-src' : '') +
                  (isDragHover ? ' drag-hover' : '')
                }
                // HTML5 DnD for reorder. The whole row is draggable; clicks
                // on inputs / buttons still fire normally because the OS
                // only starts a drag after a threshold movement. We don't
                // make individual buttons draggable=false — it's not needed.
                draggable={editing?.segIdx !== i}
                onDragStart={(e) => {
                  setDragSrcIdx(i);
                  // dataTransfer required by Firefox to trigger drag.
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i));
                }}
                onDragOver={(e) => {
                  if (dragSrcIdx === null || dragSrcIdx === i) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragHoverIdx !== i) setDragHoverIdx(i);
                }}
                onDragLeave={() => {
                  if (dragHoverIdx === i) setDragHoverIdx(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragSrcIdx !== null && dragSrcIdx !== i) {
                    void moveSegmentTo(dragSrcIdx, i);
                  }
                  setDragSrcIdx(null);
                  setDragHoverIdx(null);
                }}
                onDragEnd={() => {
                  setDragSrcIdx(null);
                  setDragHoverIdx(null);
                }}
              >
                <div className="variant-seg-row-head">
                  {/* Grip handle — purely visual cue that the row is
                      draggable. The `draggable` attribute is on the row
                      itself so clicking the grip or anywhere else works. */}
                  <span className="variant-seg-grip" title="拖动整行换序">
                    ::
                  </span>
                  <span className="variant-seg-idx">{i + 1}</span>
                  <EditableTimeCell
                    value={s.start}
                    editing={editingThis && editingThis.kind === 'start' ? editingThis : null}
                    onJump={() => onSelectSegment(variant, i)}
                    onBeginEdit={(draft) =>
                      setEditing({ segIdx: i, kind: 'start', draft })
                    }
                    onDraftChange={(d) =>
                      setEditing((cur) =>
                        cur && cur.segIdx === i && cur.kind === 'start'
                          ? { ...cur, draft: d }
                          : cur
                      )
                    }
                    onCommit={async (val) => {
                      setEditing(null);
                      if (val != null) await commitTimeEdit(i, 'start', val);
                    }}
                    onNudge={(delta) => nudgeTime(i, 'start', delta)}
                  />
                  <span className="variant-seg-sep">-</span>
                  <EditableTimeCell
                    value={s.end}
                    editing={editingThis && editingThis.kind === 'end' ? editingThis : null}
                    onJump={() => onSelectSegment(variant, i)}
                    onBeginEdit={(draft) =>
                      setEditing({ segIdx: i, kind: 'end', draft })
                    }
                    onDraftChange={(d) =>
                      setEditing((cur) =>
                        cur && cur.segIdx === i && cur.kind === 'end'
                          ? { ...cur, draft: d }
                          : cur
                      )
                    }
                    onCommit={async (val) => {
                      setEditing(null);
                      if (val != null) await commitTimeEdit(i, 'end', val);
                    }}
                    onNudge={(delta) => nudgeTime(i, 'end', delta)}
                  />
                  <span className="variant-seg-dur">({(s.end - s.start).toFixed(1)}s)</span>
                  <span className="variant-seg-row-spacer" />
                  <button
                    className="variant-seg-del"
                    onClick={() => void deleteSegment(i)}
                    disabled={variant.segments.length <= 1}
                    title={
                      variant.segments.length <= 1
                        ? '至少要保留一段'
                        : '删除这一段'
                    }
                  >
                    ×
                  </button>
                </div>
                <EditableReason
                  value={s.reason ?? ''}
                  editing={editingThis && editingThis.kind === 'reason' ? editingThis : null}
                  onBeginEdit={(draft) =>
                    setEditing({ segIdx: i, kind: 'reason', draft })
                  }
                  onDraftChange={(d) =>
                    setEditing((cur) =>
                      cur && cur.segIdx === i && cur.kind === 'reason'
                        ? { ...cur, draft: d }
                        : cur
                    )
                  }
                  onCommit={async (val) => {
                    setEditing(null);
                    if (val !== null && val !== (s.reason ?? '')) {
                      await commitReasonEdit(i, val);
                    }
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
