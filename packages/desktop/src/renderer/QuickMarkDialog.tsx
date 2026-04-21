import { useState } from 'react';

interface Props {
  hasTranscript: boolean;
  onCancel: () => void;
  onConfirm: (opts: { minPauseSec: number; silenceThreshold: number }) => void;
}

/**
 * Before running the silence-based auto-marker, let the user pick how
 * aggressive the cut should be. Shorter minPauseSec = removes more; longer =
 * only cuts obvious dead air. A fine-grained slider is the most intuitive way
 * to dial this in without forcing users to type numbers.
 */
export function QuickMarkDialog({ hasTranscript, onCancel, onConfirm }: Props) {
  const [minPause, setMinPause] = useState(1.0);
  const [threshold, setThreshold] = useState(0.03);
  const [advanced, setAdvanced] = useState(false);

  // Presets for quick selection
  const presets: Array<{ label: string; value: number; hint: string }> = [
    { label: '非常严格', value: 0.3, hint: '删掉所有 >0.3 秒的停顿 (节奏紧凑)' },
    { label: '严格', value: 0.6, hint: '删掉明显的停顿' },
    { label: '温和', value: 1.0, hint: '只删掉长停顿 (推荐)' },
    { label: '保守', value: 2.0, hint: '只删掉非常明显的空白' },
  ];

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ minWidth: 460 }}>
        <h3>⚡ 快速标记</h3>
        <div className="quick-desc">
          自动标出停顿段,你稍后可审核再决定是否真删。
          {hasTranscript
            ? '已有字幕,还会额外识别语气词和重复段。'
            : '先点 🎤 生成字幕 后,还能额外识别语气词和重复段。'}
        </div>

        <div className="quick-row">
          <label className="quick-label">
            最短停顿阈值
            <span className="quick-value">≥ {minPause.toFixed(1)} 秒</span>
          </label>
          <input
            type="range"
            min="0.3"
            max="3.0"
            step="0.1"
            value={minPause}
            onChange={(e) => setMinPause(Number(e.target.value))}
            className="quick-slider"
          />
          <div className="quick-scale">
            <span>0.3s</span>
            <span>1.0s</span>
            <span>2.0s</span>
            <span>3.0s</span>
          </div>
        </div>

        <div className="quick-presets">
          {presets.map((p) => (
            <button
              key={p.value}
              className={`quick-preset ${Math.abs(minPause - p.value) < 0.05 ? 'active' : ''}`}
              onClick={() => setMinPause(p.value)}
              title={p.hint}
            >
              {p.label}
              <span className="quick-preset-sec">≥{p.value}s</span>
            </button>
          ))}
        </div>

        <div className="quick-advanced">
          <button className="quick-adv-toggle" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '▾' : '▸'} 进阶:音量阈值
          </button>
          {advanced && (
            <div className="quick-row" style={{ marginTop: 8 }}>
              <label className="quick-label">
                低于此音量视为静音
                <span className="quick-value">{threshold.toFixed(3)}</span>
              </label>
              <input
                type="range"
                min="0.005"
                max="0.1"
                step="0.005"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="quick-slider"
              />
              <div className="quick-hint">
                数字越大 = 把更多"小声"也当静音。默认 0.03 适合大多数人声录音。
              </div>
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() => onConfirm({ minPauseSec: minPause, silenceThreshold: threshold })}
          >
            开始分析
          </button>
        </div>
      </div>
    </div>
  );
}
