import { useState } from 'react';

interface Props {
  hasTranscript: boolean;
  onCancel: () => void;
  onConfirm: (opts: {
    minPauseSec: number;
    sensitivity?: number;
    silenceThreshold?: number;
  }) => void;
}

/**
 * Before running the silence-based auto-marker, let the user pick how
 * aggressive the cut should be. Shorter minPauseSec = removes more; longer =
 * only cuts obvious dead air.
 *
 * The amplitude cut-line is ADAPTIVE by default — derived from the recording's
 * own noise floor and tuned by 环境音灵敏度. This is what makes it work on noisy
 * recordings (a fixed level missed every pause when there was room tone). The
 * old fixed-absolute slider is kept under 进阶 for power users who want to pin
 * an exact number.
 */
export function QuickMarkDialog({ hasTranscript, onCancel, onConfirm }: Props) {
  const [minPause, setMinPause] = useState(1.0);
  // 0..1 adaptive sensitivity (default 0.5). Higher = treat noisier pauses as
  // silence (mark more) — turn this up when a noisy recording finds nothing.
  const [sensitivity, setSensitivity] = useState(0.5);
  const [threshold, setThreshold] = useState(0.03);
  // When true, use the fixed-absolute threshold instead of the adaptive one.
  const [manualThreshold, setManualThreshold] = useState(false);
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
        <h3>快速标记</h3>
        <div className="quick-desc">
          自动标出停顿段,你稍后可审核再决定是否真删。
          {hasTranscript
            ? '已有字幕,还会额外识别语气词和重复段。'
            : '先点「生成字幕」后,还能额外识别语气词和重复段。'}
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

        {/* 环境音灵敏度 — the adaptive cut-line knob. Auto-measures this
            recording's noise floor; the slider just nudges how aggressively
            near-floor counts as silence. Disabled when manual override is on. */}
        <div className="quick-row" style={{ marginTop: 4, opacity: manualThreshold ? 0.4 : 1 }}>
          <label className="quick-label">
            环境音灵敏度
            <span className="quick-value">{Math.round(sensitivity * 100)}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={sensitivity}
            disabled={manualThreshold}
            onChange={(e) => setSensitivity(Number(e.target.value))}
            className="quick-slider"
          />
          <div className="quick-hint">
            自动按这段录音的底噪判断静音。环境越吵 / 标不出停顿 → 灵敏度调高一点。
          </div>
        </div>

        <div className="quick-advanced">
          <button className="quick-adv-toggle" onClick={() => setAdvanced((v) => !v)}>
            {advanced ? '▾' : '▸'} 进阶:手动固定音量阈值
          </button>
          {advanced && (
            <div className="quick-row" style={{ marginTop: 8 }}>
              <label
                className="quick-label"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                <input
                  type="checkbox"
                  checked={manualThreshold}
                  onChange={(e) => setManualThreshold(e.target.checked)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                用固定阈值(关掉自动)
                <span className="quick-value">{threshold.toFixed(3)}</span>
              </label>
              <input
                type="range"
                min="0.005"
                max="0.1"
                step="0.005"
                value={threshold}
                disabled={!manualThreshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="quick-slider"
              />
              <div className="quick-hint">
                只有勾选「用固定阈值」时才生效。数字越大 = 把更多"小声"当静音。
                一般用上面的自动灵敏度就好。
              </div>
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() =>
              onConfirm(
                manualThreshold
                  ? { minPauseSec: minPause, silenceThreshold: threshold }
                  : { minPauseSec: minPause, sensitivity }
              )
            }
          >
            开始分析
          </button>
        </div>
      </div>
    </div>
  );
}
