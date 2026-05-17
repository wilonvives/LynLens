/**
 * Floating mini-toolbar that appears over the video preview when the
 * user clicks the subtitle text. Quick access to position + color so
 * the gesture "click subtitle → move it" feels direct, instead of
 * having to scroll the right-side tab.
 *
 * Scope (v0.5): edits the PROJECT-WIDE default style (all subtitles
 * move together). Per-segment positioning is a v0.6+ feature gated on
 * the schema decision to allow recipe.subtitle.position again.
 *
 * Positioning: rendered absolute inside the video preview wrap (a
 * positioned ancestor at <div style={{position:'relative'}}>). Picks
 * top / bottom of the wrap depending on where the subtitle is so the
 * toolbar doesn't overlap the text being edited.
 */
import type { PackagingPlan } from '@lynlens/core';

interface Props {
  plan: PackagingPlan;
  onPlanChange: (next: PackagingPlan) => void;
  onClose: () => void;
  /** Anchor side — pick the OPPOSITE edge so we don't overlap the text. */
  subtitlePosition: 'top' | 'center' | 'bottom';
}

const POSITIONS: Array<{ key: 'top' | 'center' | 'bottom'; label: string; arrow: string }> = [
  { key: 'top', label: '顶', arrow: '↑' },
  { key: 'center', label: '中', arrow: '●' },
  { key: 'bottom', label: '底', arrow: '↓' },
];

export function PackagingInlineEditor({
  plan,
  onPlanChange,
  onClose,
  subtitlePosition,
}: Props): JSX.Element {
  const currentPosition = plan.defaults.subtitle?.position ?? 'bottom';
  const currentColor = plan.defaults.subtitle?.color ?? '#ffffff';

  // Anchor opposite the subtitle: subtitle at top → toolbar at bottom, etc.
  // For 'center' show at the top.
  const anchorStyle: React.CSSProperties =
    subtitlePosition === 'top'
      ? { bottom: 12, left: '50%', transform: 'translateX(-50%)' }
      : { top: 12, left: '50%', transform: 'translateX(-50%)' };

  function setPosition(position: 'top' | 'center' | 'bottom'): void {
    onPlanChange({
      ...plan,
      defaults: {
        ...plan.defaults,
        subtitle: { ...(plan.defaults.subtitle ?? {}), position },
      },
    });
  }

  function setColor(color: string): void {
    onPlanChange({
      ...plan,
      defaults: {
        ...plan.defaults,
        subtitle: { ...(plan.defaults.subtitle ?? {}), color },
      },
    });
  }

  return (
    <div
      style={{
        position: 'absolute',
        ...anchorStyle,
        zIndex: 20,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'rgba(20, 20, 28, 0.95)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        border: '1px solid #444',
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
        fontSize: 12,
        color: '#fff',
        pointerEvents: 'auto',
      }}
      // Stop clicks from bubbling to the video / overlay.
      onClick={(e) => e.stopPropagation()}
    >
      <span style={{ color: 'var(--text3)', fontSize: 10, marginRight: 2 }}>位置</span>
      <div style={{ display: 'inline-flex', border: '1px solid #444', borderRadius: 4, overflow: 'hidden' }}>
        {POSITIONS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPosition(p.key)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              background: currentPosition === p.key ? 'var(--accent)' : 'transparent',
              color: currentPosition === p.key ? '#fff' : 'var(--text2)',
              border: 'none',
              borderRight: p.key !== 'bottom' ? '1px solid #444' : 'none',
              cursor: 'pointer',
              minWidth: 32,
            }}
            title={p.label + '部'}
          >
            {p.arrow}
          </button>
        ))}
      </div>

      <span style={{ color: 'var(--text3)', fontSize: 10, marginLeft: 6 }}>颜色</span>
      <input
        type="color"
        value={currentColor}
        onChange={(e) => setColor(e.target.value)}
        style={{
          width: 28,
          height: 22,
          padding: 0,
          border: '1px solid #444',
          borderRadius: 3,
          cursor: 'pointer',
          background: 'transparent',
        }}
        title="字幕颜色 (所有段)"
      />

      <button
        onClick={onClose}
        style={{
          marginLeft: 4,
          width: 22,
          height: 22,
          border: 'none',
          borderRadius: 11,
          background: '#333',
          color: '#fff',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
        title="关闭"
      >
        ×
      </button>

      <span style={{ color: 'var(--text3)', fontSize: 9, marginLeft: 4, maxWidth: 140 }}>
        所有段共用此样式
      </span>
    </div>
  );
}
