import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HighlightStyle, HighlightVariant, Range, VariantStatus } from '@lynlens/core';
import { getVariantStatus, sourceToEffective, effectiveToSource } from './core-browser';
import { ExportDialog } from './ExportDialog';
import { GenerateHighlightDialog } from './GenerateHighlightDialog';
import { HighlightTimeline } from './HighlightTimeline';
import { VariantCard } from './VariantCard';
import { Resizer } from './Resizer';
import { useStore } from './store';
import { formatTime } from './util';

interface Props {
  effectiveDuration: number;
  videoPath: string | null;
  /** Inherited from the precision tab so both players feel identical. */
  previewRotation: 0 | 90 | 180 | 270;
}

function usePersistedSize(key: string, defaultValue: number): [number, (n: number) => void] {
  const [value, setValue] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultValue;
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : defaultValue;
  });
  const set = useCallback(
    (n: number) => {
      setValue(n);
      window.localStorage.setItem(key, String(n));
    },
    [key]
  );
  return [value, set];
}

/**
 * Format seconds as "MM:SS" or "H:MM:SS" — player-bar style, no
 * milliseconds, no decimals. Used in the highlight player's time
 * display where you want at-a-glance "elapsed / total" the way
 * QuickTime / YouTube show it.
 */
function formatMmSs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Compute how many seconds into the current variant the video is. Walks the
 * segments in order: sums durations before the current segment, then adds
 * (video.currentTime - currentSeg.start) clamped within the current segment.
 */
function computeElapsed(
  variant: HighlightVariant,
  currentSegIdx: number,
  videoCurrentTime: number
): number {
  let sum = 0;
  for (let i = 0; i < currentSegIdx && i < variant.segments.length; i++) {
    const s = variant.segments[i];
    sum += s.end - s.start;
  }
  const cur = variant.segments[currentSegIdx];
  if (cur) {
    const within = Math.max(cur.start, Math.min(cur.end, videoCurrentTime)) - cur.start;
    sum += Math.max(0, within);
  }
  return sum;
}

/**
 * 高光 tab's main surface. Two columns joined by a draggable resizer:
 *   Left  — a dedicated <video> element that plays the currently-selected
 *           variant as a seamless concat. RAF loop skips from segment N's
 *           end to segment N+1's start. Inherits the preview rotation from
 *           the precision tab so the visual orientation stays consistent.
 *   Right — variant cards (click to play, click a segment row to jump).
 *
 * A progress bar under the player shows elapsed/total within the variant
 * and visualises segment boundaries so the user can always see where they
 * are within the current highlight. The bar is clickable for seeking.
 */
export function HighlightPanel({
  effectiveDuration,
  videoPath,
  previewRotation,
}: Props) {
  const projectId = useStore((s) => s.projectId);
  const videoUrl = useStore((s) => s.videoUrl);
  const transcript = useStore((s) => s.transcript);
  const segments = useStore((s) => s.segments);
  // Derive cut ranges the same way App.tsx does (status='cut' segments).
  // Pass into VariantCard's status check so stale / broken variants flag up.
  const cutRanges = useMemo<Range[]>(
    () =>
      segments
        .filter((s) => s.status === 'cut')
        .map((s) => ({ start: s.start, end: s.end }))
        .sort((a, b) => a.start - b.start),
    [segments]
  );

  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  /** The variant currently shown in the ExportDialog. null = dialog closed. */
  const [exportingVariant, setExportingVariant] = useState<HighlightVariant | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const [playerWrapSize, setPlayerWrapSize] = useState({ w: 0, h: 0 });

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [playingSegIdx, setPlayingSegIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  /**
   * Live video position in SOURCE time. Drives the playhead on the new
   * full-video scrubber + the "source time" display. Updated by both the
   * existing RAF loop AND the native timeupdate event (covers the paused
   * case where RAF doesn't run).
   */
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  /**
   * Explicit "预览高光" toggle. When ON the RAF loop locks playback to
   * variant segments — jumps to the next at the end of the current one,
   * skips the unused video in between. When OFF (default) the player
   * scrubs through the full video freely. Driven by the toggle button
   * in the transport bar, NOT by where the user clicks — auto-toggling
   * on click was confusing ("我点了播放高光，他直接播放那些没有被选取
   * 的片段了"). Now it's always under explicit user control.
   */
  const [previewMode, setPreviewMode] = useState(false);
  // Waveform feeds the full-width <HighlightTimeline /> below; same store
  // shape as the precision tab's Timeline.
  const waveform = useStore((s) => s.waveform);

  // Right-column width (variant cards). Left column (player) stretches to fill.
  const [cardsWidth, setCardsWidth] = usePersistedSize('lynlens.highlightCardsWidth', 380);
  // Bottom timeline height, persisted across sessions. Matches the precision
  // tab's resizer (lynlens.timelineHeight) in feel, separate key so users can
  // tune each tab independently.
  const [timelineHeight, setTimelineHeight] = usePersistedSize(
    'lynlens.highlightTimelineHeight',
    140
  );

  const selectedVariant =
    variants.find((v) => v.id === selectedVariantId) ?? null;

  // Measure player container for rotation sizing math.
  useEffect(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setPlayerWrapSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // (Scrubber waveform drawing is owned by <HighlightTimeline /> now —
  // we just pass it the waveform from the store.)

  // Keyboard shortcuts — scoped to the highlight tab (this hook only runs
  // while HighlightPanel is mounted). Mirrors the precision tab's set so
  // muscle memory transfers:
  //   Space            play/pause
  //   ←/→              seek ±1s (Shift = ±5s)
  //   ,/.              frame step (where fps is known)
  //   Escape           exit preview mode
  // Skipped when focus is in an editable field (don't hijack typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement;
      const inField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement ||
        (active as HTMLElement | null)?.isContentEditable === true;
      if (inField) return;
      const v = videoRef.current;
      if (!v) return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (v.paused) void v.play().catch(() => {});
          else v.pause();
          break;
        case 'Escape':
          if (previewMode) {
            e.preventDefault();
            setPreviewMode(false);
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 5 : 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          v.currentTime = Math.min(
            Number.isFinite(v.duration) ? v.duration : v.currentTime + 5,
            v.currentTime + (e.shiftKey ? 5 : 1)
          );
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [previewMode]);

  // Hydrate variants from main-process memory.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void window.lynlens.getHighlights(projectId).then((vs) => {
      if (!cancelled) setVariants(vs);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // RAF loop: keep `videoCurrentTime` + `elapsed` in sync, and when
  // `previewMode` is on, hop between variant segments so playback feels
  // like a single seamless reel. When the user clicks OUTSIDE any segment
  // on the full-video scrubber we drop the lock so the video can play
  // freely (preview unused content for future highlight picking).
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      const v = videoRef.current;
      if (v) {
        // Always mirror current time into state so the scrubber playhead
        // moves whether or not a variant is selected.
        setVideoCurrentTime(v.currentTime);
        if (selectedVariant && selectedVariant.segments.length > 0) {
          const segs = selectedVariant.segments;
          const cur = segs[playingSegIdx] ?? segs[0];
          if (!v.paused && previewMode) {
            if (v.currentTime >= cur.end - 0.02) {
              const nextIdx = playingSegIdx + 1;
              if (nextIdx < segs.length) {
                setPlayingSegIdx(nextIdx);
                v.currentTime = segs[nextIdx].start;
              } else {
                v.pause();
                v.currentTime = cur.end;
              }
            } else if (v.currentTime < cur.start - 0.1) {
              v.currentTime = cur.start;
            }
          }
          setElapsed(computeElapsed(selectedVariant, playingSegIdx, v.currentTime));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedVariant, playingSegIdx, previewMode]);

  const selectVariant = useCallback((variant: HighlightVariant) => {
    setSelectedVariantId(variant.id);
    setPlayingSegIdx(0);
    setElapsed(0);
    // Clicking a variant card on the right just SELECTS + seeks to the
    // first segment; it doesn't auto-enter preview mode. Preview is now
    // a separate explicit action (the 🎬 button) so the user is never
    // surprised by what the player does next.
    const v = videoRef.current;
    if (v && variant.segments.length > 0) {
      v.currentTime = variant.segments[0].start;
      void v.play().catch(() => {});
    }
  }, []);

  const selectSegment = useCallback(
    (variant: HighlightVariant, segIdx: number) => {
      setSelectedVariantId(variant.id);
      setPlayingSegIdx(segIdx);
      const v = videoRef.current;
      if (v && variant.segments[segIdx]) {
        v.currentTime = variant.segments[segIdx].start;
        setElapsed(computeElapsed(variant, segIdx, v.currentTime));
        void v.play().catch(() => {});
      }
    },
    []
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (selectedVariant && v.currentTime < selectedVariant.segments[0].start) {
        v.currentTime = selectedVariant.segments[0].start;
      }
      void v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [selectedVariant]);

  /**
   * Jump to the previous variant segment. If we're > 1s into the current
   * segment, snap to the START of THIS segment first (standard player UX:
   * "previous track" rewinds the current track if you're already deep in
   * it). Otherwise jump to the actual previous segment's start.
   */
  const jumpPrevSegment = useCallback(() => {
    if (!selectedVariant) return;
    const v = videoRef.current;
    if (!v) return;
    const cur = selectedVariant.segments[playingSegIdx];
    if (!cur) return;
    if (v.currentTime > cur.start + 1) {
      v.currentTime = cur.start;
      return;
    }
    const prevIdx = playingSegIdx - 1;
    if (prevIdx < 0) {
      v.currentTime = selectedVariant.segments[0].start;
      return;
    }
    setPlayingSegIdx(prevIdx);
    v.currentTime = selectedVariant.segments[prevIdx].start;
  }, [selectedVariant, playingSegIdx]);

  /** Jump to the next variant segment. Caps at the last segment. */
  const jumpNextSegment = useCallback(() => {
    if (!selectedVariant) return;
    const v = videoRef.current;
    if (!v) return;
    const nextIdx = playingSegIdx + 1;
    if (nextIdx >= selectedVariant.segments.length) return;
    setPlayingSegIdx(nextIdx);
    v.currentTime = selectedVariant.segments[nextIdx].start;
  }, [selectedVariant, playingSegIdx]);

  /** Toggle fullscreen on the player WRAP (so controls stay overlaid). */
  const toggleFullscreen = useCallback(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }, []);

  // (Scrubber click handling moved into <HighlightTimeline />; it owns
  // the seek logic now since the full-width timeline IS the scrubber.)

  async function handleGenerate(opts: {
    style: HighlightStyle;
    count: number;
    targetSeconds: number;
  }): Promise<void> {
    if (!projectId) return;
    setShowDialog(false);
    setGenerating(true);
    setError(null);
    setSelectedVariantId(null);
    try {
      const vs = await window.lynlens.generateHighlights(projectId, opts);
      setVariants(vs);
      if (vs.length === 0) {
        setError('AI 没返回有效的变体,请重试或换个风格。');
      }
    } catch (err) {
      setError(`生成失败: ${(err as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Open the shared ExportDialog with this variant queued. Confirm fires
   * the variant export with the user-picked quality. Same dialog the
   * precision tab uses — keeps parameters + UI consistent across tabs.
   *
   * Returns Promise<void> to match VariantCard's prop signature even
   * though the actual export work happens after dialog confirmation.
   */
  async function handleExport(variant: HighlightVariant): Promise<void> {
    setExportingVariant(variant);
  }

  if (!projectId) {
    return (
      <div className="highlight-empty">
        <h2>请先打开视频</h2>
      </div>
    );
  }

  if (!transcript || transcript.segments.length === 0) {
    return (
      <div className="highlight-empty">
        <h2>请先生成字幕</h2>
        <div className="hint">
          高光变体基于字幕内容生成。回到「粗剪」tab 点「生成字幕」后再来。
        </div>
      </div>
    );
  }

  // Per-variant total duration for the progress display.
  const totalVariantSec = selectedVariant?.durationSeconds ?? 0;
  const progressFrac = totalVariantSec > 0 ? Math.min(1, elapsed / totalVariantSec) : 0;

  // Video element style for rotation (same shape as App.tsx's player).
  const isSide = previewRotation === 90 || previewRotation === 270;
  const videoStyle = {
    maxWidth: isSide && playerWrapSize.h ? `${playerWrapSize.h}px` : '100%',
    maxHeight: isSide && playerWrapSize.w ? `${playerWrapSize.w}px` : '100%',
    objectFit: 'contain' as const,
    transform: `rotate(${previewRotation}deg)`,
    transition: 'transform 0.2s ease',
  };

  return (
    <div className="highlight-panel">
      <div className="highlight-panel-header">
        <div>
          <div className="highlight-panel-title">高光变体</div>
          <div className="highlight-panel-sub">
            基于粗剪后的 {formatTime(effectiveDuration)} 视频 · 字幕 {transcript.segments.length} 段
          </div>
        </div>
        <div className="spacer" />
        {/* 自定义 — create an empty variant from scratch. Seed segment is
            centred at the current playhead so the user starts from "where
            I just was in the video"; they then drag the edges + use the
            +加段 button to build it up. Auto-selected on creation so the
            timeline immediately shows the new variant for editing. */}
        <button
          onClick={async () => {
            if (!projectId) return;
            const v = videoRef.current;
            const hint =
              v && Number.isFinite(v.currentTime) ? v.currentTime : null;
            try {
              const created = await window.lynlens.addBlankHighlightVariant(
                projectId,
                hint
              );
              const latest = await window.lynlens.getHighlights(projectId);
              setVariants(latest);
              setSelectedVariantId(created.id);
              setPlayingSegIdx(0);
            } catch (err) {
              alert(`自定义高光创建失败: ${(err as Error).message}`);
            }
          }}
          disabled={generating || !projectId || !transcript}
          title="新建一个空变体,自己挑段子。从播放头位置开始的 3 秒,然后拖边 / 加段调整。"
        >
          ✋ 自定义
        </button>
        <button
          className="primary"
          onClick={() => setShowDialog(true)}
          disabled={generating}
        >
          {generating ? '生成中...' : variants.length > 0 ? '重新生成' : '生成变体'}
        </button>
      </div>

      {error && <div className="highlight-error">{error}</div>}

      {generating && (
        <div className="gen-banner">
          <span className="gen-banner-dot" />
          <div>
            <div className="gen-banner-title">Claude 正在读字幕并挑段...</div>
            <div className="gen-banner-hint">通常 10-30 秒。变体数量越多越慢。</div>
          </div>
        </div>
      )}

      <div className="highlight-body">
        {/* LEFT — dedicated variant player */}
        <div className="highlight-player">
          {/* Unified PLAYER dock: video + scrubber + transport bar all live
              inside one bordered card. Looks/feels like a real video player
              (YouTube / QuickTime). The segment editor (mini-timeline) is
              a SEPARATE widget below — it's an editor, not part of the
              player. */}
          <div className="highlight-player-dock" ref={playerWrapRef}>
            <div className="highlight-player-video">
              {videoUrl ? (
                <video
                  ref={videoRef}
                  src={videoUrl}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onClick={() => togglePlay()}
                  controls={false}
                  style={videoStyle}
                />
              ) : (
                <div className="drop-hint">视频未加载</div>
              )}
              {/* Center play overlay when paused — standard "click to
                  resume" affordance. Pointer-events:none so the underlying
                  <video onClick> still toggles. Shown whether a variant is
                  selected or not — full-video playback works the same. */}
              {!isPlaying && videoUrl && (
                <div className="highlight-player-play-overlay">▶</div>
              )}
            </div>

            {/* (The scrubber moved out of the player dock to become a
                full-width timeline below the body — see <HighlightTimeline />
                further down. The dock now contains only the video + the
                transport bar, like a clean video player.) */}

            {/* Transport bar — time / prev / play / next / segchip / fullscreen.
                Bottom of the player card, like any standard video player. */}
            <div className="highlight-player-controls">
              <div
                className="highlight-player-time"
                title={
                  selectedVariant
                    ? `视频位置 / 视频总长 (变体 ${formatMmSs(elapsed)} / ${formatMmSs(totalVariantSec)})`
                    : '视频位置 / 视频总长'
                }
              >
                {videoUrl && effectiveDuration > 0 ? (
                  <>
                    <span className="elapsed">
                      {formatMmSs(sourceToEffective(videoCurrentTime, cutRanges))}
                    </span>
                    <span className="sep"> / </span>
                    <span className="total">{formatMmSs(effectiveDuration)}</span>
                  </>
                ) : (
                  <span className="total">--:-- / --:--</span>
                )}
              </div>
              <div className="highlight-player-transport">
                <button
                  className="transport-btn"
                  disabled={!selectedVariant || playingSegIdx === 0}
                  onClick={jumpPrevSegment}
                  title="上一段 (如果在当前段 > 1s 则回到本段开头)"
                >
                  ⏮
                </button>
                <button
                  className="transport-btn primary play-btn"
                  disabled={!videoUrl}
                  onClick={togglePlay}
                  title={isPlaying ? '暂停 (空格)' : '播放 (空格)'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <button
                  className="transport-btn"
                  disabled={
                    !selectedVariant ||
                    playingSegIdx >= (selectedVariant?.segments.length ?? 0) - 1
                  }
                  onClick={jumpNextSegment}
                  title="下一段"
                >
                  ⏭
                </button>
              </div>
              <div className="highlight-player-meta-right">
                {selectedVariant && (
                  <span className="highlight-player-segchip">
                    段 {playingSegIdx + 1} / {selectedVariant.segments.length}
                  </span>
                )}
                {/* Explicit preview toggle — replaces the old auto-toggle.
                    ON  = play variant segments seamlessly, skip unused
                          parts of the video between them.
                    OFF = play freely; segments are just markers on the bar.
                    Stays under user control so the player never silently
                    switches modes. */}
                <button
                  className={`transport-btn preview-toggle${
                    previewMode ? ' on' : ''
                  }`}
                  disabled={!selectedVariant}
                  onClick={() => {
                    const next = !previewMode;
                    setPreviewMode(next);
                    if (next && selectedVariant && selectedVariant.segments.length > 0) {
                      // Entering preview mode: snap to the FIRST segment so
                      // playback actually starts the variant from the top
                      // instead of continuing mid-gap.
                      setPlayingSegIdx(0);
                      const v = videoRef.current;
                      if (v) {
                        v.currentTime = selectedVariant.segments[0].start;
                        void v.play().catch(() => {});
                      }
                    }
                  }}
                  title={
                    previewMode
                      ? '预览中:正在按顺序播放高光段。再点退出,自由播放完整视频。'
                      : '点开始按顺序预览所有高光段。再点退回完整视频自由播放。'
                  }
                >
                  {previewMode ? '预览中' : '预览'}
                </button>
                {/* Deselect variant — exits the variant view entirely and
                    returns the player to "full video" mode (transport
                    plays the raw video, timeline shows no segment markers).
                    Only visible when a variant is currently selected, so
                    the button doesn't add chrome when it's a no-op.
                    Placed here next to "预览高光" because both are
                    variant-context controls. */}
                {selectedVariant && (
                  <button
                    className="transport-btn text"
                    onClick={() => {
                      setSelectedVariantId(null);
                      setPreviewMode(false);
                      setPlayingSegIdx(0);
                    }}
                    title="退出当前变体,回到完整原视频"
                  >
                    原片
                  </button>
                )}
                <button
                  className="transport-btn"
                  disabled={!videoUrl}
                  onClick={toggleFullscreen}
                  title="全屏 (Esc 退出)"
                >
                  ⛶
                </button>
              </div>
            </div>
          </div>

          {/* (The mini-timeline editor moved out into <HighlightTimeline />
              below the whole body row — full-width, with zoom + drag-resize
              + waveform. One unified surface for scrub + edit.) */}
        </div>

        {/* Resizer lets the user trade player width for card list width. */}
        <Resizer
          direction="horizontal"
          value={cardsWidth}
          onChange={setCardsWidth}
          min={260}
          max={700}
          invert
        />

        {/* RIGHT — variant cards */}
        <div
          className="highlight-cards"
          style={{ flex: `0 0 ${cardsWidth}px`, width: cardsWidth }}
        >
          {variants.length === 0 && !generating && (
            <div className="highlight-empty" style={{ marginTop: 20 }}>
              <div className="hint">
                还没有生成变体。点右上角「生成变体」让 Claude 读字幕挑段子。
                <br />
                生成的变体只在本次会话有效,切回粗剪 tab 会清空。
              </div>
            </div>
          )}

          {/* Generating banner is rendered at panel level above so it's
              visible without scrolling the card column. */}

          <div className="variant-list">
            {variants.map((v, i) => {
              const status: VariantStatus = getVariantStatus(v, cutRanges, transcript);
              return (
                <VariantCard
                  key={v.id}
                  variant={v}
                  index={i + 1}
                  active={v.id === selectedVariantId}
                  playingSegIdx={v.id === selectedVariantId ? playingSegIdx : null}
                  status={status}
                  transcript={transcript}
                  projectId={projectId}
                  onVariantChanged={async () => {
                    if (!projectId) return;
                    const latest = await window.lynlens.getHighlights(projectId);
                    setVariants(latest);
                  }}
                  onSelect={selectVariant}
                  onSelectSegment={selectSegment}
                  onExport={handleExport}
                  onTogglePin={async (vv) => {
                    if (!projectId) return;
                    const nextPinned = !vv.pinned;
                    try {
                      const ok = await window.lynlens.setHighlightPinned(
                        projectId,
                        vv.id,
                        nextPinned
                      );
                      if (!ok) throw new Error('主进程返回 false');
                      setVariants((prev) =>
                        prev.map((x) => (x.id === vv.id ? { ...x, pinned: nextPinned } : x))
                      );
                    } catch (err) {
                      alert(`收藏失败: ${(err as Error).message}`);
                    }
                  }}
                  onDelete={async (vv) => {
                    if (!projectId) return;
                    try {
                      const ok = await window.lynlens.deleteHighlightVariant(projectId, vv.id);
                      if (!ok) throw new Error('主进程返回 false');
                      setVariants((prev) => prev.filter((x) => x.id !== vv.id));
                      if (selectedVariantId === vv.id) setSelectedVariantId(null);
                    } catch (err) {
                      alert(`删除失败: ${(err as Error).message}`);
                    }
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>

      {/* Full-width timeline below the body: doubles as scrubber AND segment
          editor. Replaces the old in-player progress bar + mini-timeline.
          Vertical Resizer above lets the user trade timeline height for
          player height, same affordance the precision tab has. */}
      {videoUrl && effectiveDuration > 0 && (
        <>
          <Resizer
            direction="vertical"
            value={timelineHeight}
            onChange={setTimelineHeight}
            min={80}
            max={420}
            invert
          />
          <div
            className="hl-timeline-outer"
            style={{ flex: `0 0 ${timelineHeight}px`, height: timelineHeight }}
          >
            <HighlightTimeline
          variant={selectedVariant}
          effectiveDuration={effectiveDuration}
          cutRanges={cutRanges}
          waveform={waveform}
          currentTimeSrc={videoCurrentTime}
          isPlaying={isPlaying}
          playingSegIdx={playingSegIdx}
          onSeek={(srcSec) => {
            const v = videoRef.current;
            if (!v) return;
            v.currentTime = srcSec;
            void v.play().catch(() => {});
          }}
          onScrub={(srcSec) => {
            // Live-scrub: just move currentTime; don't auto-play so the
            // user can drag through paused frames to find a moment.
            const v = videoRef.current;
            if (!v) return;
            v.currentTime = srcSec;
          }}
          onSetPlayingSegIdx={setPlayingSegIdx}
          onResizeSegment={async (segIdx, newStart, newEnd) => {
            if (!projectId || !selectedVariant) return;
            try {
              const ok = await window.lynlens.updateHighlightVariantSegment(
                projectId,
                selectedVariant.id,
                segIdx,
                newStart,
                newEnd
              );
              if (!ok) {
                alert(
                  '调整失败 — 可能和隔壁段重叠了,或边界超出视频范围,或段长 < 0.2 秒'
                );
                return;
              }
              const latest = await window.lynlens.getHighlights(projectId);
              setVariants(latest);
            } catch (err) {
              alert(`调整失败: ${(err as Error).message}`);
            }
          }}
          onDeleteSegment={async (segIdx) => {
            if (!projectId || !selectedVariant) return;
            if (selectedVariant.segments.length <= 1) {
              alert('至少要保留一段。如果想整体丢弃,用卡片右上角的「删除」。');
              return;
            }
            try {
              const ok = await window.lynlens.deleteHighlightVariantSegment(
                projectId,
                selectedVariant.id,
                segIdx
              );
              if (!ok) {
                alert('删除失败 — 可能是最后一段或编号越界。');
                return;
              }
              const latest = await window.lynlens.getHighlights(projectId);
              setVariants(latest);
            } catch (err) {
              alert(`删除失败: ${(err as Error).message}`);
            }
          }}
            />
          </div>
        </>
      )}

      {showDialog && (
        <GenerateHighlightDialog
          effectiveDuration={effectiveDuration}
          onCancel={() => setShowDialog(false)}
          onConfirm={handleGenerate}
        />
      )}

      {/* Variant export uses the SAME ExportDialog as the precision tab —
          same path picker, same quality dropdown, same progress UI, same
          encoder settings. Only difference is the title (shows which
          variant) + the handler dispatches to exportHighlight instead of
          export. Keeps encode parameters consistent across tabs. */}
      {exportingVariant && projectId && (
        <ExportDialog
          title={`导出高光 — ${exportingVariant.title}`}
          defaultPath={(() => {
            const srcBase = videoPath?.split(/[\\/]/).pop() ?? 'output.mp4';
            return (
              srcBase.replace(/\.[^.]+$/, '') +
              `_高光_${exportingVariant.title}.mp4`
            );
          })()}
          onClose={() => setExportingVariant(null)}
          onConfirm={(args) => {
            void window.lynlens
              .exportHighlight(
                projectId,
                exportingVariant.id,
                args.outputPath,
                args.mode === 'precise' ? 'precise' : 'precise', // 'fast' rejected
                args.quality
              )
              .then((result) => {
                alert(
                  `导出完成: ${result.outputPath}\n大小: ${
                    result.sizeBytes
                      ? (result.sizeBytes / 1024 / 1024).toFixed(1) + ' MB'
                      : '?'
                  }`
                );
                setExportingVariant(null);
              })
              .catch((err: Error) => {
                if (err.name !== 'AbortError') {
                  alert(`导出失败: ${err.message}`);
                }
              });
          }}
        />
      )}
    </div>
  );
}
