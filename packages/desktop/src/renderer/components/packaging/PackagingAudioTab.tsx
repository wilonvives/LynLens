/**
 * 声音 tab — placeholder for v0.6+ audio controls.
 *
 * Per 开拍's 声音 tab: 视频音量 slider + 降噪 toggle. The denoise model
 * would call into the same Whisper-adjacent processing pipeline; for now
 * this is a stub so the tab strip looks complete.
 */
export function PackagingAudioTab(): JSX.Element {
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
      <div style={{ fontSize: 32, marginBottom: 8 }}>🔊</div>
      <div style={{ color: 'var(--text2)', marginBottom: 6 }}>音频处理</div>
      v0.6+ 会加这些:
      <br />
      · 视频音量调节
      <br />
      · 人声降噪 (rnnoise / 类似)
      <br />
      · 自动响度归一化 (-16 LUFS, YouTube 标准)
      <br />
      <br />
      <span style={{ color: 'var(--text3)' }}>v0.5 默认透传源音轨。</span>
    </div>
  );
}
