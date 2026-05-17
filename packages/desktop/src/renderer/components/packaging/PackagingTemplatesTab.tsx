/**
 * 模板 tab — visual style preset cards. Inspired by 开拍's 网感模板.
 *
 * v0.5 P1 (current): placeholder UI + the existing vibe selector kept
 * functional so the AI workflow doesn't regress. Real template cards
 * with mini visual previews land in P3 of the refactor.
 */
import type { PackagingVibe } from '@lynlens/core';

interface Props {
  vibe: PackagingVibe;
  onVibeChange: (next: PackagingVibe) => void;
  /** Trigger 一键包装 — same handler the header button uses. */
  onGenerate: () => void;
  generating: boolean;
  hasPlan: boolean;
}

interface VibeOption {
  key: PackagingVibe;
  label: string;
  desc: string;
  accent: string;
}

const VIBES: VibeOption[] = [
  {
    key: 'default',
    label: '通用',
    desc: '每段 1-2 个关键词,黄色 +20%',
    accent: '#7aa2f7',
  },
  {
    key: 'energetic',
    label: '高能',
    desc: '关键词更密,红黄轮换 +30%',
    accent: '#ff6b6b',
  },
  {
    key: 'calm',
    label: '冷静',
    desc: '关键词稀疏,克制金色 +10%',
    accent: '#9ece6a',
  },
];

export function PackagingTemplatesTab({
  vibe,
  onVibeChange,
  onGenerate,
  generating,
  hasPlan,
}: Props): JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          padding: 10,
          background: '#181820',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          fontSize: 11,
          color: 'var(--text2)',
          lineHeight: 1.6,
        }}
      >
        挑一种风格 → 点「{hasPlan ? '✨ 重新包装' : '✨ 一键包装'}」让 AI 按这个调性给字幕配花字。
        <br />
        <span style={{ color: 'var(--text3)' }}>
          v0.6+ 会加 4-6 张可视化模板卡片 (高级红 / 经典黑 / 高能黄 / 文艺等)。
        </span>
      </div>

      {/* Vibe picker — bigger touch targets than the header dropdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {VIBES.map((v) => (
          <button
            key={v.key}
            onClick={() => onVibeChange(v.key)}
            disabled={generating}
            style={{
              padding: '12px 8px',
              background: vibe === v.key ? `${v.accent}22` : '#181820',
              border: `1.5px solid ${vibe === v.key ? v.accent : '#2a2a2a'}`,
              borderRadius: 6,
              color: '#fff',
              cursor: generating ? 'not-allowed' : 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              alignItems: 'flex-start',
              textAlign: 'left',
              transition: 'background 0.15s, border-color 0.15s',
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: vibe === v.key ? v.accent : '#fff',
              }}
            >
              {v.label}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text3)', lineHeight: 1.4 }}>{v.desc}</div>
          </button>
        ))}
      </div>

      <button
        className="primary"
        onClick={onGenerate}
        disabled={generating}
        style={{ padding: '10px', fontSize: 13 }}
      >
        {generating ? '✨ AI 设计中...' : hasPlan ? '✨ 重新包装' : '✨ 一键包装'}
      </button>
    </div>
  );
}
