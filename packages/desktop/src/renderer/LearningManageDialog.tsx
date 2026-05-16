import { useEffect, useMemo, useState } from 'react';

interface CorrectionEntry {
  from: string;
  to: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  seenInProjects: string[];
}

interface FullState {
  autoCorrections: Record<string, string>;
  properNouns: Record<string, string>;
  keepOriginal: string[];
  correctionLog: CorrectionEntry[];
}

type Tab = 'corrections' | 'nouns' | 'keep';

interface Props {
  onClose: () => void;
}

/**
 * Full management view for LynLens's learning memory. Scales beyond the 5-row
 * popover — handles thousands of entries via search + scrollable list.
 *
 * Three tabs:
 *   - 修正  (autoCorrections + correctionLog merged view)
 *   - 名词  (properNouns)
 *   - 保留原文 (keepOriginal)
 *
 * Plus a one-time "从 skill 导入" button — pulls the wilon@subtitle-craft
 * skill's accumulated entries in one shot. Conflicts: LynLens wins.
 */
export function LearningManageDialog({ onClose }: Props): JSX.Element {
  const [data, setData] = useState<FullState | null>(null);
  const [tab, setTab] = useState<Tab>('corrections');
  const [search, setSearch] = useState('');

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<void> {
    try {
      const d = await window.lynlens.learningGetAll();
      setData(d);
    } catch (err) {
      alert(`加载失败: ${(err as Error).message}`);
    }
  }

  // "从 skill 导入" was a one-time bootstrap; intentionally not surfaced in
  // the UI any more. The IPC handler (`learning-import-skill`) stays on the
  // wire for agent use if anyone needs it programmatically.

  async function forget(kind: 'correction' | 'noun' | 'keep', key: string): Promise<void> {
    try {
      await window.lynlens.learningForget(kind, key);
      await refresh();
    } catch {
      /* noop */
    }
  }

  async function resetAll(): Promise<void> {
    if (!confirm('清空全部学习记忆？这会忘掉所有修正、专有名词、保留原文。无法撤销。')) return;
    try {
      await window.lynlens.learningReset();
      await refresh();
    } catch {
      /* noop */
    }
  }

  // Filter rows for the active tab based on the search input.
  const correctionRows = useMemo<CorrectionEntry[]>(() => {
    if (!data) return [];
    const q = search.trim();
    const rows = data.correctionLog;
    if (!q) return rows;
    return rows.filter((r) => r.from.includes(q) || r.to.includes(q));
  }, [data, search]);

  const nounRows = useMemo<Array<[string, string]>>(() => {
    if (!data) return [];
    const q = search.trim();
    const rows = Object.entries(data.properNouns);
    if (!q) return rows;
    return rows.filter(([term, cat]) => term.includes(q) || cat.includes(q));
  }, [data, search]);

  const keepRows = useMemo<string[]>(() => {
    if (!data) return [];
    const q = search.trim();
    const rows = data.keepOriginal;
    if (!q) return rows;
    return rows.filter((w) => w.includes(q));
  }, [data, search]);

  const counts = data
    ? {
        corrections: data.correctionLog.length,
        nouns: Object.keys(data.properNouns).length,
        keep: data.keepOriginal.length,
      }
    : { corrections: 0, nouns: 0, keep: 0 };

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog"
        style={{
          maxWidth: 680,
          width: '90vw',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <h3 style={{ flexShrink: 0 }}>学习记忆管理</h3>

        {/* Tabs */}
        <div className="learning-mgr-tabs">
          <button
            className={`learning-mgr-tab${tab === 'corrections' ? ' active' : ''}`}
            onClick={() => setTab('corrections')}
          >
            修正 ({counts.corrections})
          </button>
          <button
            className={`learning-mgr-tab${tab === 'nouns' ? ' active' : ''}`}
            onClick={() => setTab('nouns')}
          >
            专有名词 ({counts.nouns})
          </button>
          <button
            className={`learning-mgr-tab${tab === 'keep' ? ' active' : ''}`}
            onClick={() => setTab('keep')}
          >
            保留原文 ({counts.keep})
          </button>
        </div>

        {/* Top action row: search + import + reset */}
        <div className="learning-mgr-toolbar">
          <input
            type="text"
            className="learning-mgr-search"
            placeholder="搜索..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="learning-mgr-danger" onClick={resetAll}>
            清空全部
          </button>
        </div>

        {/* Scrollable list */}
        <div className="learning-mgr-list">
          {tab === 'corrections' && (
            <CorrectionsList rows={correctionRows} onForget={(k) => forget('correction', k)} />
          )}
          {tab === 'nouns' && (
            <NounsList rows={nounRows} onForget={(k) => forget('noun', k)} />
          )}
          {tab === 'keep' && (
            <KeepList rows={keepRows} onForget={(k) => forget('keep', k)} />
          )}
        </div>

        <div className="dialog-actions" style={{ flexShrink: 0 }}>
          <button className="primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tab row renderers
// ---------------------------------------------------------------------------

function CorrectionsList({
  rows,
  onForget,
}: {
  rows: CorrectionEntry[];
  onForget: (from: string) => void;
}): JSX.Element {
  if (rows.length === 0) {
    return <div className="learning-mgr-empty">没有记录</div>;
  }
  return (
    <>
      {rows.map((r) => (
        <div className="learning-row" key={`${r.from}-${r.to}`}>
          <span className="learning-from">{r.from}</span>
          <span className="learning-to">{r.to}</span>
          <span className="learning-count">×{r.count}</span>
          <button
            className="learning-forget"
            onClick={() => onForget(r.from)}
            title={`忘掉「${r.from}」→「${r.to}」`}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

function NounsList({
  rows,
  onForget,
}: {
  rows: Array<[string, string]>;
  onForget: (term: string) => void;
}): JSX.Element {
  if (rows.length === 0) {
    return <div className="learning-mgr-empty">没有专有名词</div>;
  }
  return (
    <>
      {rows.map(([term, cat]) => (
        <div className="learning-mgr-noun-row" key={term}>
          <span className="learning-mgr-noun-term">{term}</span>
          <span className="learning-mgr-noun-cat">{cat}</span>
          <button
            className="learning-forget"
            onClick={() => onForget(term)}
            title={`忘掉「${term}」`}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

function KeepList({
  rows,
  onForget,
}: {
  rows: string[];
  onForget: (word: string) => void;
}): JSX.Element {
  if (rows.length === 0) {
    return <div className="learning-mgr-empty">没有保留原文</div>;
  }
  return (
    <>
      {rows.map((w) => (
        <div className="learning-mgr-keep-row" key={w}>
          <span className="learning-mgr-keep-word">{w}</span>
          <button
            className="learning-forget"
            onClick={() => onForget(w)}
            title={`移除「${w}」`}
          >
            ✕
          </button>
        </div>
      ))}
    </>
  );
}
