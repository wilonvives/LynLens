/**
 * Full text-editing toolbar for the 默认样式 region of the 字幕 tab.
 * Drives plan.defaults.subtitle. Mirrors the style fields the ASS
 * exporter + HTML overlay both consume so what you see here is what
 * lands in both renderers.
 *
 * Layout: a single compact row with grouped controls. Wraps to
 * multiple rows when the panel is narrow.
 *
 * Why a separate component: PackagingSubtitlesTab was already 280+
 * lines and the toolbar is independent. Easier to iterate (add
 * letter-spacing, line-height, etc.) without churning the tab file.
 */
import type { PackagingPlan, SubtitleStyle } from '@lynlens/core';

/**
 * Fonts the toolbar offers. Constraint: every family name MUST be one
 * macOS ships preinstalled so changing the dropdown produces a visible
 * change without requiring custom font installs. Bundled-font support
 * (阿里普惠体 / 得意黑 / 优设标题黑) is a separate feature — those
 * families fall back to PingFang on stock macOS, so listing them here
 * was misleading (every option rendered identical).
 *
 * Weight is controlled via the Bold toggle (fontWeight CSS), NOT by
 * appending "Heavy" to the family name (which produces a non-existent
 * family + silent fallback).
 */
const FONT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '"PingFang SC", sans-serif', label: '苹方 PingFang' },
  { value: '"Hiragino Sans GB", sans-serif', label: '冬青黑 Hiragino' },
  { value: '"Heiti SC", sans-serif', label: '黑体 Heiti' },
  { value: '"STHeiti", sans-serif', label: '华文黑体 STHeiti' },
  { value: '"Songti SC", serif', label: '宋体 Songti' },
  { value: '"Kaiti SC", serif', label: '楷体 Kaiti' },
  { value: '"STFangsong", serif', label: '仿宋 STFangsong' },
  { value: '"Helvetica Neue", Helvetica, Arial, sans-serif', label: 'Helvetica (英)' },
  { value: '"Avenir Next", "Avenir", sans-serif', label: 'Avenir (英)' },
  { value: 'Impact, "Helvetica Neue", sans-serif', label: 'Impact (英·粗黑)' },
  { value: '"Arial Black", Impact, sans-serif', label: 'Arial Black (英·粗)' },
  { value: 'Futura, "Helvetica Neue", sans-serif', label: 'Futura (英)' },
];

interface Props {
  plan: PackagingPlan;
  onPlanChange: (next: PackagingPlan) => void;
}

export function PackagingStyleToolbar({
  plan,
  onPlanChange,
}: Props): JSX.Element {
  const cur = plan.defaults.subtitle ?? {};
  // Match the first FONT_OPTIONS entry so the <select> always lands on
  // a value that exists in the dropdown (otherwise React fires the
  // "controlled input has no matching option" warning and the user
  // sees an empty selector).
  const DEFAULT_FONT = FONT_OPTIONS[0].value;
  // If the persisted font isn't one of our options (e.g. legacy
  // "PingFang SC Heavy" from before this list was curated), display
  // the default but keep the persisted value as-is until the user
  // explicitly picks something.
  const persistedFont = cur.font ?? DEFAULT_FONT;
  const font = FONT_OPTIONS.some((o) => o.value === persistedFont)
    ? persistedFont
    : DEFAULT_FONT;
  const size = cur.size ?? 56;
  const color = cur.color ?? '#ffffff';
  const outlineColor = cur.outline?.color ?? '#000000';
  const outlineWidth = cur.outline?.width ?? 3;
  const position = cur.position ?? 'bottom';
  const bold = cur.bold ?? true;
  const shadowOn = !!cur.shadow;
  const shadowDepth = cur.shadow?.depth ?? 4;
  const shadowColor = cur.shadow?.color ?? '#000000';

  function patch(p: Partial<SubtitleStyle>): void {
    onPlanChange({
      ...plan,
      defaults: {
        ...plan.defaults,
        subtitle: { ...cur, ...p },
      },
    });
  }

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 8,
        rowGap: 6,
        alignItems: 'center',
        padding: 8,
        background: '#181820',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
      }}
    >
      {/* Font family */}
      <Group label="字体">
        <select
          value={font}
          onChange={(e) => patch({ font: e.target.value })}
          style={ctrlSelect}
        >
          {FONT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Group>

      {/* Size — slider + number paired */}
      <Group label="字号">
        <input
          type="number"
          min={16}
          max={120}
          step={1}
          value={size}
          onChange={(e) => patch({ size: clamp(parseInt(e.target.value, 10), 16, 120) })}
          style={{ ...ctrlSelect, width: 56 }}
        />
        <input
          type="range"
          min={16}
          max={120}
          step={1}
          value={size}
          onChange={(e) => patch({ size: parseInt(e.target.value, 10) })}
          style={{ width: 100, accentColor: 'var(--accent)' }}
        />
      </Group>

      {/* Bold toggle */}
      <ToggleBtn
        active={bold}
        onClick={() => patch({ bold: !bold })}
        title={bold ? '关掉加粗' : '开启加粗'}
      >
        <span style={{ fontWeight: 900, fontSize: 13 }}>B</span>
      </ToggleBtn>

      {/* Position picker (top/center/bottom) */}
      <Group label="位置">
        <div style={pillGroup}>
          {(['top', 'center', 'bottom'] as const).map((p) => (
            <button
              key={p}
              onClick={() => patch({ position: p })}
              style={{
                ...pillBtn,
                background:
                  position === p ? 'var(--accent)' : 'transparent',
                color: position === p ? '#fff' : 'var(--text2)',
              }}
              title={p === 'top' ? '顶部' : p === 'center' ? '中间' : '底部'}
            >
              {p === 'top' ? '↑' : p === 'center' ? '●' : '↓'}
            </button>
          ))}
        </div>
      </Group>

      {/* Foreground color */}
      <Group label="字色">
        <input
          type="color"
          value={color}
          onChange={(e) => patch({ color: e.target.value })}
          style={ctrlColor}
        />
      </Group>

      {/* Outline */}
      <Group label="描边">
        <input
          type="color"
          value={outlineColor}
          onChange={(e) =>
            patch({
              outline: {
                color: e.target.value,
                width: outlineWidth,
              },
            })
          }
          style={ctrlColor}
          title="描边颜色"
        />
        <input
          type="number"
          min={0}
          max={8}
          step={0.5}
          value={outlineWidth}
          onChange={(e) =>
            patch({
              outline: {
                color: outlineColor,
                width: clamp(parseFloat(e.target.value), 0, 8),
              },
            })
          }
          style={{ ...ctrlSelect, width: 50 }}
          title="描边粗细 (px)"
        />
      </Group>

      {/* Shadow */}
      <Group label="阴影">
        <ToggleBtn
          active={shadowOn}
          onClick={() =>
            patch({
              shadow: shadowOn
                ? undefined
                : { depth: shadowDepth, color: shadowColor },
            })
          }
          title={shadowOn ? '关闭阴影' : '开启阴影'}
        >
          {shadowOn ? '开' : '关'}
        </ToggleBtn>
        {shadowOn && (
          <>
            <input
              type="color"
              value={shadowColor}
              onChange={(e) =>
                patch({ shadow: { depth: shadowDepth, color: e.target.value } })
              }
              style={ctrlColor}
              title="阴影颜色"
            />
            <input
              type="number"
              min={0}
              max={20}
              step={0.5}
              value={shadowDepth}
              onChange={(e) =>
                patch({
                  shadow: {
                    depth: clamp(parseFloat(e.target.value), 0, 20),
                    color: shadowColor,
                  },
                })
              }
              style={{ ...ctrlSelect, width: 50 }}
              title="阴影深度 (px)"
            />
          </>
        )}
      </Group>
    </div>
  );
}

// --- tiny presentational helpers ----------------------------------------

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--text2)',
      }}
    >
      <span style={{ marginRight: 2 }}>{label}</span>
      {children}
    </label>
  );
}

function ToggleBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        padding: '3px 10px',
        background: active ? 'var(--accent)' : '#181820',
        color: active ? '#fff' : 'var(--text2)',
        border: `1px solid ${active ? 'var(--accent)' : '#333'}`,
        borderRadius: 4,
        cursor: 'pointer',
        fontSize: 12,
        minWidth: 32,
        textAlign: 'center',
      }}
    >
      {children}
    </button>
  );
}

const ctrlSelect: React.CSSProperties = {
  fontSize: 11,
  padding: '2px 6px',
  background: '#181820',
  color: 'var(--text1)',
  border: '1px solid #333',
  borderRadius: 4,
  height: 24,
};

const ctrlColor: React.CSSProperties = {
  width: 28,
  height: 22,
  padding: 0,
  border: '1px solid #333',
  borderRadius: 3,
  cursor: 'pointer',
  background: 'transparent',
};

const pillGroup: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid #333',
  borderRadius: 4,
  overflow: 'hidden',
};

const pillBtn: React.CSSProperties = {
  padding: '3px 10px',
  fontSize: 11,
  border: 'none',
  borderRight: '1px solid #333',
  cursor: 'pointer',
};

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
