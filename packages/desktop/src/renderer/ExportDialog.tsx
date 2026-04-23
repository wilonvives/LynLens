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
  // Default to stream-copy: LynLens is a source-preserving tool. The kept
  // video bytes should come out of the export byte-for-byte identical to
  // the original file — same codec, same bitrate, same color, same
  // rotation metadata. The user can opt in to re-encode only if they need
  // frame-accurate cuts.
  const [mode, setMode] = useState<ExportMode>('fast');
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
          <label>导出模式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as ExportMode)}>
            <option value="fast">原样导出 (不转码,推荐)</option>
            <option value="precise">帧精度 (会重新编码)</option>
          </select>
          <div style={{ fontSize: 11, color: '#888', marginTop: 4, lineHeight: 1.5 }}>
            {mode === 'fast'
              ? '保留段用 -c copy 直接拷贝,画质/编码/元数据与原片完全一致。切点落在最近关键帧,误差通常 <1 秒。'
              : '每一帧都重新编码以获得精确切点。画质会有损耗,文件大小/编码参数与原片不同。'}
          </div>
        </div>
        {mode === 'precise' && (
          <div className="dialog-row">
            <label>视频质量</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as ExportQuality)}
            >
              <option value="original">原画 (CRF 16)</option>
              <option value="high">高 (CRF 18)</option>
              <option value="medium">中 (CRF 23)</option>
              <option value="low">低 (CRF 28)</option>
            </select>
          </div>
        )}

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
