import { useState } from 'react';
import type { ExportMode, ExportQuality } from '@lynlens/core';
import { useStore } from './store';

interface Props {
  defaultPath: string;
  onClose: () => void;
  onConfirm: (args: { outputPath: string; mode: ExportMode; quality: ExportQuality }) => void;
}

/**
 * Export is a single pipeline now: frame-accurate cuts + color metadata
 * preserved from the source. The old "原样导出 -c copy" option was removed
 * in v0.4.1 — it caused frame jumps at every cut (cuts could only land on
 * keyframes) and Windows players showed shifted color (concat demuxer
 * rewrote color tags). Both bugs together were unfixable inside the
 * stream-copy approach.
 *
 * The user only picks the quality (CRF). Default = "原画" (CRF 16) which
 * is visually transparent for SDR content. Mode is left at 'precise' under
 * the hood so the IPC contract stays stable.
 */
export function ExportDialog({ defaultPath, onClose, onConfirm }: Props) {
  const [outputPath, setOutputPath] = useState(defaultPath);
  const [quality, setQuality] = useState<ExportQuality>('original');
  const ex = useStore((s) => s.export);

  async function browse() {
    const base = outputPath.split(/[\\/]/).pop() ?? 'output.mp4';
    const p = await window.lynlens.saveDialog(base);
    if (p) setOutputPath(p);
  }

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog">
        <h3>导出视频</h3>
        <div className="dialog-row">
          <label>输出路径</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input value={outputPath} onChange={(e) => setOutputPath(e.target.value)} style={{ flex: 1 }} />
            <button onClick={browse}>浏览</button>
          </div>
        </div>
        <div className="dialog-row">
          <label>视频质量</label>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as ExportQuality)}
          >
            <option value="original">原画 (CRF 16) — 推荐</option>
            <option value="high">高 (CRF 18)</option>
            <option value="medium">中 (CRF 23)</option>
            <option value="low">低 (CRF 28)</option>
          </select>
          <div style={{ fontSize: 11, color: '#888', marginTop: 6, lineHeight: 1.5 }}>
            视频较长时请耐心等待。
          </div>
        </div>

        {ex.active && (
          <div style={{ marginTop: 16 }}>
            <div style={{ fontSize: 12, color: '#ccc', marginBottom: 4 }}>
              {ex.stage} — {ex.percent.toFixed(1)}%
            </div>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${ex.percent}%` }} />
            </div>
          </div>
        )}

        <div className="dialog-actions">
          {ex.active ? (
            <button onClick={onClose}>取消导出</button>
          ) : (
            <>
              <button onClick={onClose}>取消</button>
              <button
                className="primary"
                onClick={() => onConfirm({ outputPath, mode: 'precise', quality })}
              >
                开始导出
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
