/**
 * Sound-effect line editor for the 商务讲解 template (plan.templateSpec.sounds).
 * Add / remove / retime one-shot sfx from the 15-id library. The live player
 * reflects edits instantly.
 *
 * Guidance baked into the UI: sfx should land on decorated lines (not plain)
 * and be spaced ≥2.5s; we surface a spacing warning but don't auto-fix.
 */
import type { BusinessExplainerSpec, SpecSound } from '@lynlens/core';

interface Props {
  spec: BusinessExplainerSpec;
  onSpecChange: (next: BusinessExplainerSpec) => void;
  currentTimeSec: number;
}

/** id → label (mirror of templates/.../sound/sounds.ts, grouped). */
const SOUND_OPTIONS: Array<{ group: string; items: Array<{ id: string; label: string }> }> = [
  {
    group: '开头',
    items: [
      { id: 'suspense-boom', label: 'Suspense Boom' },
      { id: 'tense-transition', label: 'Tense Transition' },
      { id: 'shh-tension', label: 'Shh Tension' },
    ],
  },
  {
    group: '重点',
    items: [
      { id: 'variety-suspense', label: 'Variety Suspense' },
      { id: 'variety-suspense-tap', label: 'Variety Tap' },
      { id: 'ming-suspense', label: 'Ming Suspense' },
      { id: 'clang-light', label: 'Clang' },
      { id: 'variety-suspense-wrong', label: 'Variety Wrong' },
      { id: 'eerie-drip', label: 'Eerie Drip' },
    ],
  },
  {
    group: '金句/收尾',
    items: [
      { id: 'flash-transition', label: 'Flash Transition' },
      { id: 'water-drop-soft', label: 'Water Drop (soft)' },
      { id: 'water-drop', label: 'Water Drop' },
      { id: 'wood-knock', label: 'Wood Knock' },
      { id: 'impact-echo', label: 'Impact Echo' },
      { id: 'pause-transition', label: 'Pause Transition' },
    ],
  },
];

function sortSounds(sounds: SpecSound[]): SpecSound[] {
  return [...sounds].sort((a, b) => a.start - b.start);
}

export function PackagingSoundsEditor({
  spec,
  onSpecChange,
  currentTimeSec,
}: Props): JSX.Element {
  const sounds = spec.sounds ?? [];
  const master = spec.soundsVolume ?? 1;
  const DEFAULT_SOUND_VOLUME = 0.85;

  function setMaster(v: number): void {
    onSpecChange({ ...spec, soundsVolume: Math.max(0, Math.min(1, v)) });
  }

  function update(next: SpecSound[]): void {
    onSpecChange({ ...spec, sounds: sortSounds(next) });
  }
  function patch(idx: number, p: Partial<SpecSound>): void {
    update(sounds.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  }
  function remove(idx: number): void {
    update(sounds.filter((_, i) => i !== idx));
  }
  function add(): void {
    update([
      ...sounds,
      { id: 'variety-suspense', start: Number(currentTimeSec.toFixed(2)) },
    ]);
  }

  // Spacing warning: <2.5s from the previous sound.
  const sorted = sortSounds(sounds);
  const tooClose = new Set<number>();
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].start - sorted[i - 1].start < 2.5) tooClose.add(sorted[i].start);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        音效线(一次性 sfx)。落在装饰行上、间隔 ≥2.5s;改完左边实时变。
      </div>

      {/* Master SFX volume — scales ALL sound effects at once (does NOT
          touch the original video audio). Per-line volume is on each row. */}
      <div
        style={{
          padding: '8px 10px',
          background: '#15151c',
          border: '1px solid #2a2a2a',
          borderRadius: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--text2)', whiteSpace: 'nowrap' }}>
          🔊 整体音效音量
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={master}
          onChange={(e) => setMaster(Number(e.target.value))}
          style={{ flex: 1, accentColor: 'var(--accent)' }}
          title="一次调低/调高所有音效的音量(不影响原视频声音)"
        />
        <span
          style={{
            fontSize: 11,
            color: 'var(--text3)',
            width: 36,
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {Math.round(master * 100)}%
        </span>
      </div>

      {sounds.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text3)', textAlign: 'center', padding: 12 }}>
          还没有音效。点下面「+ 加音效」。
        </div>
      )}
      {sounds.map((snd, idx) => (
        <div
          key={idx}
          style={{
            padding: 8,
            background: '#181820',
            border: `1px solid ${tooClose.has(snd.start) ? 'rgba(255,180,0,0.5)' : '#2a2a2a'}`,
            borderRadius: 6,
            display: 'flex',
            gap: 6,
            alignItems: 'center',
          }}
        >
          <select
            value={snd.id}
            onChange={(e) => patch(idx, { id: e.target.value })}
            style={ctrl}
          >
            {SOUND_OPTIONS.map((g) => (
              <optgroup key={g.group} label={g.group}>
                {g.items.map((it) => (
                  <option key={it.id} value={it.id}>
                    {it.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: 'var(--text3)' }}>
            <input
              type="number"
              step={0.1}
              min={0}
              value={snd.start}
              onChange={(e) => patch(idx, { start: Number(e.target.value) })}
              style={numIn}
            />
            s
          </label>
          {/* Per-sound volume — this line's own level (before the master
              multiplier). Default 0.85 when unset. */}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={snd.volume ?? DEFAULT_SOUND_VOLUME}
            onChange={(e) => patch(idx, { volume: Number(e.target.value) })}
            style={{ width: 64, accentColor: 'var(--accent)' }}
            title="这条音效自己的音量(再乘以上面的整体音量)"
          />
          <span
            style={{
              fontSize: 10,
              color: 'var(--text3)',
              width: 30,
              textAlign: 'right',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {Math.round((snd.volume ?? DEFAULT_SOUND_VOLUME) * 100)}%
          </span>
          <button onClick={() => remove(idx)} title="删除" style={removeBtn}>
            ✕
          </button>
        </div>
      ))}
      <button onClick={add} className="primary" style={{ fontSize: 12, padding: '6px' }}>
        + 加音效
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
const removeBtn: React.CSSProperties = {
  fontSize: 11,
  padding: '3px 8px',
  background: 'transparent',
  color: '#ff6b6b',
  border: '1px solid #3a2a2a',
  borderRadius: 4,
  cursor: 'pointer',
};
