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
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BusinessExplainerSpec,
  SimpleSubtitleStyle,
  SpecCue,
  SpecCueStyle,
} from '@lynlens/core';

interface Props {
  spec: BusinessExplainerSpec;
  onSpecChange: (next: BusinessExplainerSpec) => void;
  /** Player time (variant seconds) — highlights the active cue. */
  currentTimeSec: number;
  /** Seek the live player to a cue's time (on click / edit). */
  onSeekToCue?: (sec: number) => void;
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
  onSeekToCue,
}: Props): JSX.Element {
  // Active cue index: last cue whose start <= now.
  const activeIdx = useMemo(() => {
    let idx = -1;
    spec.cues.forEach((c, i) => {
      if (c.start <= currentTimeSec) idx = i;
    });
    return idx;
  }, [spec.cues, currentTimeSec]);

  // Follow playback: scroll the active cue into view as it changes (like the
  // 粗剪 字幕 panel) so the user always sees which line is playing. `nearest`
  // only scrolls when the cue is off-screen (no yank if already visible). We
  // skip while the user is typing in a cue field so it doesn't fight editing.
  const cardRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = cardRefs.current.get(activeIdx);
    if (!el) return;
    const focused = document.activeElement;
    const tag = focused?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return; // editing — don't yank
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [activeIdx]);

  function patchCue(idx: number, patch: Partial<SpecCue>): void {
    const cues = spec.cues.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onSpecChange({ ...spec, cues });
  }

  /**
   * Remove a cue line entirely. Packaging now OVER-captures sentences (so a
   * straddling head/tail line never goes missing); deleting the occasional
   * extra here is the intended counterpart. The preceding cue simply extends
   * to the next remaining cue's start.
   */
  function deleteCue(idx: number): void {
    onSpecChange({ ...spec, cues: spec.cues.filter((_, i) => i !== idx) });
  }

  /**
   * Insert a blank line at array position `idx` (0 = before first, cues.length
   * = after last). Its start is interpolated between the neighbours so it lands
   * exactly there on the timeline. Driven by the hover-revealed "+" between
   * cards — add a sentence wherever you want, type the text + pick a style.
   */
  function insertCueAt(idx: number): void {
    const style: SpecCueStyle = spec.subtitleStyle ? 'simple' : 'strong';
    const prevStart = idx > 0 ? spec.cues[idx - 1].start : 0;
    const nextStart = idx < spec.cues.length ? spec.cues[idx].start : prevStart + 2;
    const start = (prevStart + nextStart) / 2;
    const next = [...spec.cues];
    next.splice(idx, 0, { start, text: '新字幕', style });
    onSpecChange({ ...spec, cues: next });
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
      {/* 通用模板的全局字幕外观(位置/字号/颜色/描边)。商务讲解没有这块。 */}
      {spec.subtitleStyle && (
        <SimpleStyleBar
          value={spec.subtitleStyle}
          onChange={(next) => onSpecChange({ ...spec, subtitleStyle: next })}
        />
      )}
      <div style={{ fontSize: 11, color: 'var(--text3)', lineHeight: 1.6 }}>
        {spec.subtitleStyle
          ? '逐行改文字、画重点(标的词变黄加粗),改完左边实时变。'
          : '逐行改样式/关键词/拆节,改完左边预览实时变。镜头特效在「画面」、音效在「声音」。'}
      </div>
      {/* Cue list with hover-revealed "+" inserters in every gap (before the
          first, between each pair, after the last). The gaps ARE the spacing,
          so the list isn't cluttered — the "+" only shows on hover. */}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {spec.cues.map((cue, idx) => (
          <Fragment key={idx}>
            <InsertGap onInsert={() => insertCueAt(idx)} />
            <div
              ref={(el) => {
                if (el) cardRefs.current.set(idx, el);
                else cardRefs.current.delete(idx);
              }}
            >
              <CueCard
                cue={cue}
                active={idx === activeIdx}
                onSeek={() => onSeekToCue?.(cue.start)}
                onText={(text) => patchCue(idx, { text })}
                onStyle={(s) => setStyle(idx, s)}
                onHighlight={(highlight) => patchCue(idx, { highlight })}
                onSegments={(segments) => patchCue(idx, { segments })}
                onDelete={() => deleteCue(idx)}
              />
            </div>
          </Fragment>
        ))}
        <InsertGap onInsert={() => insertCueAt(spec.cues.length)} />
      </div>
    </div>
  );
}

/**
 * Thin gap between cue cards. Invisible at rest (just provides the spacing);
 * on hover it grows a little and shows a centred "+" on an accent line. Click
 * inserts a new sentence at this exact position.
 */
function InsertGap({ onInsert }: { onInsert: () => void }): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onInsert}
      title="在这里插入一句字幕"
      style={{
        height: hover ? 20 : 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'height 0.1s ease',
      }}
    >
      {hover && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--accent)', opacity: 0.45 }} />
          <span
            style={{
              flexShrink: 0,
              width: 18,
              height: 18,
              borderRadius: 9,
              background: 'var(--accent)',
              color: '#fff',
              fontSize: 13,
              lineHeight: '18px',
              textAlign: 'center',
            }}
          >
            +
          </span>
          <div style={{ flex: 1, height: 1, background: 'var(--accent)', opacity: 0.45 }} />
        </div>
      )}
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

/** Global subtitle-look controls for the 通用 template (spec.subtitleStyle). */
function SimpleStyleBar({
  value,
  onChange,
}: {
  value: SimpleSubtitleStyle;
  onChange: (next: SimpleSubtitleStyle) => void;
}): JSX.Element {
  const patch = (p: Partial<SimpleSubtitleStyle>): void => onChange({ ...value, ...p });
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 10,
        rowGap: 6,
        padding: 8,
        background: '#181820',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
      }}
    >
      <Field label="位置">
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={Math.round(value.positionFromBottom * 100)}
          onChange={(e) => patch({ positionFromBottom: Number(e.target.value) / 100 })}
          style={{ width: 90, accentColor: 'var(--accent)' }}
        />
        <span style={{ fontSize: 10, color: 'var(--text3)', width: 30 }}>
          {Math.round(value.positionFromBottom * 100)}%
        </span>
      </Field>
      <Field label="字号">
        <NumInput
          value={value.size}
          min={24}
          max={140}
          step={1}
          onCommit={(n) => patch({ size: n })}
        />
      </Field>
      <Field label="字色">
        <input
          type="color"
          value={value.color}
          onChange={(e) => patch({ color: e.target.value })}
          style={colorInput}
        />
      </Field>
      <Field label="描边色">
        <input
          type="color"
          value={value.outlineColor}
          onChange={(e) => patch({ outlineColor: e.target.value })}
          style={colorInput}
        />
      </Field>
      <Field label="描边粗">
        <NumInput
          value={value.outlineWidth}
          min={0}
          max={16}
          step={0.5}
          onCommit={(n) => patch({ outlineWidth: n })}
        />
      </Field>
    </div>
  );
}

/**
 * Number input that allows SMOOTH typing past a min/max. The naive
 * `value={n}` + `onChange={clamp}` clamps on every keystroke, so with min=24
 * typing "50" snaps "5"→24 and you can never reach 50. Instead we hold a local
 * draft string while focused (free typing, no clamp) and only parse+clamp on
 * blur / Enter. Escape discards the edit.
 */
function NumInput({
  value,
  min,
  max,
  step = 1,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (n: number) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = (): void => {
    if (draft === null) return;
    const n = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(n)) onCommit(clampNum(n, min, max));
  };
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          e.currentTarget.blur();
        }
      }}
      style={numInput}
    />
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text2)' }}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

const numInput: React.CSSProperties = {
  width: 52,
  fontSize: 12,
  padding: '2px 4px',
  background: '#0f0f14',
  color: 'var(--text1)',
  border: '1px solid #333',
  borderRadius: 4,
};
const colorInput: React.CSSProperties = {
  width: 28,
  height: 22,
  padding: 0,
  border: '1px solid #333',
  borderRadius: 3,
  background: 'transparent',
  cursor: 'pointer',
};

interface CueCardProps {
  cue: SpecCue;
  active: boolean;
  onSeek: () => void;
  onText: (text: string) => void;
  onStyle: (style: SpecCueStyle) => void;
  onHighlight: (highlight: string[]) => void;
  onSegments: (segments: string[]) => void;
  onDelete: () => void;
}

function CueCard({
  cue,
  active,
  onSeek,
  onText,
  onStyle,
  onHighlight,
  onSegments,
  onDelete,
}: CueCardProps): JSX.Element {
  return (
    <div
      onClick={onSeek}
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
          onFocus={onSeek}
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
        {/* Delete this line — for trimming the occasional over-captured /
            duplicate sentence. stopPropagation so it doesn't also seek. */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除这一句字幕"
          style={{
            flexShrink: 0,
            width: 24,
            height: 24,
            fontSize: 13,
            lineHeight: 1,
            padding: 0,
            background: 'transparent',
            color: '#ff6b6b',
            border: '1px solid #3a2a2a',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ✕
        </button>
      </div>

      {/* 通用 (simple) cues: no style picker — every line is the same
          treatment, the user just marks keywords. 商务讲解 cues: full
          5-style picker + style-specific fields. */}
      {cue.style === 'simple' ? (
        <KeywordEditor
          text={cue.text}
          highlight={cue.highlight ?? []}
          onChange={onHighlight}
        />
      ) : (
        <>
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
        </>
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
