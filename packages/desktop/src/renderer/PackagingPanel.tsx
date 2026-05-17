/**
 * 包装 tab — AI-driven 一键包装 (v0.5).
 *
 * Layout (open-pai / 开拍 inspired):
 *
 *   ┌────────────────────────────────────────────────────────┐
 *   │ header: title + 风格 dropdown + ✨ 包装 / ⚙ / 🎬 / 🗑    │
 *   ├──────────────────────────┬─────────────────────────────┤
 *   │ variant selector          │  [模板] [字幕] [画面] [声音]   │
 *   │ variant banner            │  ─────                     │
 *   │ export-in-progress banner │  <active tab content>      │
 *   │                           │                            │
 *   │  ┌─────────────────────┐  │  字幕 tab:                  │
 *   │  │   video preview     │  │   default-color picker     │
 *   │  │   (with overlay)    │  │   list of segment cards    │
 *   │  └─────────────────────┘  │   (click to seek, click   │
 *   │  ▶ 00:00 / 02:52  ━━━     │    word to highlight)      │
 *   └──────────────────────────┴─────────────────────────────┘
 *
 * Architecture:
 *   - **Pre-rendered preview mp4** per variant via preparePackagingPreview
 *     IPC. First selection: a few seconds (h264_videotoolbox); subsequent:
 *     instant (cache).
 *   - `<video>` plays the variant directly. `video.currentTime` is variant
 *     time (0..variantDuration), no seek-flicker between segments.
 *   - `PackagingSubtitleOverlay` gets a playlist prop to map variant time
 *     → source time so the transcript lookup still works.
 *   - Right panel: tabbed (templates/subtitles/camera/audio). 字幕 tab is
 *     the inline list editor that replaces the old popup MicroEditor.
 *   - Plan edits are bubbled up from the tab and persisted to
 *     setPackagingPlan IPC (debounced to avoid spamming on every color
 *     picker change).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  HighlightVariant,
  PackagingPlan,
  PackagingVibe,
  PreviewPlaylistEntry,
} from '@lynlens/core';
import { ExportDialog } from './ExportDialog';
import { PackagingSubtitleOverlay } from './components/PackagingSubtitleOverlay';
import {
  PackagingAudioTab,
  PackagingCameraTab,
  PackagingRightPanel,
  PackagingSubtitlesTab,
  PackagingTemplatesTab,
  type PackagingTab,
} from './components/packaging';
import { useStore } from './store';
import { formatTime } from './util';

interface Props {
  /** Effective duration of the rippled video (post-cut total seconds). */
  effectiveDuration: number;
  videoPath: string | null;
}

/** Sentinel = "整片", distinct from any variant id. */
const ROOT_KEY = '__root__';

/** Build the lynlens-media:// URL the same way the main IPC does. */
function toMediaUrl(absPath: string): string {
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

interface PreviewState {
  videoUrl: string;
  playlist: PreviewPlaylistEntry[];
  durationSeconds: number;
}

export function PackagingPanel({ effectiveDuration }: Props): JSX.Element {
  const projectId = useStore((s) => s.projectId);
  const sourceVideoUrl = useStore((s) => s.videoUrl);
  const videoMeta = useStore((s) => s.videoMeta);
  const transcript = useStore((s) => s.transcript);
  const exportState = useStore((s) => s.export);

  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(ROOT_KEY);
  const [plan, setPlan] = useState<PackagingPlan | null>(null);
  const [generating, setGenerating] = useState(false);
  const [vibe, setVibe] = useState<PackagingVibe>('default');
  const [activeTab, setActiveTab] = useState<PackagingTab>('subtitles');

  // Preview render state.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  /**
   * Snapshot of the export target frozen at the moment the user clicks
   * 🎬 导出成品. The dialog binds to this snapshot, so switching
   * variants mid-export doesn't a) change the dialog filename, b) confuse
   * which variant the export is for, c) silently send a different
   * variantId to the IPC than what the title says.
   */
  type ExportTarget = {
    variantId: string | null;
    title: string;
    defaultPath: string;
  };
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoWrapRef = useRef<HTMLDivElement | null>(null);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = videoWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWrapSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const selectedVariantId = selectedKey === ROOT_KEY ? null : selectedKey;
  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === selectedKey),
    [variants, selectedKey]
  );

  // Hydrate variants so the source selector has options.
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

  // Hydrate packaging plan whenever variant selection changes.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void window.lynlens
      .getPackagingPlan(projectId, selectedVariantId)
      .then((p) => {
        if (!cancelled) setPlan(p);
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedVariantId]);

  // Prepare preview mp4 on variant change.
  useEffect(() => {
    if (!projectId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setPreparingPreview(true);
    setPreviewError(null);
    void window.lynlens
      .preparePackagingPreview(projectId, selectedVariantId)
      .then((result) => {
        if (cancelled) return;
        setPreview({
          videoUrl: toMediaUrl(result.outputPath),
          playlist: result.playlist,
          durationSeconds: result.durationSeconds,
        });
        setCurrentTimeSec(0);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setPreviewError(err.message);
        setPreview(null);
      })
      .finally(() => {
        if (!cancelled) setPreparingPreview(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, selectedVariantId]);

  // rAF-driven smooth scrubber updates during playback.
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = (): void => {
      const v = videoRef.current;
      if (v && !v.paused) {
        setCurrentTimeSec(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  async function togglePlay(): Promise<void> {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      if (preview && v.currentTime >= preview.durationSeconds - 0.05) {
        v.currentTime = 0;
      }
      try {
        await v.play();
      } catch {
        /* autoplay block — ignore */
      }
    } else {
      v.pause();
    }
  }

  function onScrubChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const t = Number(e.target.value);
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = t;
      setCurrentTimeSec(t);
    } catch {
      /* defensive */
    }
  }

  /** Imperative seek used by the subtitles tab when user clicks a row. */
  const seekTo = useCallback((variantSec: number) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, variantSec);
      setCurrentTimeSec(v.currentTime);
    } catch {
      /* defensive */
    }
  }, []);

  /**
   * Debounce plan saves: the 字幕 tab fires onPlanChange on every color
   * picker stroke, which spams IPC + .qcp writes. 200ms after the last
   * change we flush. Keeps preview reactive (already updated locally)
   * and persistence eventually-consistent.
   */
  const planSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlePlanChange = useCallback(
    (next: PackagingPlan) => {
      setPlan(next);
      if (!projectId) return;
      if (planSaveTimerRef.current) clearTimeout(planSaveTimerRef.current);
      planSaveTimerRef.current = setTimeout(() => {
        void window.lynlens.setPackagingPlan(projectId, next).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[packaging] save plan failed', err);
        });
      }, 200);
    },
    [projectId]
  );

  async function handleGeneratePlan(): Promise<void> {
    if (!projectId) return;
    setGenerating(true);
    try {
      const next = await window.lynlens.generatePackagingPlan(
        projectId,
        selectedVariantId,
        vibe
      );
      setPlan(next);
    } catch (err) {
      alert(`一键包装失败: ${(err as Error).message}`);
    } finally {
      setGenerating(false);
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
          一键包装基于字幕内容来决定每段的字幕样式。回到「粗剪」tab 点「字幕转录」后再来。
        </div>
      </div>
    );
  }

  const orientation: 'portrait' | 'landscape' | 'unknown' =
    videoMeta
      ? videoMeta.width >= videoMeta.height
        ? 'landscape'
        : 'portrait'
      : 'unknown';

  const previewDuration = preview?.durationSeconds ?? 0;

  return (
    <div className="highlight-panel">
      <div className="highlight-panel-header">
        <div>
          <div className="highlight-panel-title">一键包装</div>
          <div className="highlight-panel-sub">
            AI 看字幕,自动给关键词加花字 · 基于{' '}
            {formatTime(effectiveDuration)} 视频 · {transcript.segments.length} 段字幕
          </div>
        </div>
        <div className="spacer" />
        {plan && (
          <>
            <button
              className="primary"
              onClick={() => {
                const title = selectedVariant?.title ?? '整片';
                setExportTarget({
                  variantId: selectedVariantId,
                  title,
                  defaultPath: `${title}-包装.mp4`,
                });
              }}
              disabled={exportState.active}
              title={
                exportState.active
                  ? '当前已有导出任务在跑,等它完成'
                  : '把花字烧进视频,导出成片'
              }
            >
              🎬 导出成品
            </button>
            <button
              onClick={async () => {
                if (!confirm('清除当前的包装方案?')) return;
                try {
                  await window.lynlens.clearPackagingPlan(
                    projectId,
                    selectedVariantId
                  );
                  setPlan(null);
                } catch (err) {
                  alert(`清除失败: ${(err as Error).message}`);
                }
              }}
              title="放弃包装方案"
            >
              🗑 清除
            </button>
          </>
        )}
      </div>

      <div className="highlight-body" style={{ flexDirection: 'column', gap: 12 }}>
        {/* Variant selector — full width across the top */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: '#181820',
            border: '1px solid #2a2a2a',
            borderRadius: 6,
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text2)', alignSelf: 'center' }}>
            包装对象:
          </span>
          <button
            className={`work-mode-tab${selectedKey === ROOT_KEY ? ' active' : ''}`}
            onClick={() => setSelectedKey(ROOT_KEY)}
            style={{ fontSize: 12, padding: '4px 10px' }}
            title="整个粗剪后的视频"
          >
            整片
          </button>
          {variants.length === 0 && (
            <span style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'center' }}>
              (没有高光变体 — 想包装单个变体,先去「高光」tab 生成)
            </span>
          )}
          {variants.map((v) => (
            <button
              key={v.id}
              className={`work-mode-tab${selectedKey === v.id ? ' active' : ''}`}
              onClick={() => setSelectedKey(v.id)}
              style={{ fontSize: 12, padding: '4px 10px' }}
              title={`${v.durationSeconds.toFixed(1)}s · ${v.segments.length} 段`}
            >
              {v.pinned && '📌 '}
              {v.title}
            </button>
          ))}
        </div>

        {/* Variant context label. */}
        {selectedVariant && (
          <div
            style={{
              padding: '4px 12px',
              fontSize: 11,
              color: 'var(--text2)',
              background: 'rgba(243, 156, 18, 0.08)',
              border: '1px solid rgba(243, 156, 18, 0.3)',
              borderRadius: 4,
            }}
          >
            🎬 正在播放变体「{selectedVariant.title}」 · {selectedVariant.segments.length} 段 ·{' '}
            {formatTime(selectedVariant.durationSeconds)} · 预渲染为连续片段
          </div>
        )}

        {/* Export-in-progress banner. */}
        {exportState.active && exportTarget && (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 12,
              color: '#fff',
              background: 'rgba(122, 162, 247, 0.18)',
              border: '1px solid rgba(122, 162, 247, 0.6)',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 14 }}>🎬</span>
            <span style={{ flex: 1 }}>
              正在导出「{exportTarget.title}」 — {exportState.stage}{' '}
              {exportState.percent.toFixed(0)}%
            </span>
            <div
              style={{
                flex: '0 0 120px',
                height: 6,
                background: 'rgba(0,0,0,0.3)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${exportState.percent}%`,
                  height: '100%',
                  background: '#7aa2f7',
                  transition: 'width 0.2s linear',
                }}
              />
            </div>
          </div>
        )}

        {previewError && (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 12,
              color: '#ff6b6b',
              background: 'rgba(255,107,107,0.08)',
              border: '1px solid rgba(255,107,107,0.3)',
              borderRadius: 4,
            }}
          >
            预览生成失败: {previewError}
          </div>
        )}

        {/* Main 2-column area: video preview (left) + tabbed editor (right). */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            gap: 12,
            minHeight: 0,
          }}
        >
          {/* Left column: video preview + playbar. */}
          <div
            style={{
              flex: '2 1 0',
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div
              style={{
                flex: 1,
                background: '#000',
                border: '1px solid #2a2a2a',
                borderRadius: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 0,
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {preview && videoMeta ? (
                <div
                  ref={videoWrapRef}
                  style={{
                    position: 'relative',
                    aspectRatio: `${videoMeta.width} / ${videoMeta.height}`,
                    maxWidth: '100%',
                    maxHeight: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <video
                    ref={videoRef}
                    src={preview.videoUrl}
                    onTimeUpdate={(e) => setCurrentTimeSec(e.currentTarget.currentTime)}
                    onPlay={() => setIsPlaying(true)}
                    onPause={() => setIsPlaying(false)}
                    onEnded={() => setIsPlaying(false)}
                    onClick={() => void togglePlay()}
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'block',
                      cursor: 'pointer',
                    }}
                  />
                  <PackagingSubtitleOverlay
                    transcript={transcript}
                    plan={plan}
                    currentTimeSec={currentTimeSec}
                    playlist={preview.playlist}
                    orientation={orientation}
                    sourceHeight={videoMeta.height}
                    displayHeight={wrapSize.h}
                  />
                </div>
              ) : sourceVideoUrl ? (
                <div style={{ color: 'var(--text3)' }}>
                  {preparingPreview ? '准备预览中...' : '请选择包装对象'}
                </div>
              ) : (
                <div style={{ color: 'var(--text3)' }}>视频未加载</div>
              )}

              {generating && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.75)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    zIndex: 10,
                    color: '#fff',
                  }}
                >
                  <div
                    style={{
                      width: 48,
                      height: 48,
                      border: '4px solid rgba(255,255,255,0.2)',
                      borderTopColor: 'var(--accent)',
                      borderRadius: '50%',
                      animation: 'lynlens-spin 1s linear infinite',
                    }}
                  />
                  <div style={{ fontSize: 16, fontWeight: 500 }}>
                    ✨ AI 正在设计字幕花字
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                    看完 {transcript.segments.length} 段字幕,挑关键词高亮...通常 5-15 秒
                  </div>
                </div>
              )}

              {preparingPreview && !generating && selectedVariantId && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.75)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    zIndex: 9,
                    color: '#fff',
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      border: '3px solid rgba(255,255,255,0.2)',
                      borderTopColor: '#7aa2f7',
                      borderRadius: '50%',
                      animation: 'lynlens-spin 1s linear infinite',
                    }}
                  />
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    🎬 准备预览中...
                  </div>
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
                    把变体拼成一段连续片段(首次几秒,之后秒开)
                  </div>
                </div>
              )}
            </div>

            {/* Playbar — under the video, in the left column */}
            {preview && videoMeta && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  background: '#181820',
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                }}
              >
                <button
                  onClick={() => void togglePlay()}
                  disabled={preparingPreview}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 18,
                    border: 'none',
                    background: preparingPreview ? '#444' : 'var(--accent)',
                    color: '#fff',
                    fontSize: 14,
                    cursor: preparingPreview ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                  title={isPlaying ? '暂停' : '播放'}
                >
                  {isPlaying ? '⏸' : '▶'}
                </button>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text2)',
                    fontVariantNumeric: 'tabular-nums',
                    minWidth: 100,
                  }}
                >
                  {formatTime(currentTimeSec)} / {formatTime(previewDuration)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={previewDuration || 0.0001}
                  step={0.01}
                  value={Math.min(currentTimeSec, previewDuration)}
                  onChange={onScrubChange}
                  disabled={preparingPreview}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
              </div>
            )}
          </div>

          {/* Right column: tabbed editor panel. */}
          <PackagingRightPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            templatesContent={
              <PackagingTemplatesTab
                vibe={vibe}
                onVibeChange={setVibe}
                onGenerate={() => void handleGeneratePlan()}
                generating={generating}
                hasPlan={!!plan}
              />
            }
            subtitlesContent={
              plan && preview ? (
                <PackagingSubtitlesTab
                  transcript={transcript}
                  playlist={preview.playlist}
                  plan={plan}
                  currentTimeSec={currentTimeSec}
                  onSeek={seekTo}
                  onPlanChange={handlePlanChange}
                />
              ) : (
                <div
                  style={{
                    padding: 20,
                    fontSize: 12,
                    color: 'var(--text3)',
                    textAlign: 'center',
                    lineHeight: 1.7,
                  }}
                >
                  还没有包装方案。
                  <br />
                  到「模板」tab 选风格 → 点 ✨ 一键包装。
                </div>
              )
            }
            cameraContent={<PackagingCameraTab />}
            audioContent={<PackagingAudioTab />}
          />
        </div>
      </div>

      {/* Final export with花字 burned in. Bound to the snapshotted target. */}
      {exportTarget && plan && (
        <ExportDialog
          title={`导出包装成品 — ${exportTarget.title}`}
          defaultPath={exportTarget.defaultPath}
          onClose={() => setExportTarget(null)}
          onConfirm={async ({ outputPath, quality }) => {
            try {
              await window.lynlens.exportPackaged(
                projectId,
                exportTarget.variantId,
                outputPath,
                quality
              );
              setExportTarget(null);
              alert(`✅ 导出完成: ${outputPath}`);
            } catch (err) {
              alert(`导出失败: ${(err as Error).message}`);
            }
          }}
        />
      )}
    </div>
  );
}
