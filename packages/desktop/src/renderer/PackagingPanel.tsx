/**
 * 包装 tab — AI-driven 一键包装 (v0.5 MVP, scope: subtitle 花字 only).
 *
 * **Deliberately minimal**: the user explicitly said "不要做那么多效果先",
 * so this tab does ONE thing — render the user's video with a styled
 * subtitle overlay (per-segment color + per-word highlight). No camera
 * zoom. No transitions. No Remotion player. No export pipeline. Those
 * land in v0.6+ once the simple version is solid.
 *
 * Architecture:
 *   - Native `<video>` element (same as precision tab's MediaPlayer)
 *     plays the source via `lynlens-media://` protocol.
 *   - `PackagingSubtitleOverlay` reads `video.currentTime` and renders
 *     the right subtitle styled by the PackagingPlan.
 *   - **Custom playbar** (NOT native controls) — when a variant is
 *     selected, the visible timeline is the VARIANT timeline (e.g. 0 to
 *     172s for SLAPP), not the source timeline (0 to 12:10). Otherwise
 *     users see source duration and think the variant selector didn't
 *     work. Source ↔ variant time is mapped via a pre-computed playlist.
 *   - During playback we detect when the source playhead crosses a
 *     variant segment's end → seek to the next segment's start. End of
 *     last → pause. This makes the variant play as a continuous reel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  HighlightVariant,
  PackagingPlan,
  PackagingVibe,
} from '@lynlens/core';
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

/**
 * One playlist entry maps a source-time range to a variant-time range.
 * Variant time is the "concatenated" timeline the user sees — e.g.
 * variant segments [60..66] + [120..125] become variant time [0..6] +
 * [6..11], total 11s, even though source spans 65s of real video.
 */
interface PlaylistEntry {
  srcStart: number;
  srcEnd: number;
  variantStart: number;
  variantEnd: number;
}

export function PackagingPanel({ effectiveDuration }: Props): JSX.Element {
  const projectId = useStore((s) => s.projectId);
  const videoUrl = useStore((s) => s.videoUrl);
  const videoMeta = useStore((s) => s.videoMeta);
  const transcript = useStore((s) => s.transcript);

  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>(ROOT_KEY);
  const [plan, setPlan] = useState<PackagingPlan | null>(null);
  const [generating, setGenerating] = useState(false);
  const [vibe, setVibe] = useState<PackagingVibe>('default');
  const [showMicroEditor, setShowMicroEditor] = useState(false);
  /** Live playhead in source seconds — drives the subtitle overlay. */
  const [currentSrcTime, setCurrentSrcTime] = useState(0);
  /** Whether the <video> element is currently playing — drives ▶/⏸ icon. */
  const [isPlaying, setIsPlaying] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * Wrap-div ref + size — the wrap has aspectRatio matching the source
   * video so it letterboxes the same way as the video element. We
   * measure its rendered size so PackagingSubtitleOverlay can scale
   * font sizes proportionally (AI returns sizes calibrated for source
   * resolution; we rescale to the actual displayed pixels).
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

  /**
   * Build the playlist (source↔variant time mapping). For a variant,
   * one entry per variant segment; for 整片 mode, one virtual entry
   * spanning the whole source. The mapping is what lets us show
   * variant-time (0 / 2:52) in the scrubber instead of misleading
   * source-time (1:06 / 12:10).
   */
  const playlist = useMemo<PlaylistEntry[]>(() => {
    if (selectedVariant && selectedVariant.segments.length > 0) {
      let acc = 0;
      return selectedVariant.segments.map((s) => {
        const dur = Math.max(0, s.end - s.start);
        const entry: PlaylistEntry = {
          srcStart: s.start,
          srcEnd: s.end,
          variantStart: acc,
          variantEnd: acc + dur,
        };
        acc += dur;
        return entry;
      });
    }
    if (videoMeta) {
      return [
        {
          srcStart: 0,
          srcEnd: videoMeta.duration,
          variantStart: 0,
          variantEnd: videoMeta.duration,
        },
      ];
    }
    return [];
  }, [selectedVariant, videoMeta]);

  const totalVariantDuration =
    playlist.length > 0 ? playlist[playlist.length - 1].variantEnd : 0;

  /** Map source seconds → variant seconds. null = src is between ranges. */
  function srcToVariant(srcSec: number): number | null {
    for (const e of playlist) {
      if (srcSec >= e.srcStart && srcSec < e.srcEnd) {
        return e.variantStart + (srcSec - e.srcStart);
      }
    }
    return null;
  }

  /** Map variant seconds → source seconds + playlist index. */
  function variantToSrc(varSec: number): { src: number; idx: number } {
    if (playlist.length === 0) return { src: 0, idx: -1 };
    for (let i = 0; i < playlist.length; i++) {
      const e = playlist[i];
      if (varSec >= e.variantStart && varSec < e.variantEnd) {
        return { src: e.srcStart + (varSec - e.variantStart), idx: i };
      }
    }
    const last = playlist[playlist.length - 1];
    return { src: last.srcEnd, idx: playlist.length - 1 };
  }

  /** Which playlist segment is currently playing (for jump logic). */
  const playingIdxRef = useRef(0);
  /**
   * When selectedKey changes BEFORE the video is loaded, store the seek
   * target here. The loadedmetadata handler reads + clears it once the
   * video is actually ready to seek (setting currentTime before metadata
   * loads is silently ignored — that was the root cause of "stuck at
   * 1:06": the seek to segments[0].start never happened and the user
   * pressed play from 0, which then snap-forwarded weirdly).
   */
  const pendingSeekRef = useRef<number | null>(null);

  /**
   * When user picks a variant: reset playback to its first segment.
   * Always uses pendingSeekRef so it works whether the video is ready
   * yet or not (the loadedmetadata handler applies pending seeks).
   */
  useEffect(() => {
    playingIdxRef.current = 0;
    if (playlist.length === 0) return;
    const target = playlist[0].srcStart;
    pendingSeekRef.current = target;
    const v = videoRef.current;
    if (v && v.readyState >= 1 && Number.isFinite(v.duration)) {
      try {
        v.currentTime = target;
        pendingSeekRef.current = null;
        setCurrentSrcTime(target);
      } catch {
        /* will retry on loadedmetadata */
      }
    }
  }, [selectedKey, playlist]);

  /**
   * Drive currentSrcTime smoothly via rAF while playing. The native
   * `timeupdate` event fires only ~4Hz which makes the scrubber jerky;
   * rAF gives us 60Hz and a responsive scrub bar. We still use
   * timeupdate for the segment-jump logic (cheaper, fires often enough).
   */
  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = (): void => {
      const v = videoRef.current;
      if (v && !v.paused) {
        setCurrentSrcTime(v.currentTime);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  /**
   * Segment-jump logic — runs on timeupdate. When the source playhead
   * crosses the current segment's end, jump to the next segment's
   * start. End of last segment: pause. Only meaningful when a variant
   * is selected (整片 has one segment that covers everything, so this
   * is a no-op there).
   */
  function handleTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>): void {
    const v = e.currentTarget;
    const cur = v.currentTime;
    setCurrentSrcTime(cur);
    if (!selectedVariant || playlist.length === 0) return;
    const idx = playingIdxRef.current;
    const seg = playlist[idx];
    if (!seg) return;
    if (cur >= seg.srcEnd - 0.02) {
      const nextIdx = idx + 1;
      if (nextIdx < playlist.length) {
        playingIdxRef.current = nextIdx;
        try {
          v.currentTime = playlist[nextIdx].srcStart;
        } catch {
          /* ignore */
        }
      } else {
        v.pause();
      }
    }
  }

  /**
   * Initial seek when metadata becomes available (handles the race
   * where useEffect fires before the video has loaded enough to accept
   * a currentTime write).
   */
  function handleLoadedMetadata(e: React.SyntheticEvent<HTMLVideoElement>): void {
    const v = e.currentTarget;
    const pending = pendingSeekRef.current;
    if (pending !== null && Number.isFinite(pending)) {
      try {
        v.currentTime = pending;
        setCurrentSrcTime(pending);
      } catch {
        /* defensive — shouldn't happen with valid number */
      }
      pendingSeekRef.current = null;
    }
  }

  /** Custom play/pause toggle — variant scrubber uses this. */
  async function togglePlay(): Promise<void> {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      // If at end of variant, restart from beginning.
      if (selectedVariant && playingIdxRef.current >= playlist.length - 1) {
        const lastSeg = playlist[playlist.length - 1];
        if (v.currentTime >= lastSeg.srcEnd - 0.05) {
          playingIdxRef.current = 0;
          v.currentTime = playlist[0].srcStart;
        }
      }
      try {
        await v.play();
      } catch {
        /* user-gesture failures, autoplay blocks — ignore */
      }
    } else {
      v.pause();
    }
  }

  /** Variant-time scrubber drag handler. */
  function onScrubChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const varSec = Number(e.target.value);
    const { src, idx } = variantToSrc(varSec);
    const v = videoRef.current;
    if (!v) return;
    playingIdxRef.current = idx;
    try {
      v.currentTime = src;
      setCurrentSrcTime(src);
    } catch {
      /* defensive */
    }
  }

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

  // Current variant-time for the scrubber. If src is between ranges
  // (e.g. mid-seek), fall back to the playing segment's variantStart.
  const variantTimeFromSrc = srcToVariant(currentSrcTime);
  const currentVariantTime =
    variantTimeFromSrc !== null
      ? variantTimeFromSrc
      : playlist[playingIdxRef.current]?.variantStart ?? 0;

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
            packaging target. Selecting a variant also restricts playback
            (custom playbar shows variant duration, segment-jumping skips
            the source gaps). */}
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

        {/* Variant context label — confirms playback is restricted to
            this variant only. */}
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
            🎬 正在播放变体「{selectedVariant.title}」 ·{' '}
            {selectedVariant.segments.length} 段 ·{' '}
            {formatTime(selectedVariant.durationSeconds)} · 跳过变体外的内容
          </div>
        )}

        {/* Preview area — native <video> (lynlens-media:// protocol) with
            HTML subtitle overlay. Native controls intentionally HIDDEN —
            they show source duration (12:10), which is misleading when
            playing a variant (172s). Our custom playbar below uses
            variant-time. */}
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
          {videoUrl && videoMeta ? (
            // Aspect-ratio wrap so subtitles position against the actual
            // visible video frame (not the surrounding letterbox area).
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
                src={videoUrl}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
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
                currentTimeSec={currentSrcTime}
                orientation={orientation}
                sourceHeight={videoMeta.height}
                displayHeight={wrapSize.h}
              />
            </div>
          ) : (
            <div style={{ color: 'var(--text3)' }}>视频未加载</div>
          )}

          {/* Loading overlay — always on top while AI is generating. */}
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
        </div>

        {/* Custom variant-time playbar. Replaces native controls so the
            timeline reads 0:00 / 2:52 (variant) not 1:06 / 12:10
            (source). Scrubbing maps variant-time → source-time and
            updates the playing-segment index. */}
        {videoUrl && videoMeta && (
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
              style={{
                width: 36,
                height: 36,
                borderRadius: 18,
                border: 'none',
                background: 'var(--accent)',
                color: '#fff',
                fontSize: 14,
                cursor: 'pointer',
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
              {formatTime(currentVariantTime)} / {formatTime(totalVariantDuration)}
            </span>
            <input
              type="range"
              min={0}
              max={totalVariantDuration || 0.0001}
              step={0.01}
              value={Math.min(currentVariantTime, totalVariantDuration)}
              onChange={onScrubChange}
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
    </div>
  );
}
