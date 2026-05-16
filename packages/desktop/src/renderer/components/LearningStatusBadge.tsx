import { useEffect, useRef, useState } from 'react';
import { LearningManageDialog } from '../LearningManageDialog';

interface CorrectionEntry {
  from: string;
  to: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenInProjects: string[];
}

interface Snapshot {
  autoCorrectionCount: number;
  properNounCount: number;
  keepOriginalCount: number;
  recentCorrections: CorrectionEntry[];
  pendingPromotions: CorrectionEntry[];
}

/**
 * Compact chip showing what LynLens has learned + click-to-expand popover
 * with recent corrections and a "manage" link. Self-contained: fetches its
 * own snapshot, refreshes on visibility changes + when the popover opens.
 *
 * Placement: top of SubtitlePanel's settings bar. Always visible (no toast
 * notifications — the chip itself signals "I'm learning" by its growing count).
 */
export function LearningStatusBadge(): JSX.Element {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [open, setOpen] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Initial load + refresh whenever the popover opens (so it shows latest counts).
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (open) void refresh();
  }, [open]);

  // Click-outside to close popover. Matches the ExportMenu pattern in this file.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  async function refresh(): Promise<void> {
    try {
      const data = await window.lynlens.learningGetSnapshot();
      setSnap(data);
    } catch {
      // Silent — never block the panel if learning IPC isn't up yet.
      setSnap(null);
    }
  }

  async function forget(kind: 'correction' | 'noun' | 'keep', key: string): Promise<void> {
    try {
      await window.lynlens.learningForget(kind, key);
      await refresh();
    } catch {
      /* noop */
    }
  }
  // The "manual promote" button + IPC (learningPromote) used to live here
  // for the count-3 threshold model. With PROMOTION_THRESHOLD now 1 every
  // correction auto-promotes immediately, so pendingPromotions is always
  // empty and the button has nothing to act on. The IPC stays on the wire
  // for backward compatibility but the UI no longer surfaces it.

  async function resetAll(): Promise<void> {
    if (!confirm('清空全部学习记忆？这会忘掉所有自动修正、专有名词和保留原文。')) return;
    try {
      await window.lynlens.learningReset();
      await refresh();
    } catch {
      /* noop */
    }
  }

  if (!snap) return <span className="learning-badge" title="学习记忆未就绪">🧠 …</span>;

  // With instant-promotion, every record goes straight to autoCorrections.
  // The only "empty" case is a truly fresh install / cleared memory.
  const labelText =
    snap.autoCorrectionCount + snap.properNounCount + snap.keepOriginalCount === 0
      ? '🧠 还未学习'
      : `🧠 已学 ${snap.autoCorrectionCount} 修正 · ${snap.properNounCount} 名词`;

  return (
    <div className="learning-badge-wrap" ref={rootRef}>
      <button
        className="learning-badge"
        onClick={() => setOpen((v) => !v)}
        title={`点击查看 / 管理学习记忆\n自动修正 ${snap.autoCorrectionCount} · 专有名词 ${snap.properNounCount} · 保留原文 ${snap.keepOriginalCount}`}
        aria-expanded={open}
      >
        {labelText}
      </button>
      {open && (
        <div className="learning-popover" role="dialog">
          <div className="learning-popover-head">
            <strong>LynLens 已学到</strong>
            <button
              className="learning-reset-link"
              onClick={resetAll}
              title="清空全部学习记忆"
            >
              清空
            </button>
          </div>

          {snap.recentCorrections.length > 0 ? (
            <div className="learning-section">
              <div className="learning-section-title">已学到 (下次转录起自动应用)</div>
              {snap.recentCorrections.map((e) => (
                <div className="learning-row" key={`r-${e.from}-${e.to}`}>
                  <span className="learning-from">{e.from}</span>
                  <span className="learning-arrow">→</span>
                  <span className="learning-to">{e.to}</span>
                  <span className="learning-count">×{e.count}</span>
                  <button
                    className="learning-forget"
                    onClick={() => forget('correction', e.from)}
                    title={`忘掉「${e.from}」→「${e.to}」`}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="learning-empty">
              改字幕 / 替换文字时，LynLens 会立刻学到。下次转录会自动应用这些修正。
              改错了可以点 ✕ 忘掉。
            </div>
          )}

          <div className="learning-popover-foot">
            <button
              className="learning-manage-link"
              onClick={() => {
                setOpen(false);
                setShowManage(true);
              }}
            >
              管理全部 →
            </button>
          </div>
        </div>
      )}
      {showManage && <LearningManageDialog onClose={() => { setShowManage(false); void refresh(); }} />}
    </div>
  );
}
