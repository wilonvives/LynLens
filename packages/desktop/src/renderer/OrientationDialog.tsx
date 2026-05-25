import { useEffect, useState } from 'react';
import { getOrientation, type VideoMeta } from './core-browser';

export type SpeakerCountChoice = 'auto' | 1 | 2 | 3 | 4;
export type TranscribeScope = 'full' | 'edited';
export type WhisperModelKey = 'base' | 'small' | 'medium' | 'large-v3';

interface Props {
  videoMeta: VideoMeta;
  /** Existing orientation if the user set one already; used as default. */
  defaultOrientation?: 'landscape' | 'portrait' | null;
  /** True when the project already has committed cuts — enables 模式B. */
  hasCuts?: boolean;
  onConfirm: (opts: {
    orientation: 'landscape' | 'portrait';
    speakerCount: SpeakerCountChoice;
    scope: TranscribeScope;
    model: WhisperModelKey;
  }) => void;
  /**
   * Alternative to running whisper: read an existing .srt file as the
   * project's transcript. Same dialog, second action button — keeps the
   * "how do I get subtitles on this video" question in one place instead
   * of two competing buttons on the toolbar. Receives the user-picked
   * orientation so the imported subtitles get the same display width.
   */
  onImportSrt: (orientation: 'landscape' | 'portrait') => void;
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
  hasCuts = false,
  onConfirm,
  onImportSrt,
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
  const [scope, setScope] = useState<TranscribeScope>('full');
  const [model, setModel] = useState<WhisperModelKey>('base');
  const [available, setAvailable] = useState<WhisperModelKey[]>(['base']);

  // Which whisper models are downloaded — gates the 高质量 option.
  useEffect(() => {
    window.lynlens
      .listWhisperModels()
      .then((m) => {
        if (m.length > 0) {
          setAvailable(m);
          setModel(m.includes('large-v3') ? 'large-v3' : m[0]);
        }
      })
      .catch(() => {});
  }, []);

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

        <div className="quick-row" style={{ marginTop: 14 }}>
          <label className="quick-label">识别范围</label>
          <div style={{ color: 'var(--text3)', fontSize: 11, marginBottom: 6 }}>
            {hasCuts
              ? '剪辑后视频：只识别剪剩的部分，所见即所得、更准。改刀后字幕会锁定需重转。'
              : '当前没有剪切，两者一致。'}
          </div>
          <div className="copy-platform-row">
            <label className={`copy-platform-chip ${scope === 'full' ? 'on' : ''}`} title="识别完整原片；字幕随剪切自动重映射、复原友好">
              <input type="radio" name="scope" checked={scope === 'full'} onChange={() => setScope('full')} />
              完整影片
            </label>
            <label
              className={`copy-platform-chip ${scope === 'edited' ? 'on' : ''} ${!hasCuts ? 'disabled' : ''}`}
              title={hasCuts ? '只识别剪剩的音频；改刀后需重转' : '需要先有剪切才能用'}
              style={!hasCuts ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            >
              <input
                type="radio"
                name="scope"
                disabled={!hasCuts}
                checked={scope === 'edited'}
                onChange={() => setScope('edited')}
              />
              剪辑后影片
            </label>
          </div>
        </div>

        <div className="quick-row" style={{ marginTop: 14 }}>
          <label className="quick-label">字幕模型</label>
          <div style={{ color: 'var(--text3)', fontSize: 11, marginBottom: 6 }}>
            高质量(large-v3)对粤语/口音更准，但更慢、需下载 ~3GB。
          </div>
          <div className="copy-platform-row">
            <label className={`copy-platform-chip ${model === 'base' ? 'on' : ''}`} title="ggml-base, 最快, 内置">
              <input type="radio" name="wmodel" checked={model === 'base'} onChange={() => setModel('base')} />
              快速 (base)
            </label>
            <label
              className={`copy-platform-chip ${model === 'large-v3' ? 'on' : ''} ${!available.includes('large-v3') ? 'disabled' : ''}`}
              title={available.includes('large-v3') ? 'ggml-large-v3, 最准, 较慢' : '尚未下载, 需先下载 large-v3'}
              style={!available.includes('large-v3') ? { opacity: 0.45, cursor: 'not-allowed' } : undefined}
            >
              <input
                type="radio"
                name="wmodel"
                disabled={!available.includes('large-v3')}
                checked={model === 'large-v3'}
                onChange={() => setModel('large-v3')}
              />
              高质量 (large-v3){!available.includes('large-v3') ? ' · 需下载' : ''}
            </label>
          </div>
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          {/* Secondary action: skip whisper, import an existing .srt
              instead. The user picks orientation up top (still affects
              subtitle display) but speaker count is ignored — diarization
              needs the original audio, which the user can run separately
              from chat panel if they want speaker tags on imported subs. */}
          <button
            onClick={() => onImportSrt(orientation)}
            title="读取一个 .srt 文件作为字幕(跳过 AI 转录)"
          >
            📂 导入 SRT
          </button>
          <button
            className="primary"
            onClick={() => onConfirm({ orientation, speakerCount, scope, model })}
          >
            开始转录
          </button>
        </div>
      </div>
    </div>
  );
}
