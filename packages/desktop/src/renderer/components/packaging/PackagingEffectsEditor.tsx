/**
 * Camera-effect line editor for the 商务讲解 template (plan.templateSpec.effects).
 * Add / remove / retime impactPunch / vignetteFocus / bottomScrim / coolGrade.
 * The live player reflects edits instantly.
 *
 * CameraLayer takes the FIRST effect hit per frame, so overlapping windows
 * are ambiguous — we warn (don't auto-fix) so the author can resolve.
 */
import type {
  BusinessExplainerSpec,
  SpecEffect,
  SpecEffectType,
} from '@lynlens/core';

interface Props {
  spec: BusinessExplainerSpec;
  onSpecChange: (next: BusinessExplainerSpec) => void;
  /** Player time (variant seconds) — new effects start here. */
  currentTimeSec: number;
}

const EFFECT_TYPES: Array<{ id: SpecEffectType; label: string; hint: string }> = [
  { id: 'impactPunch', label: '冲击推近', hint: '配 Hero 句/最炸的点' },
  { id: 'vignetteFocus', label: '黑边压暗', hint: '开场留人/转严肃' },
  { id: 'bottomScrim', label: '底部底盘', hint: '连续重点信息段' },
  { id: 'coolGrade', label: '去色冷调', hint: '极少用·视觉惊悚瞬间' },
];

function sortEffects(effects: SpecEffect[]): SpecEffect[] {
  return [...effects].sort((a, b) => a.start - b.start);
}

export function PackagingEffectsEditor({
  spec,
  onSpecChange,
  currentTimeSec,
}: Props): JSX.Element {
  const effects = spec.effects ?? [];

  function update(next: SpecEffect[]): void {
    onSpecChange({ ...spec, effects: sortEffects(next) });
  }
  function patch(idx: number, p: Partial<SpecEffect>): void {
    update(effects.map((e, i) => (i === idx ? { ...e, ...p } : e)));
  }
  function remove(idx: number): void {
    update(effects.filter((_, i) => i !== idx));
  }
  function add(): void {
    const start = Number(currentTimeSec.toFixed(2));
    update([...effects, { type: 'impactPunch', start, end: Number((start + 1.2).toFixed(2)) }]);
  }

  // Overlap detection (sorted): a window starts before the previous ends.
  const sorted = sortEffects(effects);
  const overlapStarts = new Set<number>();
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start < sorted[i - 1].end) overlapStarts.add(sorted[i].start);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        镜头特效线(作用于背景视频)。窗口不要重叠;改完左边实时变。
      </div>
      {effects.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: 12 }}>
          还没有特效。点下面「+ 加特效」。
        </div>
      )}
      {effects.map((eff, idx) => (
        <div
          key={idx}
          style={{
            padding: 8,
            background: '#181820',
            border: `1px solid ${overlapStarts.has(eff.start) ? 'rgba(255,107,107,0.5)' : '#2a2a2a'}`,
            borderRadius: 6,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={eff.type}
              onChange={(e) => patch(idx, { type: e.target.value as SpecEffectType })}
              style={ctrl}
              title={EFFECT_TYPES.find((t) => t.id === eff.type)?.hint}
            >
              {EFFECT_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <button onClick={() => remove(idx)} title="删除" style={removeBtn}>
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11, color: 'var(--text3)' }}>
            <label style={lbl}>
              起
              <input
                type="number"
                step={0.1}
                min={0}
                value={eff.start}
                onChange={(e) => patch(idx, { start: Number(e.target.value) })}
                style={numIn}
              />
              s
            </label>
            <label style={lbl}>
              止
              <input
                type="number"
                step={0.1}
                min={0}
                value={eff.end}
                onChange={(e) => patch(idx, { end: Number(e.target.value) })}
                style={numIn}
              />
              s
            </label>
            <label style={lbl}>
              收尾
              <select
                value={eff.tail ?? 'release'}
                onChange={(e) =>
                  patch(idx, { tail: e.target.value as 'release' | 'hold' })
                }
                style={{ ...ctrl, width: 64 }}
              >
                <option value="release">推回</option>
                <option value="hold">保持</option>
              </select>
            </label>
          </div>
        </div>
      ))}
      <button onClick={add} className="primary" style={{ fontSize: 12, padding: '6px' }}>
        + 加特效
      </button>
    </div>
  );
}

const ctrl: React.CSSProperties = {
  fontSize: 12,
  padding: '3px 6px',
  background: '#0f0f14',
  color: 'var(--text1)',
  border: '1px solid #333',
  borderRadius: 4,
  flex: 1,
};
const numIn: React.CSSProperties = {
  width: 56,
  fontSize: 12,
  padding: '3px 4px',
  background: '#0f0f14',
  color: 'var(--text1)',
  border: '1px solid #333',
  borderRadius: 4,
};
const lbl: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 3 };
const removeBtn: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'transparent',
  color: '#ff6b6b',
  border: '1px solid #3a2a2a',
  borderRadius: 4,
  cursor: 'pointer',
};
