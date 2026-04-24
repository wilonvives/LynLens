import { useState } from 'react';
import { getOrientation, type VideoMeta } from './core-browser';

export type SpeakerCountChoice = 'auto' | 1 | 2 | 3 | 4;

interface Props {
  videoMeta: VideoMeta;
  /** Existing orientation if the user set one already; used as default. */
  defaultOrientation?: 'landscape' | 'portrait' | null;
  onConfirm: (opts: {
    orientation: 'landscape' | 'portrait';
    speakerCount: SpeakerCountChoice;
  }) => void;
  onCancel: () => void;
}

/**
 * Combined 「字幕转录」 settings dialog. Collects two things the user
 * needs to decide before the one-click transcribe+diarize pipeline runs:
 *
 *   1. Subtitle orientation (横屏/竖屏) — affects line splitting.
 *   2. Speaker count — 自动 lets sherpa guess (often over-splits); 1-4
 *      forces exactly that many clusters, which is much more robust
 *      for short / low-speaker-count content.
 *
 * The dialog name in the h3 is deliberate: this is no longer the old
 * "视频方向" modal — it's the full transcription entry point.
 */
export function OrientationDialog({
  videoMeta,
  defaultOrientation,
  onConfirm,
  onCancel,
}: Props) {
  const autoOrient = getOrientation(
    videoMeta.width,
    videoMeta.height,
    videoMeta.rotation ?? 0
  );
  const [orientation, setOrientation] = useState<'landscape' | 'portrait'>(
    defaultOrientation ?? autoOrient
  );
  const [speakerCount, setSpeakerCount] = useState<SpeakerCountChoice>('auto');

  const countOptions: Array<{ value: SpeakerCountChoice; label: string; desc: string }> = [
    { value: 'auto', label: '自动', desc: 'AI 猜 (可能分太细)' },
    { value: 1, label: '1 人', desc: '独白 / vlog' },
    { value: 2, label: '2 人', desc: '访谈 / 对谈' },
    { value: 3, label: '3 人', desc: '小组讨论' },
    { value: 4, label: '4 人', desc: '多人圆桌' },
  ];

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog" style={{ minWidth: 460 }}>
        <h3>字幕转录</h3>
        <div style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          会先用 whisper 生成字幕,再用 sherpa-onnx 按声纹区分说话人,一次做完。
        </div>

        <div className="quick-row" style={{ marginBottom: 14 }}>
          <label className="quick-label">视频方向(影响字幕分行)</label>
          <div style={{ color: 'var(--text3)', fontSize: 11, marginBottom: 6 }}>
            检测到: {videoMeta.width}×{videoMeta.height}
            {videoMeta.rotation ? ` · rot ${videoMeta.rotation}°` : ''} →{' '}
            {autoOrient === 'landscape' ? '横屏' : '竖屏'}
          </div>
          <div className="orient-choices">
            <label className={`orient-choice ${orientation === 'landscape' ? 'active' : ''}`}>
              <input
                type="radio"
                name="orient"
                checked={orientation === 'landscape'}
                onChange={() => setOrientation('landscape')}
              />
              <div className="orient-choice-body">
                <div className="orient-choice-title">横屏</div>
                <div className="orient-choice-desc">中 24 / 英 90 字</div>
              </div>
            </label>
            <label className={`orient-choice ${orientation === 'portrait' ? 'active' : ''}`}>
              <input
                type="radio"
                name="orient"
                checked={orientation === 'portrait'}
                onChange={() => setOrientation('portrait')}
              />
              <div className="orient-choice-body">
                <div className="orient-choice-title">竖屏</div>
                <div className="orient-choice-desc">中 12 / 英 45 字</div>
              </div>
            </label>
          </div>
        </div>

        <div className="quick-row">
          <label className="quick-label">说话人数(区分声纹用)</label>
          <div style={{ color: 'var(--text3)', fontSize: 11, marginBottom: 6 }}>
            知道多少人就选多少,事先告知会比"自动"准确得多。
          </div>
          <div className="copy-platform-row">
            {countOptions.map((o) => (
              <label
                key={String(o.value)}
                className={`copy-platform-chip ${speakerCount === o.value ? 'on' : ''}`}
                title={o.desc}
              >
                <input
                  type="radio"
                  name="speaker-count"
                  checked={speakerCount === o.value}
                  onChange={() => setSpeakerCount(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button
            className="primary"
            onClick={() => onConfirm({ orientation, speakerCount })}
          >
            开始转录
          </button>
        </div>
      </div>
    </div>
  );
}
