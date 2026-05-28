import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { HighlightVariant, Range, Transcript, VariantStatus } from '@lynlens/core';
import { effectiveToSource, sourceToEffective } from './core-browser';
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
  /**
   * Ripple cut ranges (source time). Variant segments are STORED in source
   * time but DISPLAYED in effective (post-cut) time so the numbers match the
   * 粗剪 timeline + subtitle panel. Drives source↔effective conversion for
   * both display and inline time-edit. Empty when nothing is cut.
   */
  cutRanges: readonly Range[];
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
  /**
   * Batch-select state. The checkbox is HOVER-REVEALED by default —
   * it only renders when:
   *   - the user is hovering this card, OR
   *   - this card is currently selected, OR
   *   - `batchActive` is true (at least one OTHER card is already
   *     selected → reveal all checkboxes so the user can keep
   *     clicking without hover-hunting through every card).
   * Toggle adds/removes from the parent's selection set.
   */
  selected?: boolean;
  batchActive?: boolean;
  onToggleSelect?: (variant: HighlightVariant) => void;
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
  cutRanges,
  projectId,
  onSelect,
  onSelectSegment,
  onExport,
  onTogglePin,
  onDelete,
  onVariantChanged,
  selected,
  batchActive,
  onToggleSelect,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // Title inline-rename state.
  // null = not editing; string = draft text. We DON'T initialise to the
  // current title because that would mean a stale snapshot if the variant
  // gets renamed elsewhere; we seed on click instead.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  // AI 🪄 enrich in-flight indicator.
  const [enriching, setEnriching] = useState(false);
  // Secondary-actions overflow menu (⋯) — keeps the visible button row
  // short so cards don't wrap when titles are long.
  // Anchor coords + open flag. Stored together so the menu is rendered
  // ONLY when both moreOpen=true AND coords are set (avoids a flash at
  // 0,0 on first open). Coords are in viewport-fixed space so the menu
  // can escape the variant card's overflow:hidden ancestor (which was
  // clipping the menu behind the waveform).
  const [menuAnchor, setMenuAnchor] = useState<
    | { x: number; y: number; placement: 'below' | 'above' }
    | null
  >(null);
  // Hover state — drives hover-reveal of the batch-select checkbox so
  // it doesn't clutter the UI by default. See `Props.batchActive`.
  const [hovering, setHovering] = useState(false);
  const moreOpen = menuAnchor !== null;
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
    // EFFECTIVE seconds (what the user typed / sees). Converted to source
    // before persisting — variant segments are stored in source time.
    newEffSec: number
  ): Promise<boolean> {
    if (!projectId) return false;
    const seg = variant.segments[segIdx];
    const newSrcSec = effectiveToSource(newEffSec, cutRanges);
    const newStart = edge === 'start' ? newSrcSec : seg.start;
    const newEnd = edge === 'end' ? newSrcSec : seg.end;
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
    // Nudge in EFFECTIVE space so the displayed number moves by exactly the
    // delta the button promises (±0.1 / ±0.5). commitTimeEdit converts back.
    const curEff = sourceToEffective(edge === 'start' ? seg.start : seg.end, cutRanges);
    const nextEff = Math.max(0, curEff + deltaSec);
    // Optimistic draft update so the input's number jumps immediately.
    // Same pattern as SubtitlePanel's TimestampEditor.
    setEditing((prev) =>
      prev && prev.segIdx === segIdx && prev.kind === edge
        ? { ...prev, draft: formatTime(nextEff) }
        : prev
    );
    void commitTimeEdit(segIdx, edge, nextEff);
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

  /**
   * MOVE one segment out as its own new variant. Source variant loses
   * the segment (destructive). Used for "分类出来 / this piece is its
   * own thing now" UX. Refused server-side when source only has 1
   * segment — the button is also disabled in that case but the check
   * is duplicated as defence.
   */
  async function extractSegment(segIdx: number): Promise<void> {
    if (!projectId) return;
    if (variant.segments.length <= 1) {
      setEditError('当前变体只剩一段,无法再剥离。想拆分整段视频请用「+ 加段」.');
      return;
    }
    try {
      const created = await window.lynlens.extractHighlightSegment(
        projectId,
        variant.id,
        segIdx
      );
      setEditError(null);
      await onVariantChanged();
      // Quick visible feedback — toast-style alert. Could be replaced
      // with a non-blocking banner later.
      alert(`✓ 已移动这段到新变体: "${created.title}"`);
    } catch (err) {
      setEditError(`移动失败: ${(err as Error).message}`);
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

  /**
   * Commit the title draft via IPC. Empty / unchanged → revert silently.
   * Errors surface in editError row.
   */
  async function commitTitleEdit(draft: string): Promise<void> {
    const trimmed = draft.trim();
    setTitleDraft(null);
    if (!projectId) return;
    if (!trimmed || trimmed === variant.title) return;
    try {
      const ok = await window.lynlens.renameHighlightVariant(
        projectId,
        variant.id,
        trimmed
      );
      if (!ok) {
        setEditError('改名失败 (空标题或变体已被删除)');
        return;
      }
      setEditError(null);
      await onVariantChanged();
    } catch (err) {
      setEditError(`改名失败: ${(err as Error).message}`);
    }
  }

  /**
   * 🪄 ask the AI to fill in the variant's title + per-segment reasons.
   * Disabled if there's no transcript (server-side check will throw).
   */
  async function doEnrich(e: React.MouseEvent): Promise<void> {
    e.stopPropagation();
    if (enriching || !projectId) return;
    setEnriching(true);
    setEditError(null);
    try {
      await window.lynlens.enrichHighlightVariant(projectId, variant.id);
      await onVariantChanged();
    } catch (err) {
      setEditError(`AI 整理失败: ${(err as Error).message}`);
    } finally {
      setEnriching(false);
    }
  }

  /**
   * Collect the variant's subtitle text. `withTimestamps` prefixes each
   * line with its position in the VARIANT's own timeline (not the source
   * video), e.g. "[00:04] …" — i.e. where the line actually appears in
   * the exported variant clip.
   *
   * Why variant-relative: the variant is a re-cut + reordered subset of
   * the source. The raw transcript-segment start times (which is what we
   * used to print) are source-video seconds and are meaningless once the
   * footage is concatenated into the highlight reel. We walk the variant
   * segments in PLAYBACK order, accumulating elapsed duration, and place
   * each line at `elapsed + (lineStart clamped into this segment) -
   * segmentStart`.
   */
  function collectVariantText(withTimestamps: boolean): string {
    if (!transcript) return '';
    const lines: string[] = [];
    let elapsed = 0; // variant-relative seconds before the current segment
    for (const vs of variant.segments) {
      for (const t of transcript.segments) {
        if (t.end <= vs.start || t.start >= vs.end) continue;
        const txt = t.text.trim();
        if (!txt) continue;
        if (withTimestamps) {
          // Onset of this line, in source seconds. Whisper's segment.start
          // tends to sit ~0.2-0.5s early (it marks the breath/onset, not
          // the first spoken syllable), which makes the copied timestamp
          // feel "ahead" of the audio. When word-level timing exists, use
          // the first WORD that actually lands inside this segment — much
          // closer to when the words are heard. Fall back to the clamped
          // segment start otherwise.
          let srcStart = Math.max(t.start, vs.start);
          if (t.words && t.words.length > 0) {
            const firstInSeg = t.words.find(
              (w) => w.start >= vs.start && w.start < vs.end
            );
            if (firstInSeg) srcStart = firstInSeg.start;
          }
          const within = Math.max(0, srcStart - vs.start);
          lines.push(`[${formatTime(elapsed + within)}] ${txt}`);
        } else {
          lines.push(txt);
        }
      }
      elapsed += vs.end - vs.start;
    }
    return lines.join('\n');
  }

  async function doCopy(withTimestamps: boolean): Promise<void> {
    const text = collectVariantText(withTimestamps);
    if (!text) {
      alert('这个变体对应的字幕段为空。');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
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
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      role="button"
    >
      <div className="variant-card-head">
        <div className="variant-card-title-row">
          {/* Expand toggle — leftmost icon. ▸ collapsed, ▾ expanded.
              Replaces the old text "段落 / 收起" button; moved up here so
              it's the row's leading affordance. */}
          <button
            className="variant-card-expand"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            title={expanded ? '收起段落详情' : '展开看每段时间 + 备注'}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text2)',
              cursor: 'pointer',
              fontSize: 11,
              padding: '0 4px 0 0',
              lineHeight: 1,
              flexShrink: 0,
            }}
          >
            {expanded ? '▾' : '▸'}
          </button>
          {/* Batch-select checkbox — HOVER-REVEALED to keep cards
              clean by default. Becomes visible if user hovers, OR if
              already selected, OR if batch mode is "active" (≥1 other
              card selected somewhere → reveal all so multi-select
              doesn't require hover-hunting). */}
          {onToggleSelect &&
            (hovering || selected || batchActive) && (
            <input
              type="checkbox"
              checked={!!selected}
              onClick={(e) => e.stopPropagation()}
              onChange={() => onToggleSelect(variant)}
              title={selected ? '取消选中' : '选中以批量操作'}
              style={{
                margin: 0,
                marginRight: 4,
                accentColor: 'var(--accent)',
                cursor: 'pointer',
              }}
            />
          )}
          <span className="variant-card-index">#{index}</span>
          {/* Pinned state is shown by the card's yellow left border
              (.variant-card.pinned) — no separate star needed; it'd be
              redundant. */}
          {titleDraft !== null ? (
            // Inline title editor — autofocus on mount, blur or Enter to
            // commit, Escape to cancel.
            <input
              autoFocus
              className="variant-card-title-input"
              value={titleDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setTitleDraft(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                  void commitTitleEdit(titleDraft);
                } else if (e.key === 'Escape') {
                  setTitleDraft(null);
                }
              }}
              onBlur={() => void commitTitleEdit(titleDraft)}
              maxLength={40}
              style={{
                background: '#1a1a26',
                border: '1px solid var(--accent)',
                borderRadius: 4,
                color: '#fff',
                padding: '2px 6px',
                fontSize: 'inherit',
                fontWeight: 600,
                minWidth: 180,
                maxWidth: 320,
              }}
            />
          ) : (
            <span
              className="variant-card-title"
              onClick={(e) => {
                // Inline rename — click steals from the row-level
                // onSelect handler. Pencil cursor signals editability.
                e.stopPropagation();
                setTitleDraft(variant.title);
              }}
              title="点击改名"
              style={{ cursor: 'text' }}
            >
              {variant.title}
            </span>
          )}
          <span className="variant-card-style">{STYLE_LABEL[variant.style]}</span>
          {active && !isBroken && <span className="variant-card-playing">正在播放</span>}
        </div>
        <div
          className="variant-card-meta"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span>
            {variant.durationSeconds.toFixed(1)} 秒 · {variant.segments.length}
          </span>
          {/* ⋯ overflow menu trigger — sits between the meta text and 导出
              in the card head: "几秒几段  ⋯  导出". Small + understated so
              it reads as a secondary affordance next to the primary 导出.
              The menu itself is portaled to <body> (escapes the card's
              stacking context so the waveform doesn't paint over it). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (moreOpen) {
                setMenuAnchor(null);
                return;
              }
              const btn = e.currentTarget.getBoundingClientRect();
              const ESTIMATED_MENU_H = 240;
              const placeBelow =
                btn.bottom + ESTIMATED_MENU_H < window.innerHeight - 16;
              setMenuAnchor({
                x: btn.right, // right-align
                y: placeBelow ? btn.bottom + 4 : btn.top - 4,
                placement: placeBelow ? 'below' : 'above',
              });
            }}
            title="更多操作"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            style={{
              fontSize: 13,
              padding: '2px 7px',
              lineHeight: 1.2,
              flexShrink: 0,
              color: 'var(--text2)',
            }}
          >
            ⋯
          </button>
          {/* Compact 导出 button — rightmost in the card head, hugging the
              edge. Always one click away regardless of expanded state. */}
          <button
            className="primary"
            onClick={(e) => {
              e.stopPropagation();
              void doExport(e);
            }}
            disabled={exporting || isBroken}
            title={isBroken ? '变体已失效,无法导出' : '导出这个变体为视频文件'}
            style={{
              fontSize: 11,
              padding: '2px 10px',
              lineHeight: 1.4,
              flexShrink: 0,
            }}
          >
            {exporting ? '导出中…' : '导出'}
          </button>
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

      {/* ⋯ menu portal. The 段落 toggle + ⋯ trigger + 导出 all live in the
          card head row now; this is just the portal host (rendered into
          <body>, so tree position is irrelevant). Rendered only when open
          so it doesn't add an empty flex row + gap under the head. */}
      {moreOpen &&
          menuAnchor &&
          createPortal(
            <>
              {/* Click-outside backdrop, viewport-wide. Eats the next
                  click to close the menu. */}
              <div
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuAnchor(null);
                }}
                style={{
                  position: 'fixed',
                  inset: 0,
                  zIndex: 9999,
                  background: 'transparent',
                }}
              />
              <div
                role="menu"
                style={{
                  position: 'fixed',
                  left: menuAnchor.x,
                  // Right-align: shift the menu left by its own width
                  // via transform. menuAnchor.x is the button's right
                  // edge.
                  transform:
                    menuAnchor.placement === 'below'
                      ? 'translate(-100%, 0)'
                      : 'translate(-100%, -100%)',
                  top: menuAnchor.y,
                  zIndex: 10000,
                  minWidth: 200,
                  background: '#1a1a26',
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                  padding: 4,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                }}
              >
                <MenuItem
                  disabled={!projectId || isBroken}
                  onClick={() => {
                    setMenuAnchor(null);
                    void addSegment();
                  }}
                  label="➕ 加一段"
                  hint="在末尾追加 3 秒空段"
                />
                <MenuItem
                  disabled={enriching || !transcript || !projectId}
                  onClick={() => {
                    setMenuAnchor(null);
                    void doEnrich({ stopPropagation: () => {} } as unknown as React.MouseEvent);
                  }}
                  label={enriching ? '🪄 整理中…' : '🪄 AI 起名 / 备注'}
                  hint={transcript ? 'AI 看内容自动写标题和备注' : '需要先生成字幕'}
                />
                {/* 复制文案 → hover reveals a side flyout to pick plain
                    text vs. timestamped text. Both close the menu after. */}
                <CopyMenuItem
                  disabled={!transcript}
                  onCopyPlain={() => {
                    setMenuAnchor(null);
                    void doCopy(false);
                  }}
                  onCopyTimestamped={() => {
                    setMenuAnchor(null);
                    void doCopy(true);
                  }}
                />
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    void onTogglePin(variant);
                  }}
                  label={isPinned ? '⭐️ 取消收藏' : '⭐️ 收藏'}
                  hint={isPinned ? '下次生成会覆盖' : '保护,防止生成时被覆盖'}
                />
                <div style={{ height: 1, background: '#2a2a2a', margin: '2px 0' }} />
                <MenuItem
                  onClick={() => {
                    setMenuAnchor(null);
                    if (confirm('永久删除这个变体?')) void onDelete(variant);
                  }}
                  label="🗑 删除变体"
                  hint="永久删除"
                  destructive
                />
              </div>
            </>,
            document.body
          )}

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
                    value={sourceToEffective(s.start, cutRanges)}
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
                    value={sourceToEffective(s.end, cutRanges)}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      void extractSegment(i);
                    }}
                    disabled={variant.segments.length <= 1}
                    title={
                      variant.segments.length <= 1
                        ? '当前变体只剩一段,无法再剥离'
                        : '把这段拿走,变成一个独立的新变体 (原变体会失去这段)'
                    }
                    style={{
                      fontSize: 13,
                      padding: '0 8px',
                      width: 28,
                      minWidth: 28,
                      color: 'var(--accent)',
                      borderColor: 'var(--accent)',
                      lineHeight: 1,
                    }}
                  >
                    ⇲
                  </button>
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

/**
 * "复制文案" menu row with a hover-reveal side flyout offering two copy
 * formats: plain text or timestamped text. Flyout opens to the LEFT
 * (right: 100%) because the parent ⋯ menu is right-aligned near the
 * screen edge — a right-side flyout would overflow. Stays open while the
 * cursor is anywhere over the row or the flyout (shared onMouseEnter/Leave
 * on the wrapper).
 */
function CopyMenuItem({
  disabled,
  onCopyPlain,
  onCopyTimestamped,
}: {
  disabled?: boolean;
  onCopyPlain: () => void;
  onCopyTimestamped: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => !disabled && setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        disabled={disabled}
        title={disabled ? '需要先生成字幕' : '把这个变体的字幕拼起来复制'}
        style={{
          width: '100%',
          textAlign: 'left',
          padding: '6px 10px',
          background: open && !disabled ? '#252533' : 'transparent',
          border: 'none',
          color: disabled ? 'var(--text3)' : 'var(--text1)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          borderRadius: 4,
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 6,
        }}
      >
        <span>📋 复制文案</span>
        <span style={{ color: 'var(--text3)', fontSize: 11 }}>▸</span>
      </button>
      {open && !disabled && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            right: '100%',
            top: 0,
            marginRight: 4,
            minWidth: 150,
            background: '#1a1a26',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            padding: 4,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          <MenuItem
            onClick={onCopyPlain}
            label="纯文本"
            hint="只复制字幕文字"
          />
          <MenuItem
            onClick={onCopyTimestamped}
            label="带时间戳"
            hint="每行前面带 [时间]"
          />
        </div>
      )}
    </div>
  );
}

/**
 * Single row inside the variant card's ⋯ overflow menu. Plain button
 * styled to look like a menu item; destructive items get a red tint.
 */
function MenuItem({
  label,
  hint,
  onClick,
  disabled,
  destructive,
}: {
  label: string;
  hint?: string;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={hint}
      style={{
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        background: 'transparent',
        border: 'none',
        color: disabled ? 'var(--text3)' : destructive ? '#ff6b6b' : 'var(--text1)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 4,
        fontSize: 13,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 1,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = '#252533';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent';
      }}
    >
      <span>{label}</span>
      {hint && (
        <span style={{ fontSize: 10, color: 'var(--text3)', fontWeight: 400 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
