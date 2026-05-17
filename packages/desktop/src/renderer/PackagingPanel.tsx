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

        {/* Preview area — native <video> (same path the precision tab
            uses, lynlens-media:// protocol) with HTML subtitle overlay
            on top. The video player is the user's standard playback;
            the overlay reads currentTime + plan to render styled
            subtitle. No Remotion, no canvas, no fancy sync. */}
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
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={videoUrl}
                controls
                onTimeUpdate={(e) =>
                  setCurrentTimeSec(
                    (e.currentTarget as HTMLVideoElement).currentTime
                  )
                }
                onSeeked={(e) =>
                  setCurrentTimeSec(
                    (e.currentTarget as HTMLVideoElement).currentTime
                  )
                }
                style={{
                  maxWidth: '100%',
                  maxHeight: '100%',
                  display: 'block',
                }}
              />
              <PackagingSubtitleOverlay
                transcript={transcript}
                plan={plan}
                currentTimeSec={currentTimeSec}
                orientation={orientation}
              />
            </>
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
