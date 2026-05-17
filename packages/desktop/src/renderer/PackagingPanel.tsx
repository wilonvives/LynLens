/**
 * 包装 tab — AI-driven 一键包装.
 *
 * Standalone tab (sibling of 粗剪 / 高光 / 文案). Reads the current
 * project's variants from the store and lets the user:
 *   1. Pick a variant to package (or "整片" for the whole rippled output)
 *   2. Click ✨ 一键包装 → Claude generates a PackagingPlan in ~10s
 *   3. Watch the result in the Remotion Player (WYSIWYG with export)
 *   4. ⚙ 微调 to tweak subtitle color / zoom per segment
 *   5. Export the packaged MP4
 *
 * Independent from HighlightPanel — clicking variants in 高光 doesn't
 * navigate here. User comes to 包装 explicitly when they want to
 * decorate their cuts. Selection state is local to this panel.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  HighlightVariant,
  PackagingPlan,
  PackagingVibe,
} from '@lynlens/core';
import { ExportDialog } from './ExportDialog';
import { PackagingPreview } from './remotion/PackagingPreview';
import { PackagingMicroEditor } from './components/PackagingMicroEditor';
import { useStore } from './store';
import { formatTime } from './util';

interface Props {
  /** Effective duration of the rippled video (post-cut total seconds). */
  effectiveDuration: number;
  videoPath: string | null;
}

/** Sentinel = "整片" (whole rippled output), distinct from any variant id. */
const ROOT_KEY = '__root__';

export function PackagingPanel({ effectiveDuration, videoPath }: Props): JSX.Element {
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
  const [exporting, setExporting] = useState(false);

  const selectedVariantId = selectedKey === ROOT_KEY ? null : selectedKey;
  const selectedVariant = useMemo(
    () => variants.find((v) => v.id === selectedKey),
    [variants, selectedKey]
  );

  // Hydrate variants (so user can pick which one to package).
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
          一键包装基于字幕内容来决定每段的样式 + 画面动作。回到「粗剪」tab 点「字幕转录」后再来。
        </div>
      </div>
    );
  }

  // Compute the source-time segments + text for preview / export.
  // CRITICAL: each entry is ONE transcript line (single subtitle), not
  // a variant chunk. Previously I joined all lines inside a variant chunk
  // into one segment which made every sentence in the chunk appear at
  // once on screen (visible bug: all 8 subtitles stacked vertically).
  // `segmentIdx` is the ORIGINAL transcript index — matches what AI
  // saw + what PackagingPlan recipes reference.
  const previewSegments = (() => {
    if (selectedVariant) {
      // Variant: include transcript lines whose source-time falls inside
      // ANY variant segment. Preserves transcript-line cadence for
      // subtitles; camera zoom switches per-line based on plan.
      const lines: Array<{
        start: number;
        end: number;
        text: string;
        segmentIdx: number;
      }> = [];
      transcript.segments.forEach((t, i) => {
        for (const v of selectedVariant.segments) {
          if (t.start >= v.start && t.end <= v.end) {
            lines.push({
              start: t.start,
              end: t.end,
              text: t.text,
              segmentIdx: i,
            });
            break;
          }
        }
      });
      return lines;
    }
    // ROOT: use every transcript line as its own segment.
    return transcript.segments.map((t, i) => ({
      start: t.start,
      end: t.end,
      text: t.text,
      segmentIdx: i,
    }));
  })();

  // For the microeditor's segment labels.
  const segmentLabels = (() => {
    if (selectedVariant) {
      return selectedVariant.segments.map((s, i) => {
        const inside = transcript.segments.filter(
          (t) => t.start >= s.start && t.end <= s.end
        );
        return { idx: i, text: inside.map((t) => t.text).join(' ') };
      });
    }
    return transcript.segments.map((t, i) => ({ idx: i, text: t.text }));
  })();

  return (
    <div className="highlight-panel">
      <div className="highlight-panel-header">
        <div>
          <div className="highlight-panel-title">一键包装</div>
          <div className="highlight-panel-sub">
            AI 看字幕,自动加字幕样式 + 画面 zoom · 基于{' '}
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
          title="AI 看字幕,自动决定每段字幕样式 + 画面 zoom"
        >
          {generating ? '✨ 包装中...' : plan ? '✨ 重新包装' : '✨ 一键包装'}
        </button>
        {plan && (
          <>
            <button
              onClick={() => setShowMicroEditor(true)}
              title="改字幕颜色 / zoom 倍数 / 关键词高亮"
            >
              ⚙ 微调
            </button>
            <button
              onClick={async () => {
                if (!confirm('清除当前的包装方案?导出会回到原片样式。')) return;
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
            <button
              onClick={() => {
                if (!selectedVariant) {
                  alert('整片包装的导出 v0.5 暂不支持,请先在高光 tab 选/建一个变体再包装。');
                  return;
                }
                setExporting(true);
              }}
              title="导出包装后视频"
            >
              📤 导出
            </button>
          </>
        )}
      </div>

      <div className="highlight-body" style={{ flexDirection: 'column', gap: 12 }}>
        {/* Source selector — pick "整片" or any variant. */}
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

        {/* Preview area — Remotion Player when plan exists, else hint.
            Loading overlay shows on TOP of whatever is there (player or
            hint) so the user never wonders "is it still working?". */}
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
          {videoUrl && videoMeta && plan ? (
            <PackagingPreview
              // Pass the lynlens-media:// URL AS-IS — the app's custom
              // protocol handler is registered in the Electron main and
              // the BrowserWindow has access to it. Stripping the protocol
              // (as we did previously) broke video loading entirely.
              videoPath={videoUrl}
              segments={previewSegments}
              plan={plan}
              width={videoMeta.width}
              height={videoMeta.height}
              fps={videoMeta.fps}
            />
          ) : !generating ? (
            <div style={{ textAlign: 'center', color: 'var(--text3)', padding: 40 }}>
              <div style={{ fontSize: 14 }}>
                选好「{selectedVariant?.title ?? '整片'}」后,点上方「✨ 一键包装」开始
              </div>
              <div style={{ fontSize: 11, marginTop: 6 }}>
                AI 会自动决定每段字幕样式 + 画面什么时候 zoom
              </div>
            </div>
          ) : null}

          {/* Loading overlay — always on top while generating, with a
              visible spinner so the user knows AI is working. */}
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
                ✨ AI 正在设计包装方案
              </div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>
                看完{transcript.segments.length} 段字幕,挑关键词 + 决定 zoom...通常 5-15 秒
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Micro-edit panel — v0.5 minimal (subtitle color + zoom). */}
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

      {/* Export — variant only for v0.5 (root-export needs different
          IPC contract; deferred to v0.6). */}
      {exporting && selectedVariant && (
        <ExportDialog
          title={`导出包装后视频 — ${selectedVariant.title}`}
          defaultPath={(() => {
            const srcBase = videoPath?.split(/[\\/]/).pop() ?? 'output.mp4';
            return (
              srcBase.replace(/\.[^.]+$/, '') +
              `_包装_${selectedVariant.title}.mp4`
            );
          })()}
          onClose={() => setExporting(false)}
          onConfirm={(args) => {
            void window.lynlens
              .exportHighlight(
                projectId,
                selectedVariant.id,
                args.outputPath,
                args.mode === 'precise' ? 'precise' : 'precise',
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
                setExporting(false);
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
