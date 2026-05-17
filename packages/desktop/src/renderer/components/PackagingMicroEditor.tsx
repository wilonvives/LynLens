/**
 * Minimal micro-edit panel for v0.5 packaging plans.
 *
 * Scope (per the user's "先简单做" directive): only the 2 most-tweaked
 * settings — per-segment subtitle color + camera zoom. Full font / size /
 * position / animation panel is v0.6+.
 *
 * Surfaced as a modal sidebar from the highlight tab header's ⚙ button.
 * Changes are applied to a local draft plan; clicking 「保存」 sends the
 * draft back via `set-packaging-plan` IPC and closes. 「取消」 discards.
 *
 * AI-friendly counterpart: the agent can directly call set_packaging_plan
 * (or generate_packaging_plan with overrides) to achieve the same effect.
 */
import { useState } from 'react';
import type { PackagingPlan, PackagingSegment } from '@lynlens/core';

interface Props {
  plan: PackagingPlan;
  /** Variant segments for context (idx → text label). */
  segmentLabels: Array<{ idx: number; text: string }>;
  onSave: (next: PackagingPlan) => void;
  onCancel: () => void;
}

export function PackagingMicroEditor({
  plan,
  segmentLabels,
  onSave,
  onCancel,
}: Props): JSX.Element {
  const [draft, setDraft] = useState<PackagingPlan>(plan);

  // Helper: produce a new PackagingPlan with one segment replaced (or
  // added). Centralises the immutable update so the inline handlers stay
  // small.
  function upsertSegment(
    segmentIdx: number,
    mutator: (s: PackagingSegment) => PackagingSegment
  ): void {
    setDraft((prev) => {
      const existing = prev.segments.find((s) => s.segmentIdx === segmentIdx);
      const base: PackagingSegment = existing ?? { segmentIdx };
      const next = mutator(base);
      const others = prev.segments.filter((s) => s.segmentIdx !== segmentIdx);
      return {
        ...prev,
        segments: [...others, next].sort((a, b) => a.segmentIdx - b.segmentIdx),
      };
    });
  }

  return (
    <div className="dialog-backdrop" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="dialog" style={{ minWidth: 520, maxHeight: '85vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <h3>包装方案微调</h3>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 12, lineHeight: 1.6 }}>
          只展示 AI 方案里有特殊处理的段(其他段用默认样式)。
          想恢复整段默认 → 把字幕颜色设回 #ffffff、zoom 设回 1.0。
        </div>

        <div style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {draft.segments.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text3)' }}>
              AI 方案里没有特殊处理的段 — 整片都用默认样式。
            </div>
          )}
          {draft.segments.map((seg) => {
            const label = segmentLabels.find((l) => l.idx === seg.segmentIdx);
            const subColor = seg.subtitle?.color ?? draft.defaults.subtitle?.color ?? '#ffffff';
            const zoom = seg.camera?.zoom ?? 1.0;
            const firstWordHighlight =
              seg.subtitle?.wordEffects?.[0]?.highlight ?? '#ffd700';

            return (
              <div
                key={seg.segmentIdx}
                style={{
                  border: '1px solid #2a2a2a',
                  borderRadius: 6,
                  padding: 12,
                  background: '#181820',
                }}
              >
                <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 8 }}>
                  段 #{seg.segmentIdx}
                  {label && (
                    <span style={{ marginLeft: 8, color: 'var(--text3)' }}>
                      {label.text.slice(0, 30)}
                      {label.text.length > 30 ? '…' : ''}
                    </span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <label>字幕颜色</label>
                  <input
                    type="color"
                    value={subColor}
                    onChange={(e) => {
                      const color = e.target.value;
                      upsertSegment(seg.segmentIdx, (s) => ({
                        ...s,
                        subtitle: { ...(s.subtitle ?? {}), color },
                      }));
                    }}
                    style={{ width: 60, height: 24, padding: 0, border: 'none', cursor: 'pointer' }}
                  />

                  <label>关键词颜色</label>
                  <input
                    type="color"
                    value={firstWordHighlight}
                    onChange={(e) => {
                      const color = e.target.value;
                      upsertSegment(seg.segmentIdx, (s) => {
                        const existing = s.subtitle?.wordEffects ?? [];
                        if (existing.length === 0) {
                          // No word effects yet — can't apply per-word color
                          // without knowing which word. v0.6 microedit will
                          // allow selecting a word. For now we no-op here.
                          return s;
                        }
                        return {
                          ...s,
                          subtitle: {
                            ...(s.subtitle ?? {}),
                            wordEffects: existing.map((w) => ({
                              ...w,
                              highlight: color,
                            })),
                          },
                        };
                      });
                    }}
                    style={{ width: 60, height: 24, padding: 0, border: 'none', cursor: 'pointer' }}
                    disabled={(seg.subtitle?.wordEffects?.length ?? 0) === 0}
                    title={
                      (seg.subtitle?.wordEffects?.length ?? 0) === 0
                        ? '此段没有关键词高亮 (AI 没挑出关键词)'
                        : '改所有关键词颜色'
                    }
                  />

                  <label>画面 zoom</label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <input
                      type="range"
                      min={1.0}
                      max={2.0}
                      step={0.05}
                      value={zoom}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        upsertSegment(seg.segmentIdx, (s) => ({
                          ...s,
                          camera: { ...(s.camera ?? {}), zoom: v },
                        }));
                      }}
                      style={{ flex: 1 }}
                    />
                    <span style={{ minWidth: 40, fontVariantNumeric: 'tabular-nums' }}>
                      {zoom.toFixed(2)}x
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="dialog-actions" style={{ marginTop: 16 }}>
          <button onClick={onCancel}>取消</button>
          <button className="primary" onClick={() => onSave(draft)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
