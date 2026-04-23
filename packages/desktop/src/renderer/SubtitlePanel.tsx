import { useMemo, useState } from 'react';
import {
  getLineLimits,
  getOrientation,
  transcriptToPlainText,
  type Transcript,
  type VideoMeta,
} from './core-browser';
import { formatTime } from './util';
import { useStore } from './store';

interface Props {
  projectId: string | null;
  videoMeta: VideoMeta | null;
  transcript: Transcript | null;
  /** User-chosen orientation from the project (overrides auto-detect). */
  userOrientation: 'landscape' | 'portrait' | null;
  currentTime: number;
  onJump: (t: number) => void;
}

/**
 * Editable subtitle panel. Each transcript segment is shown as one card with
 * an editable textarea. AI-proposed fixes appear underneath with a highlighted
 * diff and "✓ 接受 / ✗ 忽略" buttons.
 */
export function SubtitlePanel({
  projectId,
  videoMeta,
  transcript,
  userOrientation,
  currentTime,
  onJump,
}: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [replaceFind, setReplaceFind] = useState('');
  const [replaceWith, setReplaceWith] = useState('');

  const orientation = useMemo<'landscape' | 'portrait'>(() => {
    if (userOrientation) return userOrientation;
    if (!videoMeta) return 'landscape';
    return getOrientation(videoMeta.width, videoMeta.height, videoMeta.rotation ?? 0);
  }, [videoMeta, userOrientation]);
  const limits = useMemo(() => getLineLimits(orientation), [orientation]);

  if (!transcript || transcript.segments.length === 0) {
    return (
      <div className="sub-empty">
        <div>暂无字幕</div>
        <div className="hint">先点顶部「生成字幕」按钮跑一次转录。</div>
      </div>
    );
  }

  async function commit(segId: string, newText: string) {
    if (!projectId) return;
    const segCurrent = transcript!.segments.find((s) => s.id === segId);
    if (!segCurrent) return;
    if (newText === segCurrent.text) return;
    await window.lynlens.updateTranscriptSegment(projectId, segId, newText);
    setDraft((prev) => {
      const next = { ...prev };
      delete next[segId];
      return next;
    });
  }

  async function doReplace() {
    if (!projectId || !replaceFind) return;
    const n = await window.lynlens.replaceInTranscript(projectId, replaceFind, replaceWith);
    if (n === 0) alert(`没找到 "${replaceFind}"`);
    else {
      setReplaceFind('');
      setReplaceWith('');
    }
  }

  async function copyAll() {
    const plain = transcriptToPlainText(transcript!);
    try {
      await navigator.clipboard.writeText(plain);
      alert(`已复制 ${transcript!.segments.length} 段字幕到剪贴板`);
    } catch (err) {
      alert(`复制失败: ${(err as Error).message}`);
    }
  }

  return (
    <div className="sub-list">
      <div className="sub-toolbar">
        <input
          className="sub-input"
          placeholder="查找..."
          value={replaceFind}
          onChange={(e) => setReplaceFind(e.target.value)}
        />
        <span className="sub-arrow">→</span>
        <input
          className="sub-input"
          placeholder="替换为..."
          value={replaceWith}
          onChange={(e) => setReplaceWith(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void doReplace();
          }}
        />
        <button onClick={doReplace} disabled={!replaceFind}>
          替换全部
        </button>
        <button onClick={copyAll} title="把所有段拼成纯文本复制到剪贴板">
复制
        </button>
      </div>
      <div className="sub-meta">
        <span className="sub-orient">
          {orientation === 'landscape' ? '横屏' : '竖屏'} · 中 {limits.zh} / 英 {limits.en} 字
        </span>
        <button
          className="sub-flip"
          onClick={async () => {
            if (!projectId) return;
            const next = orientation === 'landscape' ? 'portrait' : 'landscape';
            await window.lynlens.setUserOrientation(projectId, next);
            // Also update local store so the panel re-renders with new limits
            useStore.getState().setUserOrientation(next);
          }}
          title="切换到另一个方向"
        >
          切换
        </button>
      </div>
      {/* Batch actions appear only when at least one suggestion exists */}
      {transcript.segments.some((s) => s.suggestion) && (
        <div className="sub-bulk">
          <span className="sub-bulk-count">
            {transcript.segments.filter((s) => s.suggestion).length} 条建议
          </span>
          <div className="sub-bulk-actions">
            <button
              className="sub-sug-accept"
              onClick={async () => {
                if (!projectId) return;
                for (const s of transcript.segments) {
                  if (s.suggestion) {
                    await window.lynlens.acceptTranscriptSuggestion(projectId, s.id);
                  }
                }
              }}
            >
              ✓ 全部接受
            </button>
            <button
              className="sub-sug-ignore"
              onClick={async () => {
                if (!projectId) return;
                for (const s of transcript.segments) {
                  if (s.suggestion) {
                    await window.lynlens.clearTranscriptSuggestion(projectId, s.id);
                  }
                }
              }}
            >
              ✗ 全部忽略
            </button>
          </div>
        </div>
      )}
      {transcript.segments.map((seg, i) => {
        const currentText = draft[seg.id] ?? seg.text;
        const isActive = currentTime >= seg.start && currentTime < seg.end;
        const dirty = draft[seg.id] !== undefined && draft[seg.id] !== seg.text;
        const diffParts = seg.suggestion
          ? highlightDiff(seg.text, seg.suggestion.text)
          : null;
        return (
          <div key={seg.id} className={`sub-card${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}`}>
            <div className="sub-head">
              <span className="sub-idx">#{i + 1}</span>
              <span className="sub-time" onClick={() => onJump(seg.start)}>
                {formatTime(seg.start)} – {formatTime(seg.end)}
              </span>
              {dirty && <span className="sub-dirty">·未保存</span>}
            </div>
            <textarea
              className="sub-text"
              value={currentText}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, [seg.id]: e.target.value }))
              }
              onBlur={() => {
                if (draft[seg.id] !== undefined) void commit(seg.id, draft[seg.id]);
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  if (draft[seg.id] !== undefined) void commit(seg.id, draft[seg.id]);
                }
              }}
              rows={Math.max(1, Math.ceil(currentText.length / limits.zh))}
            />
            {seg.suggestion && diffParts && (
              <div
                className="sub-suggestion"
                title={seg.suggestion.reason || 'AI 建议修改'}
              >
                <div className="sub-sug-new">
                  {diffParts.map((p, i) =>
                    p.changed ? (
                      <mark key={i} className="sub-sug-hl">{p.text}</mark>
                    ) : (
                      <span key={i}>{p.text}</span>
                    )
                  )}
                </div>
                <div className="sub-sug-actions">
                  <button
                    className="sub-sug-accept"
                    onClick={async () => {
                      if (!projectId) return;
                      await window.lynlens.acceptTranscriptSuggestion(projectId, seg.id);
                    }}
                  >
                    ✓ 接受
                  </button>
                  <button
                    className="sub-sug-ignore"
                    onClick={async () => {
                      if (!projectId) return;
                      await window.lynlens.clearTranscriptSuggestion(projectId, seg.id);
                    }}
                  >
                    ✗ 忽略
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Compute a simple char-level diff between oldText and newText, returning
 * segments labelled changed/unchanged. Uses prefix+suffix trimming: good for
 * small localised edits ("XXXX YYY ZZZZ" → "XXXX AAA ZZZZ"), falls back to
 * showing the whole new text unhighlighted when the change is sprawling
 * (e.g. traditional↔simplified retranscription).
 */
function highlightDiff(oldText: string, newText: string): Array<{ text: string; changed: boolean }> {
  if (oldText === newText) return [{ text: newText, changed: false }];

  const oldArr = [...oldText];
  const newArr = [...newText];

  // Common prefix
  let prefix = 0;
  while (prefix < oldArr.length && prefix < newArr.length && oldArr[prefix] === newArr[prefix]) {
    prefix++;
  }
  // Common suffix (don't overlap with prefix)
  let suffix = 0;
  while (
    suffix < oldArr.length - prefix &&
    suffix < newArr.length - prefix &&
    oldArr[oldArr.length - 1 - suffix] === newArr[newArr.length - 1 - suffix]
  ) {
    suffix++;
  }

  const changedNew = newArr.slice(prefix, newArr.length - suffix).join('');
  const unchangedTotal = prefix + suffix;

  // If the changed portion is most of the new text, it's a rewrite, not a
  // localized fix — don't highlight anything, just show plain new text.
  if (changedNew.length > newArr.length * 0.6) {
    return [{ text: newText, changed: false }];
  }

  const parts: Array<{ text: string; changed: boolean }> = [];
  if (prefix > 0) parts.push({ text: newArr.slice(0, prefix).join(''), changed: false });
  if (changedNew) parts.push({ text: changedNew, changed: true });
  if (suffix > 0) parts.push({ text: newArr.slice(newArr.length - suffix).join(''), changed: false });
  // Safety: if nothing changed per diff but strings differ, still show everything plain
  if (unchangedTotal === oldArr.length && unchangedTotal === newArr.length && !changedNew) {
    return [{ text: newText, changed: false }];
  }
  return parts;
}
