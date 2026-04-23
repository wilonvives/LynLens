import { useState } from 'react';
import type { HighlightVariant, SocialPlatform } from './core-browser';

interface Props {
  /** Variants currently available; if empty, only "rippled" source is selectable. */
  variants: HighlightVariant[];
  /** Current global style note from the project; used as default for the textarea. */
  initialStyleNote: string;
  onCancel: () => void;
  onConfirm: (opts: {
    sourceType: 'rippled' | 'variant';
    sourceVariantId?: string;
    platforms: SocialPlatform[];
    userStyleNote?: string;
    saveStyleNoteGlobally: boolean;
  }) => void;
}

interface PlatformOption {
  value: SocialPlatform;
  label: string;
}

const PLATFORM_OPTIONS: PlatformOption[] = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'twitter', label: 'X (Twitter)' },
];

/**
 * Settings dialog before the copywriter generation call: pick the source
 * (粗剪 or a specific variant), which platforms to generate for, and
 * optionally a style note. Style note can be promoted to the project-wide
 * default so future generations reuse it without retyping.
 */
export function GenerateCopyDialog({
  variants,
  initialStyleNote,
  onCancel,
  onConfirm,
}: Props) {
  type SourceOption =
    | { kind: 'rippled' }
    | { kind: 'variant'; variantId: string };

  const [source, setSource] = useState<SourceOption>({ kind: 'rippled' });
  const [platforms, setPlatforms] = useState<Set<SocialPlatform>>(
    new Set(['xiaohongshu', 'instagram', 'tiktok'])
  );
  const [styleNote, setStyleNote] = useState(initialStyleNote);
  const [saveGlobally, setSaveGlobally] = useState(false);

  function togglePlatform(p: SocialPlatform): void {
    setPlatforms((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function canSubmit(): boolean {
    return platforms.size > 0;
  }

  function submit(): void {
    if (!canSubmit()) return;
    onConfirm({
      sourceType: source.kind,
      sourceVariantId: source.kind === 'variant' ? source.variantId : undefined,
      platforms: Array.from(platforms),
      userStyleNote: styleNote.trim() ? styleNote.trim() : undefined,
      saveStyleNoteGlobally: saveGlobally,
    });
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog" style={{ minWidth: 520 }}>
        <h3>生成社群文案</h3>
        <div className="quick-desc">
          挑一个输入源 → 选要的平台 → 加点风格说明(可选) → Claude 并行为每个平台单独写一版。
          生成的文案会存进工程,切 tab 不会丢。
        </div>

        {/* Source selector */}
        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">输入源</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
            <label className={`orient-choice ${source.kind === 'rippled' ? 'active' : ''}`}>
              <input
                type="radio"
                name="copy-source"
                checked={source.kind === 'rippled'}
                onChange={() => setSource({ kind: 'rippled' })}
              />
              <div className="orient-choice-body">
                <div className="orient-choice-title">粗剪完整版</div>
                <div className="orient-choice-desc">用完整视频的字幕(已经去掉 ripple 段)作为 AI 的输入</div>
              </div>
            </label>
            {variants.map((v) => (
              <label
                key={v.id}
                className={`orient-choice ${
                  source.kind === 'variant' && source.variantId === v.id ? 'active' : ''
                }`}
              >
                <input
                  type="radio"
                  name="copy-source"
                  checked={source.kind === 'variant' && source.variantId === v.id}
                  onChange={() => setSource({ kind: 'variant', variantId: v.id })}
                />
                <div className="orient-choice-body">
                  <div className="orient-choice-title">高光变体：{v.title}</div>
                  <div className="orient-choice-desc">
                    {v.durationSeconds.toFixed(1)} 秒 · {v.segments.length} 段
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {/* Platform checkboxes */}
        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">平台</label>
          <div className="copy-platform-row">
            {PLATFORM_OPTIONS.map((p) => {
              const checked = platforms.has(p.value);
              return (
                <label
                  key={p.value}
                  className={`copy-platform-chip ${checked ? 'on' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePlatform(p.value)}
                  />
                  {p.label}
                </label>
              );
            })}
          </div>
        </div>

        {/* Style note */}
        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">
            账号定位 / 本次补充说明(可选)
            <span className="quick-value">{styleNote.length} 字</span>
          </label>
          <textarea
            className="sub-text"
            style={{ width: '100%', minHeight: 70, marginTop: 6 }}
            placeholder="比如: 我的账号做马来西亚华人创业,语气偏轻松,避免说教"
            value={styleNote}
            onChange={(e) => setStyleNote(e.target.value)}
          />
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 11,
              color: '#888',
              marginTop: 6,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={saveGlobally}
              onChange={(e) => setSaveGlobally(e.target.checked)}
            />
            保存为该工程的默认风格(下次生成时自动带上)
          </label>
        </div>

        <div className="dialog-actions">
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={submit} disabled={!canSubmit()}>
            开始生成 ({platforms.size})
          </button>
        </div>
      </div>
    </div>
  );
}
