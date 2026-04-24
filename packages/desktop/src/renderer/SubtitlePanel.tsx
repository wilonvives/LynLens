import { useEffect, useMemo, useRef, useState } from 'react';
import {
  displaySpeakerName,
  effectiveToSource,
  getLineLimits,
  getOrientation,
  listSpeakers,
  listSpeakersInOrder,
  sourceToEffective,
  transcriptToPlainText,
  type Range,
  type Transcript,
  type VideoMeta,
} from './core-browser';
import { formatTime } from './util';
import { useStore } from './store';

interface CutSegmentRef {
  id: string;
  start: number;
  end: number;
}

interface Props {
  projectId: string | null;
  videoMeta: VideoMeta | null;
  transcript: Transcript | null;
  /** User-chosen orientation from the project (overrides auto-detect). */
  userOrientation: 'landscape' | 'portrait' | null;
  currentTime: number;
  /** Display names for diarization speaker IDs; empty = no diarization done. */
  speakerNames: Record<string, string>;
  /**
   * Currently-cut segments (status='cut'). Source-time ranges plus ids —
   * we need ids to fingerprint "user already dismissed this warning" and
   * the ranges drive the effective-time display + "fully covered" detection.
   */
  cutSegments: CutSegmentRef[];
  onJump: (effectiveT: number) => void;
}

/**
 * How each subtitle intersects the cut set.
 *   none     — no overlap; render normally with effective timestamps
 *   partial  — straddles a cut boundary; show ⚠ + ✅ dismiss
 *   full     — entire subtitle lands inside cuts (effective remainder < 0.5s)
 */
type CutOverlap = 'none' | 'partial' | 'full';

function computeOverlapState(
  seg: { start: number; end: number },
  effStart: number,
  effEnd: number,
  cuts: readonly Range[]
): CutOverlap {
  if (cuts.length === 0) return 'none';
  const effRemainder = Math.max(0, effEnd - effStart);
  if (effRemainder < 0.5) return 'full';
  // Any cut that actually overlaps the subtitle's source range?
  for (const c of cuts) {
    if (c.start < seg.end && c.end > seg.start) return 'partial';
  }
  return 'none';
}

/**
 * Fingerprint of the cuts touching this subtitle right now — sorted,
 * pipe-joined cut segment IDs. Empty string when nothing overlaps.
 */
function cutFingerprint(
  seg: { start: number; end: number },
  cutSegs: readonly CutSegmentRef[]
): string {
  const ids = cutSegs
    .filter((c) => c.start < seg.end && c.end > seg.start)
    .map((c) => c.id)
    .sort();
  return ids.join('|');
}

/**
 * Parse a human-typed timestamp in one of: "SS", "SS.ms", "MM:SS",
 * "MM:SS.ms", "H:MM:SS", "H:MM:SS.ms". Returns null on malformed input.
 */
function parseTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const parts = s.split(':');
  if (parts.length > 3) return null;
  let h = 0;
  let m = 0;
  let sec = 0;
  try {
    if (parts.length === 1) {
      sec = Number(parts[0]);
    } else if (parts.length === 2) {
      m = Number(parts[0]);
      sec = Number(parts[1]);
    } else {
      h = Number(parts[0]);
      m = Number(parts[1]);
      sec = Number(parts[2]);
    }
  } catch {
    return null;
  }
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(sec)) return null;
  if (h < 0 || m < 0 || sec < 0) return null;
  return h * 3600 + m * 60 + sec;
}

/**
 * Stable color palette for speaker badges. Hash speaker ID into one of
 * these — same ID always gets the same color, across sessions.
 */
const SPEAKER_COLORS = [
  '#4e6d9f', // blue
  '#9f4e6d', // rose
  '#6d9f4e', // green
  '#9f8a4e', // amber
  '#6d4e9f', // purple
  '#4e9f8a', // teal
];
function speakerColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) & 0xffffffff;
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
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
  speakerNames,
  cutSegments,
  onJump,
}: Props) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [replaceFind, setReplaceFind] = useState('');
  const [replaceWith, setReplaceWith] = useState('');
  /**
   * Per-segment speaker-edit dialog. currentSpeaker is null when the user
   * clicks the "+ 指派" placeholder on an unlabeled segment; the dialog
   * then shows "指派为" for every known speaker instead of "改为" for the
   * other ones.
   */
  const [speakerEdit, setSpeakerEdit] = useState<
    | null
    | { transcriptSegId: string; currentSpeaker: string | null }
  >(null);
  // ⚙ settings popover (find/replace, copy, orientation).
  const [showSettings, setShowSettings] = useState(false);
  // Hide subtitles whose source range is fully covered by cuts. Persisted
  // to localStorage so reopening the project keeps the user's choice.
  const [hideFullyCut, setHideFullyCut] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('lynlens.subtitles.hideCut') === '1';
  });
  useEffect(() => {
    localStorage.setItem('lynlens.subtitles.hideCut', hideFullyCut ? '1' : '0');
  }, [hideFullyCut]);
  // Auto-follow: scroll the panel so the currently-playing subtitle stays
  // visible. Default on. Persisted to localStorage. User scrolling pauses
  // follow for 4s so they can freely read ahead / back without the panel
  // yanking them back on the next segment boundary.
  const [autoFollow, setAutoFollow] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('lynlens.subtitles.autoFollow') !== '0';
  });
  useEffect(() => {
    localStorage.setItem('lynlens.subtitles.autoFollow', autoFollow ? '1' : '0');
  }, [autoFollow]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const pauseFollowUntilRef = useRef<number>(0);
  // Which timestamp (if any) is currently in edit mode. Keyed by segment
  // id + edge so only one field is open at a time.
  const [editingTime, setEditingTime] = useState<
    | null
    | { segId: string; edge: 'start' | 'end'; draft: string }
  >(null);

  // Plain cut-range list (ids dropped) used by the ripple math helpers.
  const cutRanges = useMemo<Range[]>(
    () => cutSegments.map((c) => ({ start: c.start, end: c.end })),
    [cutSegments]
  );

  // Which subtitle is currently being spoken? Recomputed only when the
  // crossing segment changes, not on every timeupdate tick — so the
  // auto-follow effect below fires once per boundary, not 60×/second.
  const activeSegId = useMemo<string | null>(() => {
    if (!transcript) return null;
    for (const seg of transcript.segments) {
      if (currentTime >= seg.start && currentTime < seg.end) return seg.id;
    }
    return null;
  }, [transcript, currentTime]);

  // Scroll the active card into view when it changes. 'center' keeps some
  // context visible above (previous line) and below (upcoming line) rather
  // than slapping the active line flush against the top.
  useEffect(() => {
    if (!autoFollow || !activeSegId) return;
    if (Date.now() < pauseFollowUntilRef.current) return;
    const root = listRef.current;
    if (!root) return;
    const el = root.querySelector<HTMLElement>(`[data-seg-id="${activeSegId}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeSegId, autoFollow]);

  // Order speakers by first-appearance time so the display numbering
  // ("说话人 1/2/3") matches the order they spoke in the video.
  const speakersInOrder = useMemo(
    () => listSpeakersInOrder(transcript),
    [transcript]
  );

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

  /**
   * Copy with timestamps. Format per line:
   *   [MM:SS - MM:SS] [Speaker] Text
   * Uses EFFECTIVE time (post-ripple) — matches what the user sees on
   * screen. Subtitles fully covered by cuts are skipped so the clipboard
   * output stays in sync with the effective timeline.
   */
  async function copyAllWithTimestamps() {
    if (!transcript) return;
    const lines: string[] = [];
    for (const seg of transcript.segments) {
      const effStart = sourceToEffective(seg.start, cutRanges);
      const effEnd = sourceToEffective(seg.end, cutRanges);
      if (effEnd - effStart < 0.5) continue;
      const time = `[${formatTime(effStart)} - ${formatTime(effEnd)}]`;
      const who = seg.speaker
        ? ` [${displaySpeakerName(seg.speaker, speakerNames, speakersInOrder)}]`
        : '';
      lines.push(`${time}${who} ${seg.text.trim()}`);
    }
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      alert(`已复制 ${lines.length} 段字幕(含时间戳)到剪贴板`);
    } catch (err) {
      alert(`复制失败: ${(err as Error).message}`);
    }
  }

  /**
   * Commit a new (start, end) pair for one subtitle. Caller supplies
   * EFFECTIVE-time values — we convert to source before persisting.
   * Returns true on success, false if validation / IPC failed (caller
   * can leave the input open for correction in that case).
   */
  async function commitTimes(
    segId: string,
    effStart: number,
    effEnd: number
  ): Promise<boolean> {
    if (!projectId) return false;
    if (!Number.isFinite(effStart) || !Number.isFinite(effEnd)) return false;
    if (effEnd <= effStart) return false;
    const srcStart = effectiveToSource(effStart, cutRanges);
    const srcEnd = effectiveToSource(effEnd, cutRanges);
    if (srcEnd <= srcStart) return false;
    const ok = await window.lynlens.updateTranscriptSegmentTime(
      projectId,
      segId,
      srcStart,
      srcEnd
    );
    return ok;
  }

  /**
   * Nudge one edge by delta seconds (effective time). Called by ± buttons.
   * Independent: nudging start does NOT move end, and vice versa.
   *
   * Optimistic: updates the edit-mode draft IMMEDIATELY so the number in
   * the input visibly jumps on click, then dispatches the IPC write in
   * the background. If the nudge would collapse the subtitle (end <=
   * start) or push start below zero, we bail out — the button becomes a
   * no-op at the boundary rather than corrupting the range.
   */
  function nudgeTime(
    seg: { id: string; start: number; end: number },
    edge: 'start' | 'end',
    deltaSec: number
  ): void {
    const effStart = sourceToEffective(seg.start, cutRanges);
    const effEnd = sourceToEffective(seg.end, cutRanges);
    const curEdge = edge === 'start' ? effStart : effEnd;
    const newEdge = Math.max(0, curEdge + deltaSec);
    const nextStart = edge === 'start' ? newEdge : effStart;
    const nextEnd = edge === 'end' ? newEdge : effEnd;
    // Keep at least 0.05s so the subtitle doesn't collapse into a point.
    if (nextEnd - nextStart < 0.05) return;
    // Optimistic draft update → instant visual feedback on the input.
    setEditingTime((cur) =>
      cur && cur.segId === seg.id && cur.edge === edge
        ? { ...cur, draft: formatTime(newEdge) }
        : cur
    );
    void commitTimes(seg.id, nextStart, nextEnd);
  }

  async function dismissWarning(segId: string, fingerprint: string): Promise<void> {
    if (!projectId) return;
    await window.lynlens.setTranscriptWarningFingerprint(projectId, segId, fingerprint);
  }

  // Mark a brief pause on auto-follow so user-initiated wheel / touchpad
  // scrolling isn't instantly fought by the next auto-scroll. Deliberately
  // keyed off wheel/touch events — programmatic scrollIntoView doesn't fire
  // wheel, so our own scrolls don't re-arm the pause.
  function onUserScroll(): void {
    pauseFollowUntilRef.current = Date.now() + 4000;
  }

  return (
    <div
      className="sub-list"
      ref={listRef}
      onWheel={onUserScroll}
      onTouchMove={onUserScroll}
    >
      {/* ⚙ settings bar — minimal by default. Click the gear to expand
          find/replace + 复制 + orientation controls. Saves vertical
          space when the user just wants to read the transcript. */}
      <div className="sub-settings-bar">
        <span className="sub-orient-hint">
          {orientation === 'landscape' ? '横屏' : '竖屏'} · 中{limits.zh}/英{limits.en}
        </span>
        <span className="sub-settings-spacer" />
        <button
          className="sub-settings-btn"
          onClick={() => setShowSettings((v) => !v)}
          title="查找/替换、复制、切换方向"
          aria-expanded={showSettings}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 4a1.5 1.5 0 110-3 1.5 1.5 0 010 3z"
              fill="currentColor"
            />
            <path
              d="M13.5 8a5.5 5.5 0 00-.09-1l1.36-1.06a.5.5 0 00.11-.64l-1.3-2.25a.5.5 0 00-.6-.22l-1.6.64a5.5 5.5 0 00-1.74-1L9.4 0.6A.5.5 0 008.9 0.1h-2.6a.5.5 0 00-.49.42l-.24 1.71a5.5 5.5 0 00-1.74 1l-1.6-.64a.5.5 0 00-.6.22l-1.3 2.25a.5.5 0 00.11.64L1.6 7a5.5 5.5 0 000 2l-1.36 1.06a.5.5 0 00-.11.64l1.3 2.25a.5.5 0 00.6.22l1.6-.64a5.5 5.5 0 001.74 1l.24 1.71a.5.5 0 00.49.42h2.6a.5.5 0 00.49-.42l.24-1.71a5.5 5.5 0 001.74-1l1.6.64a.5.5 0 00.6-.22l1.3-2.25a.5.5 0 00-.11-.64L13.41 9A5.5 5.5 0 0013.5 8z"
              fill="none"
              stroke="currentColor"
              strokeWidth="0.9"
            />
          </svg>
        </button>
      </div>

      {showSettings && (
        <div className="sub-settings-popover">
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
            <button onClick={copyAll} title="纯文本,每段独占一行">
              复制
            </button>
            <button
              onClick={copyAllWithTimestamps}
              title="每行开头带时间戳和说话人,例: [00:00 - 00:04] [说话人] 文本"
            >
              复制+时间
            </button>
          </div>
          <div className="sub-settings-row">
            <span>视频方向</span>
            <span className="sub-settings-spacer" />
            <span className="sub-orient-hint">
              {orientation === 'landscape' ? '横屏 (中24/英90)' : '竖屏 (中12/英45)'}
            </span>
            <button
              className="sub-flip"
              onClick={async () => {
                if (!projectId) return;
                const next = orientation === 'landscape' ? 'portrait' : 'landscape';
                await window.lynlens.setUserOrientation(projectId, next);
                useStore.getState().setUserOrientation(next);
              }}
              title="切换到另一个方向"
            >
              切换
            </button>
          </div>
          <div className="sub-settings-row">
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              title="开启后,完全被剪切覆盖的字幕不再显示"
            >
              <input
                type="checkbox"
                checked={hideFullyCut}
                onChange={(e) => setHideFullyCut(e.target.checked)}
              />
              <span>隐藏已被剪切的字幕</span>
            </label>
          </div>
          <div className="sub-settings-row">
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              title="播放时自动滚动面板,让当前字幕保持在视野中央(手动滚动后暂停 4 秒)"
            >
              <input
                type="checkbox"
                checked={autoFollow}
                onChange={(e) => setAutoFollow(e.target.checked)}
              />
              <span>自动跟随播放</span>
            </label>
          </div>
          {projectId && (
            <AutoAssignRow
              projectId={projectId}
              transcript={transcript}
            />
          )}
          {projectId && (
            <SpeakerManager
              projectId={projectId}
              speakers={speakersInOrder}
              speakerNames={speakerNames}
              color={speakerColor}
            />
          )}
        </div>
      )}
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
        const effStart = sourceToEffective(seg.start, cutRanges);
        const effEnd = sourceToEffective(seg.end, cutRanges);
        const overlap = computeOverlapState(seg, effStart, effEnd, cutRanges);
        const isFullyCut = overlap === 'full';
        if (isFullyCut && hideFullyCut) return null;
        const isPartialCut = overlap === 'partial';
        const fingerprintNow = cutFingerprint(seg, cutSegments);
        const warningDismissed =
          isPartialCut && seg.warningFingerprint === fingerprintNow;
        const showWarning = isPartialCut && !warningDismissed;
        const isActive = currentTime >= seg.start && currentTime < seg.end && !isFullyCut;
        const dirty = draft[seg.id] !== undefined && draft[seg.id] !== seg.text;
        const diffParts = seg.suggestion
          ? highlightDiff(seg.text, seg.suggestion.text)
          : null;
        const cardCls =
          `sub-card${isActive ? ' active' : ''}${dirty ? ' dirty' : ''}` +
          (isFullyCut ? ' cut-full' : '') +
          (isPartialCut ? ' cut-partial' : '');
        return (
          <div key={seg.id} className={cardCls} data-seg-id={seg.id}>
            <div className="sub-head">
              <span className="sub-idx">#{i + 1}</span>
              {isFullyCut && <span className="sub-cut-tag">(已剪)</span>}
              {seg.speaker ? (
                <button
                  className="sub-speaker"
                  style={{ background: speakerColor(seg.speaker) }}
                  onClick={() =>
                    setSpeakerEdit({
                      transcriptSegId: seg.id,
                      currentSpeaker: seg.speaker!,
                    })
                  }
                  title="点击编辑说话人"
                >
                  {displaySpeakerName(seg.speaker, speakerNames, speakersInOrder)}
                </button>
              ) : (
                /* Only show the "+ 指派" affordance when the project has
                   any labeled segments at all — pre-diarization transcripts
                   shouldn't get these buttons everywhere. */
                speakersInOrder.length > 0 && (
                  <button
                    className="sub-speaker-add"
                    onClick={() =>
                      setSpeakerEdit({
                        transcriptSegId: seg.id,
                        currentSpeaker: null,
                      })
                    }
                    title="给这一段指派说话人"
                  >
                    + 指派
                  </button>
                )
              )}
              {isFullyCut ? (
                // Fully-cut subtitles don't get editable timestamps — the
                // effective range is zero, there's nothing to nudge. Showing
                // nothing keeps the card tidy.
                null
              ) : (
                <TimestampEditor
                  seg={seg}
                  effStart={effStart}
                  effEnd={effEnd}
                  editing={editingTime && editingTime.segId === seg.id ? editingTime : null}
                  onJump={onJump}
                  onBeginEdit={(edge, initial) =>
                    setEditingTime({ segId: seg.id, edge, draft: initial })
                  }
                  onDraftChange={(draftStr) =>
                    setEditingTime((cur) =>
                      cur && cur.segId === seg.id ? { ...cur, draft: draftStr } : cur
                    )
                  }
                  onCommitEdit={async (edge, newValueSec) => {
                    if (newValueSec == null) {
                      setEditingTime(null);
                      return;
                    }
                    const nextStart = edge === 'start' ? newValueSec : effStart;
                    const nextEnd = edge === 'end' ? newValueSec : effEnd;
                    const ok = await commitTimes(seg.id, nextStart, nextEnd);
                    if (ok) setEditingTime(null);
                  }}
                  onCancelEdit={() => setEditingTime(null)}
                  onNudge={(edge, delta) => nudgeTime(seg, edge, delta)}
                />
              )}
              {showWarning && (
                <span className="sub-cut-warning" title="这一段横跨一个剪切,可能被截半">
                  <span className="sub-cut-warning-icon">⚠</span>
                  <button
                    className="sub-cut-dismiss"
                    onClick={() => void dismissWarning(seg.id, fingerprintNow)}
                    title="已确认,隐藏此提醒(如果剪切再变,会自动回来)"
                  >
                    ✅
                  </button>
                </span>
              )}
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
              disabled={isFullyCut}
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

      {speakerEdit && projectId && (
        <SegmentSpeakerDialog
          projectId={projectId}
          transcriptSegId={speakerEdit.transcriptSegId}
          currentSpeaker={speakerEdit.currentSpeaker}
          currentDisplayName={
            speakerEdit.currentSpeaker
              ? displaySpeakerName(
                  speakerEdit.currentSpeaker,
                  speakerNames,
                  speakersInOrder
                )
              : null
          }
          // When there's no current speaker, EVERY known speaker is a valid
          // target; when there IS a current one, exclude it from the list
          // (retagging to the same speaker is a no-op).
          otherSpeakers={listSpeakers(transcript).filter(
            (s) => s !== speakerEdit.currentSpeaker
          )}
          otherSpeakerLabel={(id) => displaySpeakerName(id, speakerNames, speakersInOrder)}
          onClose={() => setSpeakerEdit(null)}
        />
      )}
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

// ============================================================================
// Per-segment speaker dialog — click badge to retag JUST this one segment.
// Global rename / merge live in the ⚙ settings popover below.
// ============================================================================

function SegmentSpeakerDialog({
  projectId,
  transcriptSegId,
  currentSpeaker,
  currentDisplayName,
  otherSpeakers,
  otherSpeakerLabel,
  onClose,
}: {
  projectId: string;
  transcriptSegId: string;
  /** null when the user clicks "+ 指派" on an unlabeled segment. */
  currentSpeaker: string | null;
  /** null when currentSpeaker is null. */
  currentDisplayName: string | null;
  otherSpeakers: string[];
  otherSpeakerLabel: (id: string) => string;
  onClose: () => void;
}): JSX.Element {
  const [working, setWorking] = useState(false);
  const isAssign = currentSpeaker === null;

  async function setTo(targetSpeaker: string | null): Promise<void> {
    if (working) return;
    setWorking(true);
    try {
      await window.lynlens.setSegmentSpeaker(
        projectId,
        transcriptSegId,
        targetSpeaker
      );
      onClose();
    } finally {
      setWorking(false);
    }
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" style={{ minWidth: 320 }}>
        <h3>{isAssign ? '给这一段指派说话人' : '改这一段的说话人'}</h3>
        <div style={{ color: 'var(--text3)', fontSize: 12, marginBottom: 10 }}>
          {isAssign
            ? '只贴这一段,其他段不动。'
            : `当前: ${currentDisplayName} · 只改这一段,其他段不动。`}
        </div>
        <div className="sp-segpicker">
          {otherSpeakers.length === 0 && (
            <div className="sp-segpicker-empty">
              {isAssign
                ? '项目里还没有任何说话人。先跑「字幕转录」会自动识别。'
                : '还没有其他说话人可切换。如果要改整体标签,用右上 ⚙ → 说话人。'}
            </div>
          )}
          {otherSpeakers.map((s) => (
            <button
              key={s}
              className="sp-segpicker-btn"
              onClick={() => void setTo(s)}
              disabled={working}
            >
              {isAssign ? '指派为' : '改为'} {otherSpeakerLabel(s)}
            </button>
          ))}
          {/* Only show "清除标签" when there IS something to clear. */}
          {!isAssign && (
            <button
              className="sp-segpicker-btn sp-segpicker-clear"
              onClick={() => void setTo(null)}
              disabled={working}
            >
              清除标签
            </button>
          )}
        </div>
        <div className="dialog-actions">
          <button onClick={onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// AutoAssignRow — one-click sweep to label every unlabeled segment with
// the speaker of its nearest labeled neighbor. Sits in the ⚙ settings
// popover. Disabled when there's nothing to copy from (no labels yet) or
// nothing to fix (zero unlabeled).
// ============================================================================

function AutoAssignRow({
  projectId,
  transcript,
}: {
  projectId: string;
  transcript: Transcript | null;
}): JSX.Element | null {
  const [working, setWorking] = useState(false);
  const counts = useMemo(() => {
    if (!transcript) return { unlabeled: 0, labeled: 0 };
    let unlabeled = 0;
    let labeled = 0;
    for (const s of transcript.segments) {
      if (s.speaker) labeled++;
      else unlabeled++;
    }
    return { unlabeled, labeled };
  }, [transcript]);

  if (!transcript || transcript.segments.length === 0) return null;

  const noSource = counts.labeled === 0;
  const allLabeled = counts.unlabeled === 0;
  const disabled = working || noSource || allLabeled;
  let title = '按就近原则,把未标记字幕贴到最近的已标记说话人';
  if (noSource) title = '还没有任何说话人可参考,先至少给一段指派';
  else if (allLabeled) title = '所有字幕都已标记';

  async function run(): Promise<void> {
    if (disabled) return;
    setWorking(true);
    try {
      await window.lynlens.autoAssignUnlabeledSpeakers(projectId);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="sub-settings-row">
      <span>未标记字幕</span>
      <span className="sub-settings-spacer" />
      <span className="sub-orient-hint">
        {allLabeled ? '全部已标记' : `${counts.unlabeled} 条`}
      </span>
      <button
        className="sub-flip"
        disabled={disabled}
        onClick={() => void run()}
        title={title}
      >
        {working ? '指派中...' : '一键指派'}
      </button>
    </div>
  );
}

// ============================================================================
// TimestampEditor — click-to-edit start/end in effective time.
// Shows "MM:SS.ms – MM:SS.ms". Clicking either side swaps that half to an
// inline <input> + ± 0.1s / ± 0.5s nudges. Start and end are independent:
// editing one never moves the other. Enter / blur commits, Escape cancels.
// ============================================================================

interface TimestampEditorProps {
  seg: { id: string; start: number; end: number };
  /** Effective start in seconds (already computed by caller). */
  effStart: number;
  effEnd: number;
  /** null when no edge of THIS segment is being edited. */
  editing: { edge: 'start' | 'end'; draft: string } | null;
  onJump: (effectiveSec: number) => void;
  onBeginEdit: (edge: 'start' | 'end', initialDraft: string) => void;
  onDraftChange: (draft: string) => void;
  /**
   * Commit the input. newValueSec is effective seconds, or null when the
   * draft parses as blank / invalid and we want to cancel silently.
   */
  onCommitEdit: (edge: 'start' | 'end', newValueSec: number | null) => void | Promise<void>;
  onCancelEdit: () => void;
  /** Nudge ONE edge. Does not touch the other. */
  onNudge: (edge: 'start' | 'end', deltaSec: number) => void;
}

function TimestampEditor({
  effStart,
  effEnd,
  editing,
  onJump,
  onBeginEdit,
  onDraftChange,
  onCommitEdit,
  onCancelEdit,
  onNudge,
}: TimestampEditorProps): JSX.Element {
  const editingStart = editing?.edge === 'start';
  const editingEnd = editing?.edge === 'end';

  function renderEdge(edge: 'start' | 'end', value: number, isEditing: boolean) {
    if (isEditing && editing) {
      return (
        <span className="sub-time-edit">
          <input
            className="sub-time-input"
            autoFocus
            value={editing.draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const parsed = parseTime(editing.draft);
                void onCommitEdit(edge, parsed);
              } else if (e.key === 'Escape') {
                onCancelEdit();
              }
            }}
            onBlur={() => {
              const parsed = parseTime(editing.draft);
              void onCommitEdit(edge, parsed);
            }}
          />
          <span className="sub-time-nudge">
            <button
              type="button"
              className="sub-time-nudge-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onNudge(edge, -0.5)}
              title="往前 0.5 秒"
            >
              −0.5
            </button>
            <button
              type="button"
              className="sub-time-nudge-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onNudge(edge, -0.1)}
              title="往前 0.1 秒"
            >
              −0.1
            </button>
            <button
              type="button"
              className="sub-time-nudge-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onNudge(edge, 0.1)}
              title="往后 0.1 秒"
            >
              +0.1
            </button>
            <button
              type="button"
              className="sub-time-nudge-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onNudge(edge, 0.5)}
              title="往后 0.5 秒"
            >
              +0.5
            </button>
          </span>
        </span>
      );
    }
    return (
      <span
        className="sub-time-edge"
        onClick={(e) => {
          // Shift/modifier-free single click = seek jump; double-click or
          // explicit edit affordance... simpler: single click enters edit
          // mode, and we expose a separate ▶ jump button. But keeping the
          // old one-click-jump behaviour causes the user to lose the only
          // way to "go to" this subtitle. Compromise: alt/meta-click jumps,
          // plain click opens edit mode.
          if (e.altKey || e.metaKey) {
            onJump(effStart);
            return;
          }
          onBeginEdit(edge, formatTime(value));
        }}
        title="点击修改 (Alt/⌘-click 跳转到这一段)"
      >
        {formatTime(value)}
      </span>
    );
  }

  return (
    <span className="sub-time">
      {renderEdge('start', effStart, editingStart)}
      <span className="sub-time-sep">–</span>
      {renderEdge('end', effEnd, editingEnd)}
    </span>
  );
}

// ============================================================================
// Speaker manager — list of all speakers with inline rename + merge.
// Rendered inside the ⚙ settings popover so global operations live in one
// place (video orientation, find/replace, speaker labels).
// ============================================================================

export function SpeakerManager({
  projectId,
  speakers,
  speakerNames,
  color,
}: {
  projectId: string;
  /** Ordered by first-appearance time — drives the "说话人 N" numbering. */
  speakers: string[];
  speakerNames: Record<string, string>;
  color: (id: string) => string;
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Display label for a speaker — user-assigned name OR the "说话人 N"
  // positional default. Computed inline so changes to speakerNames update
  // every row consistently.
  function label(id: string): string {
    return displaySpeakerName(id, speakerNames, speakers);
  }

  async function flush(speakerId: string): Promise<void> {
    const next = (drafts[speakerId] ?? '').trim();
    const current = speakerNames[speakerId] ?? '';
    if (next === current) return;
    await window.lynlens.renameSpeaker(projectId, speakerId, next || null);
    setDrafts((d) => {
      const { [speakerId]: _drop, ...rest } = d;
      return rest;
    });
  }

  async function merge(from: string, to: string): Promise<void> {
    if (from === to) return;
    if (!confirm(`把所有「${label(from)}」的段合并到「${label(to)}」? (之后可以再合回去)`)) return;
    await window.lynlens.mergeSpeakers(projectId, from, to);
  }

  if (speakers.length === 0) {
    return <div className="sp-mgr-empty">还没运行过字幕转录,跑一次会自动识别说话人。</div>;
  }

  return (
    <div className="sp-mgr">
      {speakers.map((id) => {
        const draft = drafts[id] ?? speakerNames[id] ?? '';
        const others = speakers.filter((s) => s !== id);
        return (
          <div key={id} className="sp-mgr-row">
            {/* Single input = single control. Placeholder is the raw ID;
                user types to rename. Left border tinted with the speaker's
                colour keeps the row visually linked to the subtitle badge. */}
            <input
              className="sp-mgr-input"
              style={{ borderLeft: `4px solid ${color(id)}` }}
              placeholder={id}
              value={draft}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [id]: e.target.value }))
              }
              onBlur={() => void flush(id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              }}
            />
            {others.length > 0 && (
              <select
                className="sp-mgr-merge"
                value=""
                onChange={(e) => {
                  const target = e.target.value;
                  if (target) void merge(id, target);
                  e.target.value = '';
                }}
                title="合并到另一个说话人"
              >
                <option value="">合并到...</option>
                {others.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
