/**
 * One subtitle row in the 字幕 tab — replaces the old PackagingMicroEditor
 * popup with an inline, always-visible card per transcript segment.
 *
 * Each card:
 *   - Variant-time timestamp (click → seek video there)
 *   - Token chips for the segment text — click a chip to toggle that
 *     word's highlight (color cycles: off → AI default yellow → custom)
 *   - Color picker for the whole line's text color
 *   - Reset button when the line has any override
 *
 * Everything edits a draft PackagingPlan that's bubbled up to the parent
 * via onChange. The parent debounces saves to setPackagingPlan IPC.
 */
import type { PackagingPlan, PackagingSegment, WordEffect } from '@lynlens/core';

interface Props {
  /** Index of this transcript segment in transcript.segments[]. */
  segmentIdx: number;
  /** Display label for the timestamp (variant-time mm:ss). */
  timeLabel: string;
  /** The transcript segment's text. */
  text: string;
  /** Currently-active recipe from the plan (or undefined if no overrides). */
  recipe: PackagingSegment | undefined;
  /** Resolved default subtitle color (from plan.defaults.subtitle or fallback). */
  defaultColor: string;
  /** True when the playhead is currently inside this segment. */
  active: boolean;
  /** Click on timestamp / card → seek the player. */
  onSeek: () => void;
  /** Apply a recipe mutation; parent merges into the plan. */
  onChange: (segmentIdx: number, mutator: (s: PackagingSegment) => PackagingSegment) => void;
}

/** Default highlight color when user toggles a token "on" with no prior. */
const DEFAULT_HIGHLIGHT = '#ffd700';

export function PackagingSegmentCard({
  segmentIdx,
  timeLabel,
  text,
  recipe,
  defaultColor,
  active,
  onSeek,
  onChange,
}: Props): JSX.Element {
  // Token split must match PackagingSubtitleOverlay and ass-generator
  // (whitespace split, CJK with no spaces → one token).
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const wordEffects: WordEffect[] = recipe?.subtitle?.wordEffects ?? [];
  const effByIdx = new Map<number, WordEffect>();
  wordEffects.forEach((w) => effByIdx.set(w.wordIdx, w));

  // Whole-line color comes from project default. Per-segment color
  // overrides are no longer honored (render-side filter); the picker
  // is gone too — only the keyword chip colors are user-editable here.
  const lineColor = defaultColor;
  const hasOverrides = (recipe?.subtitle?.wordEffects?.length ?? 0) > 0;

  function toggleWord(wordIdx: number): void {
    onChange(segmentIdx, (s) => {
      const existing = s.subtitle?.wordEffects ?? [];
      const hit = existing.find((w) => w.wordIdx === wordIdx);
      let nextEffects: WordEffect[];
      if (hit) {
        // Already highlighted → remove it (toggle off).
        nextEffects = existing.filter((w) => w.wordIdx !== wordIdx);
      } else {
        nextEffects = [...existing, { wordIdx, highlight: DEFAULT_HIGHLIGHT }];
      }
      return {
        ...s,
        subtitle: {
          ...(s.subtitle ?? {}),
          wordEffects: nextEffects.length > 0 ? nextEffects : undefined,
        },
      };
    });
  }

  function setWordColor(wordIdx: number, color: string): void {
    onChange(segmentIdx, (s) => {
      const existing = s.subtitle?.wordEffects ?? [];
      const next = existing.map((w) =>
        w.wordIdx === wordIdx ? { ...w, highlight: color } : w
      );
      return {
        ...s,
        subtitle: { ...(s.subtitle ?? {}), wordEffects: next },
      };
    });
  }

  function resetLine(): void {
    onChange(segmentIdx, (s) => {
      // Clear subtitle but keep camera + other future fields.
      const { subtitle: _ignored, ...rest } = s;
      return rest;
    });
  }

  return (
    <div
      style={{
        padding: '10px 12px',
        background: active ? 'rgba(122, 162, 247, 0.15)' : '#181820',
        border: `1px solid ${active ? 'rgba(122, 162, 247, 0.6)' : '#2a2a2a'}`,
        borderRadius: 6,
        marginBottom: 8,
        transition: 'background 0.15s, border-color 0.15s',
      }}
    >
      {/* Header row: timestamp + reset */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
          fontSize: 11,
          color: 'var(--text2)',
        }}
      >
        <button
          onClick={onSeek}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            padding: 0,
            fontVariantNumeric: 'tabular-nums',
            fontSize: 11,
          }}
          title="跳到这段"
        >
          ▶ {timeLabel}
        </button>
        <span style={{ flex: 1, color: 'var(--text3)' }}>段 #{segmentIdx}</span>
        {hasOverrides && (
          <button
            onClick={resetLine}
            style={{
              fontSize: 10,
              padding: '2px 6px',
              background: 'transparent',
              color: 'var(--text3)',
              border: '1px solid #333',
              borderRadius: 3,
              cursor: 'pointer',
            }}
            title="清除此段的所有样式覆写"
          >
            ↺ 重置
          </button>
        )}
      </div>

      {/* Token chips — click to toggle highlight on/off */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          marginBottom: 8,
          lineHeight: 1.6,
        }}
      >
        {tokens.map((tok, i) => {
          const eff = effByIdx.get(i);
          const isHi = !!eff;
          return (
            <button
              key={i}
              onClick={() => toggleWord(i)}
              style={{
                padding: '4px 8px',
                fontSize: 14,
                background: isHi
                  ? `${eff?.highlight ?? DEFAULT_HIGHLIGHT}22`
                  : 'transparent',
                color: isHi ? eff?.highlight ?? DEFAULT_HIGHLIGHT : lineColor,
                border: `1px solid ${isHi ? eff?.highlight ?? DEFAULT_HIGHLIGHT : '#333'}`,
                borderRadius: 4,
                cursor: 'pointer',
                fontWeight: isHi ? 700 : 400,
              }}
              title={isHi ? '点击取消高亮' : '点击高亮(花字)'}
            >
              {tok}
            </button>
          );
        })}
      </div>

      {/* Per-keyword color tweaks only. Whole-line color sits in
          "默认样式" at the top of the 字幕 tab — applies project-wide
          so adjacent segments stay visually consistent. */}
      {wordEffects.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 10,
            fontSize: 11,
            color: 'var(--text2)',
          }}
        >
          {wordEffects.map((w) => (
            <label
              key={w.wordIdx}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              「{tokens[w.wordIdx]?.slice(0, 6) ?? '?'}」
              <input
                type="color"
                value={w.highlight ?? DEFAULT_HIGHLIGHT}
                onChange={(e) => setWordColor(w.wordIdx, e.target.value)}
                style={{
                  width: 26,
                  height: 22,
                  padding: 0,
                  border: '1px solid #333',
                  borderRadius: 3,
                  cursor: 'pointer',
                  background: 'transparent',
                }}
                title="改这个关键词的颜色"
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-export type so the parent can use the same mutator signature. */
export type { PackagingPlan };
