import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HighlightStyle, HighlightVariant, Range, VariantStatus } from '@lynlens/core';
import { getVariantStatus } from './core-browser';
import { GenerateHighlightDialog } from './GenerateHighlightDialog';
import { HighlightMiniTimeline } from './HighlightMiniTimeline';
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
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const [playerWrapSize, setPlayerWrapSize] = useState({ w: 0, h: 0 });

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [playingSegIdx, setPlayingSegIdx] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  // Right-column width (variant cards). Left column (player) stretches to fill.
  const [cardsWidth, setCardsWidth] = usePersistedSize('lynlens.highlightCardsWidth', 380);

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

  // Seamless variant playback + progress tracking in one RAF. When the video
  // hits the current segment's end, either jump to next or pause. While
  // running we also keep `elapsed` in sync for the progress bar.
  useEffect(() => {
    if (!selectedVariant) return;
    let raf = 0;
    const tick = (): void => {
      const v = videoRef.current;
      if (v && selectedVariant.segments.length > 0) {
        const segs = selectedVariant.segments;
        const cur = segs[playingSegIdx] ?? segs[0];
        if (!v.paused) {
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
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedVariant, playingSegIdx]);

  const selectVariant = useCallback((variant: HighlightVariant) => {
    setSelectedVariantId(variant.id);
    setPlayingSegIdx(0);
    setElapsed(0);
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
   * Click anywhere on the progress bar to seek to that point in the variant.
   * Converts the click's fraction-of-bar to elapsed-within-variant, then
   * finds the segment and offset that hits.
   */
  const onProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!selectedVariant) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetElapsed = frac * selectedVariant.durationSeconds;
      let remaining = targetElapsed;
      for (let i = 0; i < selectedVariant.segments.length; i++) {
        const s = selectedVariant.segments[i];
        const segLen = s.end - s.start;
        if (remaining <= segLen) {
          setPlayingSegIdx(i);
          const v = videoRef.current;
          if (v) {
            v.currentTime = s.start + remaining;
            void v.play().catch(() => {});
          }
          return;
        }
        remaining -= segLen;
      }
    },
    [selectedVariant]
  );

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

  async function handleExport(variant: HighlightVariant): Promise<void> {
    if (!projectId) return;
    const srcBase = videoPath?.split(/[\\/]/).pop() ?? 'output.mp4';
    const defaultName = srcBase.replace(/\.[^.]+$/, '') + `_高光_${variant.title}.mp4`;
    const target = await window.lynlens.saveDialog(defaultName);
    if (!target) return;
    try {
      await window.lynlens.exportHighlight(projectId, variant.id, target);
      alert(`导出完成: ${target}`);
    } catch (err) {
      alert(`导出失败: ${(err as Error).message}`);
    }
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
          <div className="highlight-player-video" ref={playerWrapRef}>
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                controls={false}
                style={videoStyle}
              />
            ) : (
              <div className="drop-hint">视频未加载</div>
            )}
            {!selectedVariant && videoUrl && (
              <div className="highlight-player-overlay">
                点击右侧变体开始播放
              </div>
            )}
          </div>

          {/* Progress bar — split into segments so the user sees the structure. */}
          {selectedVariant && (
            <div
              className="highlight-progress"
              onClick={onProgressClick}
              title="点击跳转到变体内任意位置"
            >
              <div className="highlight-progress-bg">
                {selectedVariant.segments.map((s, i) => {
                  const segLen = s.end - s.start;
                  const frac = segLen / totalVariantSec;
                  return (
                    <div
                      key={i}
                      className={`highlight-progress-seg${
                        i === playingSegIdx ? ' current' : ''
                      }`}
                      style={{ flex: `0 0 ${frac * 100}%` }}
                    />
                  );
                })}
              </div>
              <div
                className="highlight-progress-cursor"
                style={{ left: `${progressFrac * 100}%` }}
              />
            </div>
          )}

          {/* Mini-timeline: always visible when a variant is selected.
              Drag segment edges to tune start/end. Delete / add via the
              inline buttons. Same data the card editor mutates — two
              views of one state. */}
          {selectedVariant && projectId && (
            <HighlightMiniTimeline
              projectId={projectId}
              variant={selectedVariant}
              getPlayheadSourceSec={() => {
                const v = videoRef.current;
                if (!v) return null;
                const t = v.currentTime;
                return Number.isFinite(t) ? t : null;
              }}
              onVariantChanged={async () => {
                const latest = await window.lynlens.getHighlights(projectId);
                setVariants(latest);
              }}
            />
          )}

          <div className="highlight-player-controls">
            <button onClick={togglePlay} disabled={!selectedVariant}>
              {isPlaying ? '暂停' : '播放'}
            </button>
            <div className="highlight-player-meta">
              {selectedVariant ? (
                <>
                  <span className="highlight-player-title">
                    {selectedVariant.title}
                  </span>
                  <span className="highlight-player-pos">
                    段 {playingSegIdx + 1} / {selectedVariant.segments.length}
                    {' · '}
                    {elapsed.toFixed(1)}s / {totalVariantSec.toFixed(1)}s
                  </span>
                </>
              ) : (
                <span className="highlight-player-pos">未选中变体</span>
              )}
            </div>
          </div>
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

      {showDialog && (
        <GenerateHighlightDialog
          effectiveDuration={effectiveDuration}
          onCancel={() => setShowDialog(false)}
          onConfirm={handleGenerate}
        />
      )}
    </div>
  );
}
