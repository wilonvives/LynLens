import { useState } from 'react';
import { getOrientation, type VideoMeta } from './core-browser';

interface Props {
  videoMeta: VideoMeta;
  onConfirm: (o: 'landscape' | 'portrait') => void;
  onCancel: () => void;
}

/**
 * Asked once before the first transcription so the subtitle line-splitter
 * knows the intended display orientation (12 / 45 for portrait,
 * 24 / 90 for landscape). Auto-detect is shown but pre-selected as a guess.
 */
export function OrientationDialog({ videoMeta, onConfirm, onCancel }: Props) {
  const autoDetected = getOrientation(
    videoMeta.width,
    videoMeta.height,
    videoMeta.rotation ?? 0
  );
  const [choice, setChoice] = useState<'landscape' | 'portrait'>(autoDetected);

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ minWidth: 380 }}>
        <h3>视频方向</h3>
        <div style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          字幕分行的字数上限取决于视频方向。
          <br />
          <span style={{ color: 'var(--text3)', fontSize: 12 }}>
            检测到:{' '}
            <strong style={{ color: 'var(--text2)' }}>
              {videoMeta.width}×{videoMeta.height}
              {videoMeta.rotation ? ` · rot ${videoMeta.rotation}°` : ''} →{' '}
              {autoDetected === 'landscape' ? '横屏' : '竖屏'}
            </strong>
            <br />
            (如果不对请在下面纠正)
          </span>
        </div>

        <div className="orient-choices">
          <label className={`orient-choice ${choice === 'landscape' ? 'active' : ''}`}>
            <input
              type="radio"
              name="orient"
              checked={choice === 'landscape'}
              onChange={() => setChoice('landscape')}
            />
            <div className="orient-choice-body">
              <div className="orient-choice-title">横屏</div>
              <div className="orient-choice-desc">中文每行最多 24 字 / 英文 90 字</div>
            </div>
          </label>
          <label className={`orient-choice ${choice === 'portrait' ? 'active' : ''}`}>
            <input
              type="radio"
              name="orient"
              checked={choice === 'portrait'}
              onChange={() => setChoice('portrait')}
            />
            <div className="orient-choice-body">
              <div className="orient-choice-title">竖屏</div>
              <div className="orient-choice-desc">中文每行最多 12 字 / 英文 45 字</div>
            </div>
          </label>
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={() => onConfirm(choice)}>
            确认并开始转录
          </button>
        </div>
      </div>
    </div>
  );
}
