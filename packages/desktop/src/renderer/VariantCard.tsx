import { useState } from 'react';
import type { HighlightVariant } from '@lynlens/core';
import { formatTime } from './util';

interface Props {
  variant: HighlightVariant;
  index: number;
  onExport: (variant: HighlightVariant) => Promise<void>;
}

const STYLE_LABEL: Record<HighlightVariant['style'], string> = {
  default: '默认',
  hero: '片头',
  'ai-choice': 'AI 自由',
};

/**
 * One-stop display for a highlight variant: title, total duration, style
 * badge, segment breakdown (start/end/reason per piece), and an export
 * button. The card is read-only by design — decision #4 says "能导出即可",
 * editing happens in the 粗剪 tab.
 */
export function VariantCard({ variant, index, onExport }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [exporting, setExporting] = useState(false);

  async function doExport(): Promise<void> {
    if (exporting) return;
    setExporting(true);
    try {
      await onExport(variant);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="variant-card">
      <div className="variant-card-head">
        <div className="variant-card-title-row">
          <span className="variant-card-index">#{index}</span>
          <span className="variant-card-title">{variant.title}</span>
          <span className="variant-card-style">{STYLE_LABEL[variant.style]}</span>
        </div>
        <div className="variant-card-meta">
          {variant.durationSeconds.toFixed(1)} 秒 · {variant.segments.length} 段
        </div>
      </div>

      <div className="variant-card-actions">
        <button onClick={() => setExpanded((v) => !v)}>
          {expanded ? '收起段落' : '查看段落'}
        </button>
        <button className="primary" onClick={doExport} disabled={exporting}>
          {exporting ? '导出中...' : '导出'}
        </button>
      </div>

      {expanded && (
        <div className="variant-card-segments">
          {variant.segments.map((s, i) => (
            <div key={i} className="variant-seg-row">
              <span className="variant-seg-idx">{i + 1}</span>
              <span className="variant-seg-time">
                {formatTime(s.start)} - {formatTime(s.end)}
              </span>
              <span className="variant-seg-dur">({(s.end - s.start).toFixed(1)}s)</span>
              {s.reason && <span className="variant-seg-reason">{s.reason}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
