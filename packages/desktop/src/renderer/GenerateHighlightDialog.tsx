import { useState } from 'react';
import type { HighlightStyle } from '@lynlens/core';

interface Props {
  effectiveDuration: number;
  onCancel: () => void;
  onConfirm: (opts: { style: HighlightStyle; count: number; targetSeconds: number }) => void;
}

/**
 * Settings dialog before calling Claude: which style, how many variants,
 * and what target duration. Kept deliberately small — decision #3 says
 * two real presets (default / 片头) plus "let AI decide" (ai-choice).
 */
export function GenerateHighlightDialog({ effectiveDuration, onCancel, onConfirm }: Props) {
  const [style, setStyle] = useState<HighlightStyle>('default');
  const [count, setCount] = useState<number>(3);
  const [targetSeconds, setTargetSeconds] = useState<number>(30);

  const styleOptions: Array<{ value: HighlightStyle; label: string; desc: string }> = [
    {
      value: 'default',
      label: '默认',
      desc: '精华混剪,最有价值的段落组合成一个连贯短视频',
    },
    {
      value: 'hero',
      label: '片头',
      desc: '社交媒体开头风格,前 3-10 秒要抓人',
    },
    {
      value: 'ai-choice',
      label: 'AI 自由发挥',
      desc: '让 Claude 自己选最合适的表达方式',
    },
  ];

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog" style={{ minWidth: 460 }}>
        <h3>生成高光变体</h3>
        <div className="quick-desc">
          基于已经粗剪(ripple)后的 {effectiveDuration.toFixed(1)} 秒字幕生成短视频变体。
          生成的变体不会存进工程文件,切回粗剪 tab 会清空。
        </div>

        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">风格</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            {styleOptions.map((opt) => (
              <label
                key={opt.value}
                className={`orient-choice ${style === opt.value ? 'active' : ''}`}
                style={{ padding: '8px 12px' }}
              >
                <input
                  type="radio"
                  name="hl-style"
                  checked={style === opt.value}
                  onChange={() => setStyle(opt.value)}
                />
                <div className="orient-choice-body">
                  <div className="orient-choice-title">{opt.label}</div>
                  <div className="orient-choice-desc">{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">
            变体数量 <span className="quick-value">{count}</span>
          </label>
          <input
            type="range"
            min="1"
            max="5"
            step="1"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
            className="quick-slider"
          />
          <div className="quick-scale">
            <span>1</span>
            <span>3</span>
            <span>5</span>
          </div>
        </div>

        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">
            每个变体目标时长 <span className="quick-value">{targetSeconds} 秒</span>
          </label>
          <input
            type="range"
            min="10"
            max="120"
            step="5"
            value={targetSeconds}
            onChange={(e) => setTargetSeconds(Number(e.target.value))}
            className="quick-slider"
          />
          <div className="quick-scale">
            <span>10s</span>
            <span>30s</span>
            <span>60s</span>
            <span>120s</span>
          </div>
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() => onConfirm({ style, count, targetSeconds })}
          >
            开始生成
          </button>
        </div>
      </div>
    </div>
  );
}
