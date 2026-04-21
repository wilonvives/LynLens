import { useState } from 'react';
import type { ExportMode, ExportQuality } from '@lynlens/core';
import { useStore } from './store';

interface Props {
  defaultPath: string;
  onClose: () => void;
  onConfirm: (args: { outputPath: string; mode: ExportMode; quality: ExportQuality }) => void;
}

export function ExportDialog({ defaultPath, onClose, onConfirm }: Props) {
  const [outputPath, setOutputPath] = useState(defaultPath);
  const [mode, setMode] = useState<ExportMode>('precise');
  const [quality, setQuality] = useState<ExportQuality>('high');
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
          <label>导出模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as ExportMode)}>
            <option value="precise">精确模式(重新编码,帧精度)</option>
            <option value="fast">快速模式(流拷贝,关键帧精度)</option>
          </select>
        </div>
        <div className="dialog-row">
          <label>视频质量</label>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as ExportQuality)}
            disabled={mode === 'fast'}
          >
            <option value="original">原画 (CRF 16)</option>
            <option value="high">高 (CRF 18)</option>
            <option value="medium">中 (CRF 23)</option>
            <option value="low">低 (CRF 28)</option>
          </select>
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
              <button className="primary" onClick={() => onConfirm({ outputPath, mode, quality })}>
                开始导出
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
