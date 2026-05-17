/**
 * 画面 tab — placeholder for v0.6+ camera controls (zoom / focus / Ken Burns).
 *
 * The schema already supports `camera.zoom` + `focus` per segment (see
 * PackagingPlan.segments[].camera), but the v0.5 renderer ignores them
 * because preview is HTML overlay + the export uses a precise trim+concat
 * pipeline. Once we have a static "punch in" preview filter, this tab
 * will expose per-segment zoom + focus controls similar to 字幕.
 */
export function PackagingCameraTab(): JSX.Element {
  return (
    <div
      style={{
        padding: 24,
        textAlign: 'center',
        color: 'var(--text3)',
        fontSize: 12,
        lineHeight: 1.7,
      }}
    >
      <div style={{ fontSize: 32, marginBottom: 8 }}>🎥</div>
      <div style={{ color: 'var(--text2)', marginBottom: 6 }}>画面节奏</div>
      v0.6+ 会加这些:
      <br />
      · 每段画面 zoom (1.0–1.5x)
      <br />
      · 关键段 focus 点 (放大人脸 / 道具)
      <br />
      · Ken Burns 缓动 (zoom-in / zoom-out)
      <br />
      <br />
      <span style={{ color: 'var(--text3)' }}>v0.5 暂时只做字幕花字。</span>
    </div>
  );
}
