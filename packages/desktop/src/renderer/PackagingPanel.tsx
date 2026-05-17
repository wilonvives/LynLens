/**
 * 包装 tab — AI-driven 一键包装 (v0.5 MVP, scope: subtitle 花字 only).
 *
 * **Deliberately minimal**: the user explicitly said "不要做那么多效果先",
 * so this tab does ONE thing — play the variant as a continuous reel
 * with a styled subtitle overlay (per-segment color + per-word highlight).
 * No camera zoom. No transitions. No export pipeline (variants still
 * export through the existing ffmpeg path).
 *
 * Architecture:
 *   - **Pre-rendered preview mp4** per variant via `preparePackagingPreview`
 *     IPC. The first selection of a variant takes a few seconds (hardware-
 *     encoded h264_videotoolbox). Subsequent selections are instant (cache
 *     hit). For 整片, the IPC just returns the source path.
 *   - `<video>` plays the preview mp4 directly. `video.currentTime` is
 *     VARIANT time (0..variantDuration), not source time. No seek-flicker
 *     between segments — the segments are already concatenated.
 *   - `PackagingSubtitleOverlay` gets a `playlist` prop that maps variant
 *     time → source time, so it can still look up the right transcript
 *     segment (subtitles are stored in source time).
 *   - Custom playbar (▶/⏸ + time + scrubber) since native controls don't
 *     give us styling control and don't look great with the overlay.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  HighlightVariant,
  PackagingPlan,
  PackagingVibe,
  PreviewPlaylistEntry,
} from '@lynlens/core';
import { ExportDialog } from './ExportDialog';
import { PackagingSubtitleOverlay } from './components/PackagingSubtitleOverlay';
import { PackagingMicroEditor } from './components/PackagingMicroEditor';
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
  /** lynlens-media URL for the <video> element. */
  videoUrl: string;
  /** Variant↔source time mapping for the subtitle overlay. */
  playlist: PreviewPlaylistEntry[];
  /** Total duration of the preview (variant total OR full source). */
  durationSeconds: number;
}

export function PackagingPanel({ effectiveDuration }: Props): JSX.Element {
  const projectId = useStore((s) => s.projectId);
  const sourceVideoUrl = useStore((s) => s.videoUrl);
  const videoMeta = useStore((s) => s.videoMeta);
  const transcript = useStore((s) => s.transcript);

  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(ROOT_KEY);
  const [plan, setPlan] = useState<PackagingPlan | null>(null);
  const [generating, setGenerating] = useState(false);
  const [vibe, setVibe] = useState<PackagingVibe>('default');
  const [showMicroEditor, setShowMicroEditor] = useState(false);
  /**
   * Snapshot of the export target at the moment the user clicked
   * 🎬 导出成品. We freeze (variantId, title, defaultPath) here instead
   * of reading the live selection so switching variants mid-export
   * doesn't a) change the dialog filename, b) confuse which variant
   * the export is actually for, or c) silently send a different
   * variantId to the IPC than what the title says.
   *
   * null → dialog closed. Set on button click, cleared on close /
   * after-export-finishes.
   */
  type ExportTarget = {
    variantId: string | null;
    title: string;
    defaultPath: string;
  };
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  /** Live export progress (from engine events) — drives banner + button lock. */
  const exportState = useStore((s) => s.export);

  // Preview render state.
  const [preview, setPreview] = useState<PreviewState | null>(null);
  /** Loading state while ffmpeg renders a fresh preview. */
  const [preparingPreview, setPreparingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /** Live playhead in PREVIEW seconds — drives the subtitle overlay. */
  const [currentTimeSec, setCurrentTimeSec] = useState(0);
  /** Whether the <video> is currently playing — drives ▶/⏸ icon. */
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * Wrap-div ref + size — the wrap has aspectRatio matching the source
   * video so it letterboxes the same way as the video element. Subtitle
   * overlay reads displayHeight to scale font sizes.
   */
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

  /**
   * Prepare the preview mp4 whenever variant selection changes. For 整片
   * the IPC just returns the source path so this is fast (no render).
   * For a variant, first call may take a few seconds (hardware-encoded
   * trim + concat); subsequent calls are instant (cache hit).
   */
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
        // Reset playhead to start. Don't seek the <video> directly —
        // src will change and trigger a fresh load.
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

  /**
   * Drive currentTimeSec smoothly via rAF while playing. The native
   * `timeupdate` event fires only ~4Hz which makes the scrubber jerky;
   * rAF gives us 60Hz and a responsive scrub bar.
   */
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

  /** Custom play/pause toggle. */
  async function togglePlay(): Promise<void> {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // Restart from beginning if we're at the end.
      if (preview && v.currentTime >= preview.durationSeconds - 0.05) {
        v.currentTime = 0;
      }
      try {
        await v.play();
      } catch {
        /* user-gesture failures / autoplay blocks — ignore */
      }
    } else {
      v.pause();
    }
  }

  /** Scrubber drag handler. value is preview/variant seconds. */
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

  // Segment labels for the microeditor: idx + text.
  const segmentLabels = transcript.segments.map((t, i) => ({
    idx: i,
    text: t.text,
  }));

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
        <label style={{ fontSize: 12, color: 'var(--text2)', display: 'flex', alignItems: 'center', gap: 6 }}>
          风格
          <select
            value={vibe}
            onChange={(e) => setVibe(e.target.value as PackagingVibe)}
            disabled={generating}
          >
            <option value="default">通用</option>
            <option value="energetic">高能</option>
            <option value="calm">冷静</option>
          </select>
        </label>
        <button
          className="primary"
          onClick={async () => {
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
          }}
          disabled={generating}
          title="AI 看字幕,自动决定每段字幕样式 + 关键词花字"
        >
          {generating ? '✨ 包装中...' : plan ? '✨ 重新包装' : '✨ 一键包装'}
        </button>
        {plan && (
          <>
            <button
              onClick={() => setShowMicroEditor(true)}
              title="改字幕颜色 / 关键词花字"
            >
              ⚙ 微调
            </button>
            <button
              className="primary"
              onClick={() => {
                // Snapshot the target NOW so switching variants while
                // the dialog is open / encoding runs can't change what
                // gets exported.
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
        {/* Source selector — pick "整片" or any variant as the AI's
            packaging target. Selecting also (re)renders the preview mp4. */}
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

        {/* Export-in-progress banner. Stays visible across variant
            switches so the user is never confused about which target
            the encoder is working on. Disappears the moment ffmpeg
            finishes (engine.bus emits export.completed → store clears
            export.active). */}
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

        {/* Preview area. Video src is the PRE-RENDERED variant mp4 (or
            source mp4 for 整片). currentTime here is variant-time (the
            preview mp4's own timeline), so the scrubber doesn't lie and
            there's no seek-flicker between segments. */}
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

          {/* Loading overlay — AI generation. */}
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

          {/* Loading overlay — preview render (variants only; 整片 returns
              instantly so this doesn't flash). */}
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

        {/* Custom variant-time playbar. video.currentTime IS variant time
            now (preview mp4 already contains only the variant), so the
            scrubber maps 1:1 — no source↔variant math here. */}
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

        {!plan && !generating && (
          <div
            style={{
              padding: '8px 12px',
              fontSize: 11,
              color: 'var(--text3)',
              textAlign: 'center',
            }}
          >
            选好「{selectedVariant?.title ?? '整片'}」后,点上方「✨ 一键包装」让 AI 设计字幕花字。
            生成后视频上的字幕会换样式,你可以播放看效果。
          </div>
        )}
      </div>

      {/* Micro-edit panel (v0.5: per-segment subtitle color + zoom slider,
          zoom is no-op for now but kept in schema for v0.6). */}
      {showMicroEditor && plan && (
        <PackagingMicroEditor
          plan={plan}
          segmentLabels={segmentLabels}
          onCancel={() => setShowMicroEditor(false)}
          onSave={async (next) => {
            try {
              await window.lynlens.setPackagingPlan(projectId, next);
              setPlan(next);
              setShowMicroEditor(false);
            } catch (err) {
              alert(`保存失败: ${(err as Error).message}`);
            }
          }}
        />
      )}

      {/* Final export with花字 burned in. The dialog is bound to the
          SNAPSHOTTED export target (captured when the button was
          clicked) — switching variants now won't change the export.
          The user can still browse other variants while the encode
          runs; the export-in-progress banner above keeps them oriented. */}
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
