/**
 * Live editor for the 商务讲解 template spec (plan.templateSpec).
 *
 * One card per cue (subtitle line). Edits update the spec immutably and
 * bubble up via onSpecChange; the parent persists (debounced) and the live
 * @remotion/player reflects the change in real time.
 *
 * Per cue you can edit:
 *   - text (overrides the transcript text for THIS line in preview/export)
 *   - style: plain / strong / strongWord / sentence / cross
 *   - strongWord → keyword tags (must appear verbatim in the text)
 *   - sentence → 3 read-order segments [中, 上, 下]
 *   - cross → 2 segments [竖(限中文), 横]
 *
 * Effects + sounds editing live in the 画面 / 声音 tabs (separate editors).
 */
import { useMemo } from 'react';
import type {
  BusinessExplainerSpec,
  SpecCue,
  SpecCueStyle,
} from '@lynlens/core';

interface Props {
  spec: BusinessExplainerSpec;
  onSpecChange: (next: BusinessExplainerSpec) => void;
  /** Player time (variant seconds) — highlights the active cue. */
  currentTimeSec: number;
}

const STYLES: Array<{ id: SpecCueStyle; label: string; hint: string }> = [
  { id: 'plain', label: '普通', hint: '铺垫/过渡白字' },
  { id: 'strong', label: '加强', hint: '主体大粗字' },
  { id: 'strongWord', label: '关键词', hint: '+黄色关键词' },
  { id: 'sentence', label: '三行', hint: '金句 Hero' },
  { id: 'cross', label: '十字', hint: '对仗冲击句' },
];

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function PackagingSpecEditor({
  spec,
  onSpecChange,
  currentTimeSec,
}: Props): JSX.Element {
  // Active cue index: last cue whose start <= now.
  const activeIdx = useMemo(() => {
    let idx = -1;
    spec.cues.forEach((c, i) => {
      if (c.start <= currentTimeSec) idx = i;
    });
    return idx;
  }, [spec.cues, currentTimeSec]);

  function patchCue(idx: number, patch: Partial<SpecCue>): void {
    const cues = spec.cues.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onSpecChange({ ...spec, cues });
  }

  function setStyle(idx: number, style: SpecCueStyle): void {
    const cue = spec.cues[idx];
    const patch: Partial<SpecCue> = { style };
    // Initialise the fields the new style needs; clear the ones it doesn't.
    if (style === 'strongWord') {
      patch.highlight = cue.highlight ?? [];
      patch.segments = undefined;
    } else if (style === 'sentence') {
      patch.segments = padSegments(cue.segments, 3, cue.text);
      patch.highlight = undefined;
    } else if (style === 'cross') {
      patch.segments = padSegments(cue.segments, 2, cue.text);
      patch.highlight = undefined;
    } else {
      patch.highlight = undefined;
      patch.segments = undefined;
    }
    patchCue(idx, patch);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        逐行改样式/关键词/拆节,改完左边预览实时变。镜头特效在「画面」、音效在「声音」。
      </div>
      {spec.cues.map((cue, idx) => (
        <CueCard
          key={idx}
          cue={cue}
          active={idx === activeIdx}
          onText={(text) => patchCue(idx, { text })}
          onStyle={(s) => setStyle(idx, s)}
          onHighlight={(highlight) => patchCue(idx, { highlight })}
          onSegments={(segments) => patchCue(idx, { segments })}
        />
      ))}
    </div>
  );
}

/** Pad/trim a segments array to n entries, seeding from text on first use. */
function padSegments(
  existing: string[] | undefined,
  n: number,
  text: string
): string[] {
  if (existing && existing.length === n) return existing;
  const seed = existing ?? [text.trim()];
  const out = [...seed];
  while (out.length < n) out.push('');
  return out.slice(0, n);
}

interface CueCardProps {
  cue: SpecCue;
  active: boolean;
  onText: (text: string) => void;
  onStyle: (style: SpecCueStyle) => void;
  onHighlight: (highlight: string[]) => void;
  onSegments: (segments: string[]) => void;
}

function CueCard({
  cue,
  active,
  onText,
  onStyle,
  onHighlight,
  onSegments,
}: CueCardProps): JSX.Element {
  return (
    <div
      style={{
        padding: 10,
        background: active ? 'rgba(243,156,18,0.08)' : '#181820',
        border: `1px solid ${active ? 'rgba(243,156,18,0.5)' : '#2a2a2a'}`,
        borderRadius: 6,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, color: 'var(--text3)', fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(cue.start)}
        </span>
        <input
          value={cue.text}
          onChange={(e) => onText(e.target.value)}
          style={{
            flex: 1,
            fontSize: 12,
            padding: '4px 6px',
            background: '#0f0f14',
            color: 'var(--text1)',
            border: '1px solid #333',
            borderRadius: 4,
          }}
        />
      </div>

      {/* Style segmented control */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {STYLES.map((s) => {
          const on = cue.style === s.id;
          return (
            <button
              key={s.id}
              onClick={() => onStyle(s.id)}
              title={s.hint}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                background: on ? 'var(--accent)' : 'transparent',
                color: on ? '#fff' : 'var(--text2)',
                border: `1px solid ${on ? 'var(--accent)' : '#333'}`,
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              {s.label}
            </button>
          );
        })}
      </div>

      {/* Style-specific fields */}
      {cue.style === 'strongWord' && (
        <KeywordEditor
          text={cue.text}
          highlight={cue.highlight ?? []}
          onChange={onHighlight}
        />
      )}
      {(cue.style === 'sentence' || cue.style === 'cross') && (
        <SegmentEditor
          style={cue.style}
          segments={cue.segments ?? []}
          onChange={onSegments}
        />
      )}
    </div>
  );
}

function KeywordEditor({
  text,
  highlight,
  onChange,
}: {
  text: string;
  highlight: string[];
  onChange: (next: string[]) => void;
}): JSX.Element {
  // Space/comma separated. Invalid (not a substring of text) shown in red.
  const value = highlight.join(' ');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 10, color: 'var(--text3)' }}>
        关键词(空格分隔,必须是上面文字里出现的词)
      </label>
      <input
        value={value}
        placeholder="例如: 钱骡 终身"
        onChange={(e) => {
          const words = e.target.value
            .split(/[\s,，]+/)
            .map((w) => w.trim())
            .filter(Boolean);
          onChange(words);
        }}
        style={{
          fontSize: 12,
          padding: '4px 6px',
          background: '#0f0f14',
          color: '#ffd60a',
          border: '1px solid #333',
          borderRadius: 4,
        }}
      />
      {highlight.some((w) => !text.includes(w)) && (
        <span style={{ fontSize: 10, color: '#ff6b6b' }}>
          ⚠ 有关键词不在文字里,不会高亮:
          {highlight.filter((w) => !text.includes(w)).join('、')}
        </span>
      )}
    </div>
  );
}

function SegmentEditor({
  style,
  segments,
  onChange,
}: {
  style: 'sentence' | 'cross';
  segments: string[];
  onChange: (next: string[]) => void;
}): JSX.Element {
  const labels =
    style === 'sentence' ? ['中(焦点)', '上', '下'] : ['竖(限中文)', '横'];
  const n = style === 'sentence' ? 3 : 2;
  const vals = padSegments(segments, n, '');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <label style={{ fontSize: 10, color: 'var(--text3)' }}>
        {style === 'sentence' ? '三节(读序 中→上→下,每节 1-3 字)' : '两节(竖+横,竖限中文)'}
      </label>
      <div style={{ display: 'flex', gap: 6 }}>
        {labels.map((lbl, i) => (
          <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <input
              value={vals[i] ?? ''}
              onChange={(e) => {
                const next = [...vals];
                next[i] = e.target.value;
                onChange(next);
              }}
              style={{
                fontSize: 12,
                padding: '4px 6px',
                background: '#0f0f14',
                color: 'var(--text1)',
                border: '1px solid #333',
                borderRadius: 4,
                width: '100%',
              }}
            />
            <span style={{ fontSize: 9, color: 'var(--text3)', textAlign: 'center' }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
