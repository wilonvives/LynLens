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
  PreviewPlaylistEntry,
} from '@lynlens/core';
import { ExportDialog } from './ExportDialog';
import { PackagingSubtitleOverlay } from './components/PackagingSubtitleOverlay';
import {
  PackagingAudioTab,
  PackagingCameraTab,
  PackagingRemotionPlayer,
  PackagingRightPanel,
  PackagingSubtitlesTab,
  PackagingTemplatesTab,
  PackagingTimelineBar,
  type PackagingPlayerRef,
  type PackagingTab,
  type PackagingTemplateId,
} from './components/packaging';
import type { SubtitleTransform } from '@lynlens/core';
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
  /** Absolute path to the trimmed clip — used to build the player's HTTP URL. */
  rawPath: string;
  playlist: PreviewPlaylistEntry[];
  durationSeconds: number;
  /** Thumbnail absolute paths (0..24 frames) for the bottom timeline strip. */
  thumbnails: string[];
  /**
   * 整片-with-cuts only: kept source ranges. When set, `rawPath` is the RAW
   * source and the player stitches these slices live (no giant concat).
   */
  clips?: Array<{ fromSec: number; toSec: number }>;
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
  // Selected packaging template. 'business-explainer' renders via Remotion
  // on export; 'default' / 'energetic' use the original libass花字 path.
  // Default to the rich template — it's the headline packaging look.
  const [template, setTemplate] = useState<PackagingTemplateId>('business-explainer');
  // Landing tab = 模板 (the user-chosen design baseline). After picking
  // one, they typically drill into 字幕 for keyword tweaks — that
  // transition happens via onSubtitleClick / 一键包装 button.
  const [activeTab, setActiveTab] = useState<PackagingTab>('templates');
  /**
   * Click-on-subtitle → jump-to-card state. We keep both the requested
   * segmentIdx AND a monotonic token so clicking the SAME subtitle again
   * still re-triggers the scroll+pulse animation.
   */
  const [jumpToIdx, setJumpToIdx] = useState<number | null>(null);
  const [jumpToken, setJumpToken] = useState(0);
  /**
   * Index of the segment currently in DIRECT-MANIPULATION edit mode
   * (drag handles visible on the subtitle in the preview). null = no
   * subtitle is being edited. Click subtitle → enter; click outside →
   * exit.
   */
  const [editingSegmentIdx, setEditingSegmentIdx] = useState<number | null>(null);

  // Preview render state.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Base URL of the localhost media server (the live Remotion player streams
  // the clip over HTTP — it can't load the lynlens-media:// scheme). Fetched
  // once; null until ready.
  const [mediaHttpBase, setMediaHttpBase] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.lynlens.getMediaHttpBase().then((base) => {
      if (!cancelled) setMediaHttpBase(base);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  /**
   * "✓ 预览真实导出" toggle state.
   *
   * - mode='fast' (default): video.src is the bare variant preview mp4
   *   + HTML overlay paints subtitles on top. Updates in real-time as
   *   the user edits the plan.
   * - mode='verify': video.src swaps to a libass-burned-in render that
   *   matches the export pixel-for-pixel. HTML overlay is hidden.
   *
   * `verifyUrl` caches the burned-in mp4 URL so toggling back and forth
   * doesn't re-render. Cleared whenever the plan changes (the verify
   * MP4 would be stale).
   */
  const [previewMode, setPreviewMode] = useState<'fast' | 'verify'>('fast');
  const [verifyUrl, setVerifyUrl] = useState<string | null>(null);
  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  // Imperative handle to the live Remotion player (seekTo). Lets clicking /
  // editing a cue in the 字幕 tab jump the player to that line's time.
  const playerRef = useRef<PackagingPlayerRef>(null);
  const seekPlayerToSec = useCallback(
    (sec: number) => {
      const fps = videoMeta?.fps ?? 30;
      playerRef.current?.seekTo(Math.max(0, Math.round(sec * fps)));
    },
    [videoMeta]
  );
  // Space toggles play/pause on the live player — but ONLY when not typing in
  // a text field (so editing a cue can still type spaces). Works anywhere in
  // the packaging tab, not just when the player is focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (!playerRef.current) return; // player not mounted
      e.preventDefault();
      playerRef.current.toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  /**
   * Video-wrap size + observer wired via a CALLBACK REF (not
   * useEffect + mutable ref). The wrap div only mounts AFTER the
   * preview mp4 loads — a useEffect with [] deps would fire BEFORE
   * that, see ref.current = null, and never re-run. Result: wrapSize
   * stayed at {0,0}, scale fell back to 1.0, subtitles rendered at
   * full source-resolution px (massive). Callback ref runs each time
   * the element mounts/unmounts, so the observer attaches the instant
   * the div exists.
   */
  const observerRef = useRef<ResizeObserver | null>(null);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
  const videoWrapRef = useCallback((el: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (el) {
      // Seed wrapSize on mount so the FIRST render after mount already
      // has the correct scale (don't wait for the first RO tick).
      setWrapSize({ w: el.clientWidth, h: el.clientHeight });
      const ro = new ResizeObserver(() => {
        setWrapSize({ w: el.clientWidth, h: el.clientHeight });
      });
      ro.observe(el);
      observerRef.current = ro;
    }
  }, []);
  useEffect(
    () => () => {
      if (observerRef.current) observerRef.current.disconnect();
    },
    []
  );

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

  // Switching variant invalidates the cached verify render (it was
  // burned in for a different timeline). Drop back to fast mode so the
  // user doesn't see a stale libass mp4 on top of a different variant.
  useEffect(() => {
    setVerifyUrl(null);
    setPreviewMode('fast');
    setVerifyError(null);
  }, [selectedVariantId]);

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
          rawPath: result.outputPath,
          playlist: result.playlist,
          durationSeconds: result.durationSeconds,
          thumbnails: result.thumbnails ?? [],
          clips: result.clips,
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

  // The live Remotion player (showLivePlayer, the active path) doesn't emit a
  // timeupdate the way <video> does, so poll its current frame each rAF and
  // feed it to currentTimeSec. This is what lets the 字幕 list follow playback
  // (highlight + scroll the active cue) like the 粗剪 panel. setState bails when
  // the value is unchanged, so a paused player costs only a number read.
  useEffect(() => {
    if (!(preview && videoMeta)) return;
    const fps = videoMeta.fps || 30;
    let raf = 0;
    // Throttle to ~12fps. The poll feeds currentTimeSec, which re-renders the
    // spec editor (40+ cue cards). At the full 60fps that re-render storm
    // starves the main thread → the 字号 / cue inputs can't paint their caret
    // ("光标跑不出来"). 12fps is plenty for highlighting/scrolling the active
    // cue, and cuts the re-renders ~5×.
    let lastEmit = 0;
    const tick = (): void => {
      const now = performance.now();
      if (now - lastEmit >= 80) {
        lastEmit = now;
        const p = playerRef.current;
        const f = p?.getCurrentFrame?.();
        if (typeof f === 'number' && Number.isFinite(f)) {
          setCurrentTimeSec(f / fps);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // Re-binds when a new preview clip loads (fps / player instance change).
    // The live Remotion player is the only preview path, so this always runs.
  }, [preview, videoMeta]);

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

  /** Imperative seek used by the subtitles tab + timeline strip. */
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
   * picker stroke / chip toggle, which would spam IPC + .qcp writes.
   * 200ms after the last edit we flush. Keeps preview reactive (state
   * updated locally on every edit) and persistence eventually-consistent.
   *
   * `pendingPlanRef` tracks the latest-edited plan that hasn't yet been
   * persisted. Required because the export flow needs to FLUSH this
   * pending change synchronously before kicking off ffmpeg — otherwise
   * a user who edits a chip then immediately clicks 导出 sees the OLD
   * plan baked into the mp4 (the timer hadn't fired yet).
   */
  const planSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPlanRef = useRef<PackagingPlan | null>(null);

  const flushPlanSave = useCallback(async (): Promise<void> => {
    if (planSaveTimerRef.current) {
      clearTimeout(planSaveTimerRef.current);
      planSaveTimerRef.current = null;
    }
    const pending = pendingPlanRef.current;
    if (!pending || !projectId) return;
    pendingPlanRef.current = null;
    try {
      await window.lynlens.setPackagingPlan(projectId, pending);
    } catch (err) {
      console.error('[packaging] flush plan failed', err);
    }
  }, [projectId]);

  const handlePlanChange = useCallback(
    (next: PackagingPlan) => {
      setPlan(next);
      if (!projectId) return;
      pendingPlanRef.current = next;
      if (planSaveTimerRef.current) clearTimeout(planSaveTimerRef.current);
      planSaveTimerRef.current = setTimeout(() => {
        const toSave = pendingPlanRef.current;
        planSaveTimerRef.current = null;
        if (!toSave) return;
        pendingPlanRef.current = null;
        void window.lynlens.setPackagingPlan(projectId, toSave).catch((err) => {
          console.error('[packaging] save plan failed', err);
        });
      }, 200);
      // Editing the plan invalidates any cached "verify" render — the
      // burned-in mp4 no longer matches the plan. Drop back to fast
      // mode so the user keeps seeing live updates instead of a stale
      // libass render.
      setVerifyUrl(null);
      setPreviewMode('fast');
    },
    [projectId]
  );

  async function handleGeneratePlan(): Promise<void> {
    if (!projectId) return;
    setGenerating(true);
    try {
      // Both templates render via Remotion (live player + export). 商务讲解
      // → AI authors the rich spec; 通用 → plain `simple` cues (no AI), user
      // marks keywords + edits text afterward.
      const next =
        template === 'business-explainer'
          ? await window.lynlens.generatePackagingSpec(projectId, selectedVariantId)
          : await window.lynlens.generatePackagingSpecSimple(projectId, selectedVariantId);
      setPlan(next);
    } catch (err) {
      alert(`一键包装失败: ${(err as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  /**
   * Toggle the "fast HTML preview" ↔ "real export verify" mode.
   *
   * Fast mode is the default: an MP4 with no burn-in plays underneath
   * the HTML/CSS subtitle overlay. Edits are reflected in real-time.
   *
   * Verify mode requests a ffmpeg + libass render of the same playlist
   * but with the ASS subtitles burned in pixel-for-pixel. This matches
   * what 🎬 导出成品 will produce. It takes 5-15s on first request and
   * is cached by ASS content hash (re-toggling is instant; editing the
   * plan invalidates and forces re-render next toggle).
   *
   * 整片 is not supported — the full-video burn-in would take minutes,
   * defeating the "interactive preview" purpose.
   */
  async function togglePreviewMode(): Promise<void> {
    if (!projectId || !selectedVariantId) return;
    if (previewMode === 'verify') {
      // Cheap toggle back: video.src swap, no IPC.
      setPreviewMode('fast');
      return;
    }
    // Entering verify mode. If we already have a cached URL for the
    // current plan, just swap. Otherwise fetch one.
    if (verifyUrl) {
      setPreviewMode('verify');
      return;
    }
    // Make sure the latest in-flight edit is persisted before the main
    // process reads the plan — same race as the export path.
    await flushPlanSave();
    setVerifyLoading(true);
    setVerifyError(null);
    try {
      // 商务讲解 → render the real Remotion pipeline (first ~20s, pixel-
      // identical to 导出成品). 通用/高能 → the libass burn-in preview.
      const result =
        template === 'business-explainer'
          ? await window.lynlens.preparePackagingVerifyRemotion(
              projectId,
              selectedVariantId
            )
          : await window.lynlens.preparePackagingVerifyPreview(
              projectId,
              selectedVariantId
            );
      setVerifyUrl(toMediaUrl(result.outputPath));
      setPreviewMode('verify');
    } catch (err) {
      setVerifyError((err as Error).message);
    } finally {
      setVerifyLoading(false);
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

  // Both templates (商务讲解 + 通用) now render via Remotion, so the live
  // player is the preview for both. (The HTML overlay + libass verify path
  // is retired for the packaging tab.)
  const showLivePlayer = true;

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
        {/* Variant selector as a dropdown — collapses what used to be a
            wide button row, scales to N variants without wrapping. */}
        <label
          style={{
            fontSize: 12,
            color: 'var(--text2)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          包装对象
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            disabled={generating || exportState.active}
            style={{ maxWidth: 220 }}
          >
            <option value={ROOT_KEY}>整片</option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.pinned ? '📌 ' : ''}
                {v.title} · {v.durationSeconds.toFixed(1)}s
              </option>
            ))}
          </select>
        </label>
        {plan && (
          <>
            {/* "Verify export" toggle — only for 通用/高能 (libass). The
                商务讲解 template shows a LIVE player, so verify is redundant. */}
            {selectedVariantId && !showLivePlayer && (
              <button
                onClick={() => void togglePreviewMode()}
                disabled={verifyLoading || exportState.active}
                title={
                  previewMode === 'verify'
                    ? '返回 HTML 快速预览(实时反映编辑)'
                    : '渲染一段烧字的真实视频,看到的就是导出像素效果(5-15 秒)'
                }
                style={{
                  background:
                    previewMode === 'verify' ? 'rgba(122,162,247,0.18)' : undefined,
                  borderColor:
                    previewMode === 'verify' ? 'rgba(122,162,247,0.6)' : undefined,
                }}
              >
                {verifyLoading
                  ? '⏳ 渲染中...'
                  : previewMode === 'verify'
                    ? '← 返回快速预览'
                    : '✓ 预览真实导出'}
              </button>
            )}
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
        {variants.length === 0 && (
          <div
            style={{
              padding: '6px 12px',
              fontSize: 11,
              color: 'var(--text3)',
              background: '#181820',
              border: '1px solid #2a2a2a',
              borderRadius: 4,
            }}
          >
            没有高光变体 — 想包装单个变体,先去「高光」tab 生成。
          </div>
        )}

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

        {verifyError && (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 12,
              color: '#ff6b6b',
              background: 'rgba(255,107,107,0.08)',
              border: '1px solid rgba(255,107,107,0.3)',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ flex: 1 }}>真实导出预览失败: {verifyError}</span>
            <button
              onClick={() => setVerifyError(null)}
              style={{ fontSize: 11, padding: '2px 8px' }}
            >
              知道了
            </button>
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
              {preview && videoMeta && showLivePlayer ? (
                /* Live Remotion player — the real composition, real-time,
                   data-driven. Renders exactly what 导出成品 produces.
                   NOTE: a full-size box (not an aspectRatio wrapper) — the
                   Player has no intrinsic size to drive an aspectRatio box,
                   so that collapses to 0px. The Player letterboxes the 9:16
                   composition inside this box itself. */
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <PackagingRemotionPlayer
                    playerRef={playerRef}
                    videoSrc={
                      mediaHttpBase
                        ? `${mediaHttpBase}/media?p=${encodeURIComponent(preview.rawPath)}`
                        : preview.videoUrl
                    }
                    spec={plan?.templateSpec ?? { cues: [] }}
                    clips={preview.clips}
                    durationInSeconds={preview.durationSeconds}
                    fps={videoMeta.fps}
                    width={videoMeta.width}
                    height={videoMeta.height}
                  />
                </div>
              ) : preview && videoMeta ? (
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
                    src={
                      previewMode === 'verify' && verifyUrl
                        ? verifyUrl
                        : preview.videoUrl
                    }
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
                  {/* HTML subtitle overlay — only in fast mode. In verify
                      mode subtitles are already burned into the mp4 by
                      libass and a second HTML layer would double-paint
                      them. */}
                  {previewMode === 'fast' && (
                  <PackagingSubtitleOverlay
                    transcript={transcript}
                    plan={plan}
                    currentTimeSec={currentTimeSec}
                    playlist={preview.playlist}
                    orientation={orientation}
                    sourceHeight={videoMeta.height}
                    displayHeight={wrapSize.h}
                    editingSegmentIdx={editingSegmentIdx}
                    onEnterEdit={(segmentIdx) => {
                      // Click subtitle → enter direct-manipulation edit
                      // mode (drag handles appear). Also jump the right-
                      // side card so keyword edits are one click away.
                      setEditingSegmentIdx(segmentIdx);
                      setActiveTab('subtitles');
                      setJumpToIdx(segmentIdx);
                      setJumpToken((t) => t + 1);
                    }}
                    onExitEdit={() => setEditingSegmentIdx(null)}
                    onTransformChange={(segmentIdx, t: SubtitleTransform) => {
                      if (!plan) return;
                      // Upsert this segment's transform without touching
                      // other fields. Debounce-save via handlePlanChange.
                      const existing = plan.segments.find(
                        (s) => s.segmentIdx === segmentIdx
                      );
                      const base = existing ?? { segmentIdx };
                      const nextSeg = {
                        ...base,
                        subtitle: { ...(base.subtitle ?? {}), transform: t },
                      };
                      const others = plan.segments.filter(
                        (s) => s.segmentIdx !== segmentIdx
                      );
                      handlePlanChange({
                        ...plan,
                        segments: [...others, nextSeg].sort(
                          (a, b) => a.segmentIdx - b.segmentIdx
                        ),
                      });
                    }}
                  />
                  )}
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

              {verifyLoading && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    background: 'rgba(0, 0, 0, 0.78)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 12,
                    zIndex: 11,
                    color: '#fff',
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      border: '3px solid rgba(255,255,255,0.2)',
                      borderTopColor: 'rgba(122,162,247,1)',
                      borderRadius: '50%',
                      animation: 'lynlens-spin 1s linear infinite',
                    }}
                  />
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
                    ✓ 渲染真实导出预览中...
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'rgba(255,255,255,0.6)',
                      textAlign: 'center',
                      maxWidth: 320,
                      lineHeight: 1.6,
                    }}
                  >
                    {template === 'business-explainer'
                      ? '用 Remotion 渲染前 ~20 秒真实预览,通常 10-15 秒。'
                      : '用导出引擎渲染一段字幕预览,通常 5-15 秒。'}
                    <br />
                    渲完显示的就是 🎬 导出成品的像素效果。
                  </div>
                </div>
              )}
            </div>

            {/* Combined playback controls + visual scrubber. Hidden when the
                live Remotion player is shown — it has its own scrubber. */}
            {preview && !showLivePlayer && (
              <PackagingTimelineBar
                thumbnails={preview.thumbnails}
                durationSeconds={preview.durationSeconds}
                currentTimeSec={currentTimeSec}
                isPlaying={isPlaying}
                disabled={preparingPreview}
                onSeek={seekTo}
                onTogglePlay={() => void togglePlay()}
              />
            )}
          </div>

          {/* Right column: tabbed editor panel. */}
          <PackagingRightPanel
            activeTab={activeTab}
            onTabChange={setActiveTab}
            templatesContent={
              <PackagingTemplatesTab
                selected={template}
                onSelect={setTemplate}
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
                  scrollToSegmentIdx={jumpToIdx}
                  scrollToken={jumpToken}
                  onSeek={seekTo}
                  onSeekToSec={seekPlayerToSec}
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
            cameraContent={
              <PackagingCameraTab
                spec={plan?.templateSpec}
                currentTimeSec={currentTimeSec}
                onSpecChange={
                  plan
                    ? (next) => handlePlanChange({ ...plan, templateSpec: next })
                    : undefined
                }
              />
            }
            audioContent={
              <PackagingAudioTab
                spec={plan?.templateSpec}
                currentTimeSec={currentTimeSec}
                onSpecChange={
                  plan
                    ? (next) => handlePlanChange({ ...plan, templateSpec: next })
                    : undefined
                }
              />
            }
          />
        </div>
      </div>

      {/* Final export via the Remotion business-explainer template
          (vertical CJK / gradient keywords / camera punch / sfx). Scope:
          packaging tab only — other tabs keep the ffmpeg+libass path. */}
      {exportTarget && plan && (
        <ExportDialog
          title={`导出包装成品 — ${exportTarget.title}`}
          defaultPath={exportTarget.defaultPath}
          onClose={() => setExportTarget(null)}
          onConfirm={async ({ outputPath }) => {
            try {
              // Critical: flush ANY pending plan edit before kicking off
              // the render. Without this, a user who edits a chip then
              // immediately clicks 导出 races the 200ms debounce — the
              // export would render a stale plan.
              await flushPlanSave();
              // Both templates render via Remotion (商务讲解 full / 通用
              // simple-outline). Same export path; the stored templateSpec
              // selects per-cue styling.
              await window.lynlens.exportPackagedRemotion(
                projectId,
                exportTarget.variantId,
                outputPath
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
