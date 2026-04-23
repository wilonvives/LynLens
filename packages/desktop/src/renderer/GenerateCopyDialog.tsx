import { useState } from 'react';
import type { HighlightVariant, SocialPlatform } from './core-browser';

interface Props {
  /** Variants currently available; if empty, only "rippled" source is selectable. */
  variants: HighlightVariant[];
  /**
   * Current global style note shown read-only for context. The dialog's
   * "本次额外说明" is separate and additive — it does NOT modify this.
   */
  globalStyleNote: string;
  onCancel: () => void;
  onConfirm: (opts: {
    sourceType: 'rippled' | 'variant';
    sourceVariantId?: string;
    platforms: SocialPlatform[];
    /** Per-generation note only. Empty unless user explicitly typed. */
    perRunNote?: string;
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
  globalStyleNote,
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
  // Per-run note only — always starts empty.
  const [perRunNote, setPerRunNote] = useState('');

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
      perRunNote: perRunNote.trim() ? perRunNote.trim() : undefined,
    });
  }

  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div className="dialog" style={{ minWidth: 520 }}>
        <h3>生成社群文案</h3>

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

        {/* Global style — read-only display, editable on the main panel. */}
        {globalStyleNote.trim() && (
          <div className="quick-row" style={{ marginTop: 12 }}>
            <label className="quick-label">全局风格(在主页面修改)</label>
            <div className="copy-dialog-global-style">{globalStyleNote}</div>
          </div>
        )}

        {/* Per-run note — additive, not saved. */}
        <div className="quick-row" style={{ marginTop: 12 }}>
          <label className="quick-label">
            本次额外说明(可选,仅这次生效)
            <span className="quick-value">{perRunNote.length} 字</span>
          </label>
          <textarea
            className="sub-text"
            style={{ width: '100%', minHeight: 70, marginTop: 6 }}
            placeholder="比如: 这次标题前面加一个 🇲🇾 emoji / 着重讲税务细节"
            value={perRunNote}
            onChange={(e) => setPerRunNote(e.target.value)}
          />
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
