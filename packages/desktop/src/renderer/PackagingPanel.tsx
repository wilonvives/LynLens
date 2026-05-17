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
 *   - `PackagingSubtitleOverlay` reads `video.currentTime` (via the
 *     onTimeUpdate handler) and renders the right subtitle styled by
 *     the PackagingPlan.
 *   - AI generation, plan persistence, microedit panel all kept from
 *     the previous iteration (those work fine).
 *
 * Variant selection still works as the unit Claude packages, but for
 * v0.5 preview the player just plays the WHOLE source video — the
 * variant boundaries don't gate playback. The AI plan only describes
 * the transcript segments inside the variant, so subtitles in OTHER
 * parts of the video render with defaults. Variant-only playback can
 * land in v0.6 once we have segment-jump logic abstracted out.
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
  const [currentTimeSec, setCurrentTimeSec] = useState(0);

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

  // Variant playback state: when user picks a variant we play ONLY
  // that variant's segments back-to-back (jumping past the gaps in the
  // source video). Ref instead of state so the time-update handler
  // doesn't churn re-renders 4x/second.
  const playingSegIdxRef = useRef(0);

  // When user picks a variant: seek to its first segment + reset
  // playing-segment index so jump logic starts fresh. When user picks
  // 整片: leave currentTime alone (user might be mid-watch).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (selectedVariant && selectedVariant.segments.length > 0) {
      v.currentTime = selectedVariant.segments[0].start;
      playingSegIdxRef.current = 0;
    }
  }, [selectedKey, selectedVariant]);

  // Time-update handler: also implements variant-segment jumping so
  // the SLAPP variant plays as a continuous 172s reel instead of the
  // raw 12:10 source. When playhead crosses the current segment's
  // end → seek to the next segment's start. End of last segment →
  // pause. Outside the current segment (user scrubbed back) → snap
  // forward to keep playback inside the variant.
  function handleTimeUpdate(e: React.SyntheticEvent<HTMLVideoElement>): void {
    const v = e.currentTarget;
    const cur = v.currentTime;
    setCurrentTimeSec(cur);
    if (!selectedVariant || selectedVariant.segments.length === 0) return;
    const idx = playingSegIdxRef.current;
    const seg = selectedVariant.segments[idx];
    if (!seg) return;
    if (cur >= seg.end - 0.02) {
      const nextIdx = idx + 1;
      if (nextIdx < selectedVariant.segments.length) {
        playingSegIdxRef.current = nextIdx;
        v.currentTime = selectedVariant.segments[nextIdx].start;
      } else {
        v.pause();
      }
    } else if (cur < seg.start - 0.1) {
      v.currentTime = seg.start;
    }
  }

  // User scrubbed manually — re-establish which variant segment they
  // landed in so subsequent time updates know where to jump from.
  // Outside any segment: snap to the nearest segment start.
  function handleSeeked(e: React.SyntheticEvent<HTMLVideoElement>): void {
    const v = e.currentTarget;
    setCurrentTimeSec(v.currentTime);
    if (!selectedVariant) return;
    const cur = v.currentTime;
    for (let i = 0; i < selectedVariant.segments.length; i++) {
      const s = selectedVariant.segments[i];
      if (cur >= s.start && cur < s.end) {
        playingSegIdxRef.current = i;
        return;
      }
    }
    let bestIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < selectedVariant.segments.length; i++) {
      const s = selectedVariant.segments[i];
      const delta = Math.abs(cur - s.start);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIdx = i;
      }
    }
    playingSegIdxRef.current = bestIdx;
    v.currentTime = selectedVariant.segments[bestIdx].start;
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
            packaging target. The video player itself always plays the
            full source for v0.5 (variant-only playback comes later). */}
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

        {/* Variant context label — tells the user that with a variant
            selected, playback is jumping between THAT variant's source
            ranges only (not the whole video). 整片 mode = no label. */}
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
            {selectedVariant.durationSeconds.toFixed(1)}s ·
            播放器会自动跳过变体外的内容
          </div>
        )}

        {/* Preview area — native <video> (same path the precision tab
            uses, lynlens-media:// protocol) with HTML subtitle overlay
            on top. Variant playback (segment-jumping) is handled by
            handleTimeUpdate; for 整片 it's just normal playback. */}
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
            // Aspect-ratio wrap — the wrap matches the source video's
            // ratio, so the OVERLAY is positioned relative to the
            // actual visible video frame (not the black letterbox area
            // of the surrounding container). Without this, subtitles
            // for a portrait video would render against the WHOLE
            // landscape player area and bleed past the video edges.
            <div
              ref={videoWrapRef}
              style={{
                position: 'relative',
                aspectRatio: `${videoMeta.width} / ${videoMeta.height}`,
                maxWidth: '100%',
                maxHeight: '100%',
                // Center any oversized content (defensive — the
                // aspect-ratio + maxWidth/maxHeight should size correctly).
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onTimeUpdate={handleTimeUpdate}
                onSeeked={handleSeeked}
                style={{
                  width: '100%',
                  height: '100%',
                  display: 'block',
                }}
              />
              <PackagingSubtitleOverlay
                transcript={transcript}
                plan={plan}
                currentTimeSec={currentTimeSec}
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
