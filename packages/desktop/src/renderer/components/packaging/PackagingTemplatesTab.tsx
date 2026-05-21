/**
 * 模板 tab — pick ONE template, then 一键包装.
 *
 * Three templates, flat list (no separate "intensity" axis — that was a
 * confusing over-abstraction):
 *   - 商务讲解 (business-explainer): the Remotion template — 思源宋体 +
 *     黄字 + 竖排/逐字渐变/镜头推近/音效. Packaging-tab export renders
 *     through Remotion.
 *   - 通用 / 高能: the original keyword-花字 looks (libass-rendered on
 *     export). They differ in keyword density / color.
 *
 * The selected template drives BOTH the 一键包装 AI keyword pass AND which
 * renderer 导出成品 uses. Selection is the single source of truth.
 */
import type { PackagingVibe } from '@lynlens/core';

/** Template ids. 'business-explainer' = Remotion; others = libass花字. */
export type PackagingTemplateId = 'business-explainer' | 'default' | 'energetic';

/** The AI-keyword vibe each template uses when generating a plan. */
export function templateVibe(id: PackagingTemplateId): PackagingVibe {
  if (id === 'energetic') return 'energetic';
  return 'default';
}

interface Props {
  selected: PackagingTemplateId;
  onSelect: (next: PackagingTemplateId) => void;
  /** Trigger 一键包装 — same handler the header button uses. */
  onGenerate: () => void;
  generating: boolean;
  hasPlan: boolean;
}

interface TemplateOption {
  key: PackagingTemplateId;
  icon: string;
  label: string;
  desc: string;
  tag: string;
  accent: string;
}

const TEMPLATES: TemplateOption[] = [
  {
    key: 'business-explainer',
    icon: '📰',
    label: '商务讲解',
    desc: '思源宋体 + 白字描边 + 黄色强调 · 竖排/逐字渐变/镜头推近/音效',
    tag: 'Remotion · 满编排',
    accent: '#f39c12',
  },
  {
    key: 'default',
    icon: '🅰️',
    label: '通用',
    desc: '每段 1-2 个关键词,黄色 +20%',
    tag: '基础花字',
    accent: '#7aa2f7',
  },
  {
    key: 'energetic',
    icon: '🔥',
    label: '高能',
    desc: '关键词更密,红黄轮换 +30%',
    tag: '基础花字',
    accent: '#ff6b6b',
  },
];

export function PackagingTemplatesTab({
  selected,
  onSelect,
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
        选一张模板 → 点「{hasPlan ? '✨ 重新包装' : '✨ 一键包装'}」让 AI 配花字 → 头部「🎬 导出成品」用选中的模板渲染出片。
      </div>

      {/* Flat template list — one card per template, single selection. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {TEMPLATES.map((t) => {
          const active = selected === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onSelect(t.key)}
              disabled={generating}
              style={{
                padding: 12,
                background: active ? `${t.accent}1f` : '#181820',
                border: `1.5px solid ${active ? t.accent : '#2a2a2a'}`,
                borderRadius: 8,
                color: '#fff',
                cursor: generating ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                textAlign: 'left',
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <div style={{ fontSize: 24, lineHeight: 1 }}>{t.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: active ? t.accent : '#fff' }}>
                  {t.label}
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 400,
                      color: 'var(--text3)',
                      marginLeft: 6,
                    }}
                  >
                    {t.tag}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, lineHeight: 1.5 }}>
                  {t.desc}
                </div>
              </div>
              {active && (
                <div
                  style={{
                    fontSize: 11,
                    color: t.accent,
                    border: `1px solid ${t.accent}`,
                    borderRadius: 999,
                    padding: '2px 10px',
                    whiteSpace: 'nowrap',
                  }}
                >
                  ✓ 已选
                </div>
              )}
            </button>
          );
        })}
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
