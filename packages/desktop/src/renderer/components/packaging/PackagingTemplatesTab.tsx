/**
 * 模板 tab — pick ONE template, then 一键包装.
 *
 * Two templates, flat list:
 *   - 商务讲解 (business-explainer): the Remotion template — 思源宋体 +
 *     黄字 + 竖排/逐字渐变/镜头推近/音效. Packaging-tab export renders
 *     through Remotion.
 *   - 通用 (default): plain burned-in subtitles only — no AI keyword 花字,
 *     just the transcript in a clean style (font/size/color adjustable in
 *     the 字幕 tab). Export uses the libass pipeline.
 *
 * Selection drives both 一键包装 and which renderer 导出成品 uses.
 */

/** Template ids. 'business-explainer' = Remotion; 'default' = libass subtitles. */
export type PackagingTemplateId = 'business-explainer' | 'default';

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
    desc: '单纯上字幕 · 干净白字,字体/字号/颜色在「字幕」tab 调',
    tag: '纯字幕',
    accent: '#7aa2f7',
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
        选一张模板 → 点「{hasPlan ? '✨ 重新包装' : '✨ 一键包装'}」生成方案(商务讲解会 AI 编排;通用直接上干净字幕)→ 头部「🎬 导出成品」出片。
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
