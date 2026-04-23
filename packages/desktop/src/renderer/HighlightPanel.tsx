import { useEffect, useState } from 'react';
import type { HighlightStyle, HighlightVariant } from '@lynlens/core';
import { GenerateHighlightDialog } from './GenerateHighlightDialog';
import { VariantCard } from './VariantCard';
import { useStore } from './store';
import { formatTime } from './util';

interface Props {
  effectiveDuration: number;
  videoPath: string | null;
}

/**
 * The 高光 tab's main surface. Replaces the entire 粗剪 layout (player +
 * timeline + sidebar) when active. All variants are ephemeral — they're
 * fetched from main on mount, regenerated on demand, cleared when the
 * user switches back to 粗剪.
 */
export function HighlightPanel({ effectiveDuration, videoPath }: Props) {
  const projectId = useStore((s) => s.projectId);
  const transcript = useStore((s) => s.transcript);
  const [variants, setVariants] = useState<HighlightVariant[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate on tab entry — variants live in main-process memory, so we
  // always ask for the current list rather than trusting local state.
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

  async function handleGenerate(opts: {
    style: HighlightStyle;
    count: number;
    targetSeconds: number;
  }): Promise<void> {
    if (!projectId) return;
    setShowDialog(false);
    setGenerating(true);
    setError(null);
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

      {variants.length === 0 && !generating && (
        <div className="highlight-empty" style={{ marginTop: 40 }}>
          <div className="hint">
            还没有生成变体。点右上角「生成变体」让 Claude 读字幕挑段子。
            <br />
            生成的变体只在本次会话有效,切回粗剪 tab 会清空。
          </div>
        </div>
      )}

      {generating && (
        <div className="highlight-empty" style={{ marginTop: 40 }}>
          <div className="hint">
            Claude 正在读字幕并挑段... 通常 10-30 秒。
          </div>
        </div>
      )}

      <div className="variant-list">
        {variants.map((v, i) => (
          <VariantCard
            key={v.id}
            variant={v}
            index={i + 1}
            onExport={handleExport}
          />
        ))}
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
