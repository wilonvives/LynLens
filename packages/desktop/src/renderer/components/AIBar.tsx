import { useStore } from '../store';

interface AIBarProps {
  /** Has the user got a long-running diarization in progress? */
  diarizing: boolean;
  /** Open the orientation + speaker-count dialog (then transcription). */
  onOpenOrientDialog: () => void;
  /** Open the quick-mark threshold dialog. */
  onOpenQuickMarkDialog: () => void;
}

/**
 * Top action bar for the precision tab. Shows:
 *   - AI status indicator (idle / transcribing / error)
 *   - L2 / L3 mode toggle (manual review vs full-auto)
 *   - 字幕转录 (combined transcription + diarization entry point)
 *   - 快速标记 (silence / filler / retake auto-marker dialog)
 *
 * The transcription button is the merged "字幕 + 说话人" pipeline: clicking
 * it opens a single dialog that asks for orientation + speaker count, then
 * runs both passes back-to-back. Pre-selecting count up front is the single
 * biggest lever for good diarization, so we never skip this step.
 */
export function AIBar({ diarizing, onOpenOrientDialog, onOpenQuickMarkDialog }: AIBarProps): JSX.Element {
  const store = useStore();
  const aiStatusClass =
    store.aiStatus === 'transcribing' ? 'working' : store.aiStatus === 'error' ? 'error' : 'ready';

  return (
    <div className="ai-bar">
      <span>
        <span className={`status-dot ${aiStatusClass}`} />
        AI 状态:{' '}
        {store.aiStatus === 'idle'
          ? '就绪'
          : store.aiStatus === 'transcribing'
            ? '转录中'
            : '错误'}
      </span>
      <span>AI 模式:</span>
      <div className="mode-switch">
        <button
          className={store.aiMode === 'L2' ? 'active' : ''}
          onClick={() => store.setAiMode('L2')}
          title="L2: AI 标记进入待审核状态，你逐条批准"
        >
          审核
        </button>
        <button
          className={store.aiMode === 'L3' ? 'active' : ''}
          onClick={() => {
            if (
              confirm(
                '启用自动模式? AI 标记将直接生效、可自动导出。建议仅在日常批处理且信任 AI 的场景使用。'
              )
            ) {
              store.setAiMode('L3');
            }
          }}
          title="L3: AI 标记直接生效,跳过人工审核"
        >
          自动
        </button>
      </div>
      <div style={{ flex: 1 }} />
      <button
        className="ai"
        disabled={!store.projectId || store.aiStatus === 'transcribing' || diarizing}
        onClick={() => {
          if (!store.projectId) return;
          onOpenOrientDialog();
        }}
        title="生成字幕 + 按声纹区分说话人,一步完成"
      >
        {store.aiStatus === 'transcribing'
          ? `转录中 ${Math.round(store.transcribeProgress * 100)}%`
          : diarizing
            ? '区分声纹中...'
            : store.transcript
              ? `重新转录 (${store.transcript.segments.length} 段)`
              : '字幕转录'}
      </button>
      {/* 区分说话人 button merged into 字幕转录 above — same dialog, one-click
          pipeline. Chat panel MCP still exposes it separately. */}
      <button
        className="ai"
        disabled={!store.projectId}
        onClick={onOpenQuickMarkDialog}
        title="自动标出停顿 / 语气词 / 重复段 (自选阈值)"
      >
        快速标记
      </button>
    </div>
  );
}
