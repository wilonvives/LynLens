import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentEvent } from '../shared/ipc-types';
import { useStore } from './store';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string; ok?: boolean }>;
  streaming?: boolean;
}

/**
 * Quick-reply preset chips above the input. Click fills the textarea (does
 * NOT auto-send) — user can edit / amend before pressing Enter. Keep this
 * list short; > 4 chips wraps awkwardly on the standard chat-panel width.
 *
 * Add new presets only when there's evidence of a recurring user intent
 * that's awkward to type. Random "agent could do this" ideas don't earn
 * a slot.
 */
const CHAT_PRESETS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: '看看能剪几个主题',
    text: '这段素材能剪几个主题方向？每条多少素材、建议多长。',
  },
  {
    label: '检查字幕错别字',
    text: '查字幕稿里的错别字、同音字、人名识别错，列出来等我确认再改。',
  },
];

// Map raw MCP tool names to human-readable Chinese labels for the chat UI.
// Keeps the transcript readable without `mcp__lynlens__` noise.
const TOOL_LABELS: Record<string, string> = {
  'mcp__lynlens__get_project_state': '读取项目状态',
  'mcp__lynlens__transcribe': '生成字幕',
  'mcp__lynlens__ai_mark_silence': '检测停顿与重复',
  'mcp__lynlens__add_segments': '添加删除段',
  'mcp__lynlens__remove_segments': '删除标记段',
  'mcp__lynlens__set_segment_status': '更新段状态',
  'mcp__lynlens__approve_all_pending': '批准全部待审',
  'mcp__lynlens__commit_ripple': '执行剪切',
  'mcp__lynlens__revert_ripple': '撤销剪切',
  'mcp__lynlens__generate_highlights': '生成高光变体',
  'mcp__lynlens__clear_highlights': '清空高光变体',
  'mcp__lynlens__update_highlight_variant_segment': '调整高光段落',
  'mcp__lynlens__add_highlight_variant_segment': '添加高光段落',
  'mcp__lynlens__delete_highlight_variant_segment': '删除高光段落',
  'mcp__lynlens__reorder_highlight_variant_segment': '重排高光段落',
  'mcp__lynlens__reject_segment': '拒绝段',
  'mcp__lynlens__reject_all_pending': '全部拒绝',
  'mcp__lynlens__erase_range': '擦除时间范围',
  'mcp__lynlens__resize_segment': '调整段时间',
  'mcp__lynlens__undo': '撤销',
  'mcp__lynlens__redo': '重做',
  'mcp__lynlens__save_project': '保存工程',
  'mcp__lynlens__accept_transcript_suggestion': '接受字幕建议',
  'mcp__lynlens__clear_transcript_suggestion': '忽略字幕建议',
  'mcp__lynlens__update_transcript_segment_time': '调整字幕时间',
  'mcp__lynlens__get_highlights': '读取高光变体',
  'mcp__lynlens__set_highlight_pinned': '收藏/取消收藏变体',
  'mcp__lynlens__delete_highlight_variant': '删除整个变体',
  'mcp__lynlens__diarize': '识别说话人',
  'mcp__lynlens__rename_speaker': '重命名说话人',
  'mcp__lynlens__merge_speakers': '合并说话人',
  'mcp__lynlens__set_segment_speaker': '改段说话人',
  'mcp__lynlens__auto_assign_unlabeled_speakers': '自动指派说话人',
  'mcp__lynlens__clear_speakers': '清空说话人',
  'mcp__lynlens__get_social_copies': '读取文案',
  'mcp__lynlens__update_social_copy': '更新文案',
  'mcp__lynlens__delete_social_copy': '删除文案',
  'mcp__lynlens__delete_social_copy_set': '删除文案集',
  'mcp__lynlens__set_social_style_note': '设置风格说明',
  'mcp__lynlens__export_final_video': '导出成片',
  'mcp__lynlens__export_highlight_variant': '导出高光变体',
  'mcp__lynlens__generate_social_copies': '生成社群文案',
  'mcp__lynlens__set_mode': '切换 AI 模式',
  'mcp__lynlens__update_transcript_segment': '修改字幕',
  'mcp__lynlens__suggest_transcript_fix': '提交字幕建议',
  'mcp__lynlens__replace_in_transcript': '全局替换字幕',
};

function prettyToolName(raw: string): string {
  if (TOOL_LABELS[raw]) return TOOL_LABELS[raw];
  // Fallback: strip the mcp__<server>__ prefix for any tool we haven't labeled.
  const m = raw.match(/^mcp__[^_]+__(.+)$/);
  return m ? m[1] : raw;
}

interface ToolCallGroup {
  name: string;
  count: number;
  /** Result text from the LAST call in the run — earlier ones dropped. */
  lastResult?: string;
  /** True if ANY call in the run reported an error. */
  anyFailed: boolean;
}

/**
 * Collapse CONSECUTIVE tool-call chips with the same name into a single
 * group — "提交字幕建议 ×16" instead of 16 near-identical cards. Keeps
 * non-consecutive runs separate (AI: get_state → N× suggest → read_state
 * stays readable as three groups). The last call's result is shown so
 * failures surface; a tooltip on hover reveals that it's an aggregate.
 */
function collapseToolCalls(
  calls: Array<{ name: string; result?: string; ok?: boolean }>
): ToolCallGroup[] {
  const groups: ToolCallGroup[] = [];
  for (const t of calls) {
    const last = groups[groups.length - 1];
    if (last && last.name === t.name) {
      last.count += 1;
      if (t.result !== undefined) last.lastResult = t.result;
      if (t.ok === false) last.anyFailed = true;
    } else {
      groups.push({
        name: t.name,
        count: 1,
        lastResult: t.result,
        anyFailed: t.ok === false,
      });
    }
  }
  return groups;
}

interface Props {
  open: boolean;
  onClose: () => void;
  width?: number;
  /**
   * When true the panel fills its parent (used inside the standalone
   * Agent BrowserWindow). Skips the sidebar flex sizing and the close
   * X button (OS window chrome handles closing).
   */
  detached?: boolean;
  /**
   * Override source of truth for the active project. The detached popup
   * has its own zustand store that the editor window doesn't populate,
   * so it provides this via IPC. In-window usage leaves it undefined and
   * falls back to the shared zustand store.
   */
  projectIdOverride?: string | null;
}

export function ChatPanel({ open, onClose, width, detached, projectIdOverride }: Props) {
  const storeProjectId = useStore((s) => s.projectId);
  // Detached popup has its own store — hydrated via IPC by the caller.
  const projectId = projectIdOverride !== undefined ? projectIdOverride : storeProjectId;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const [identity, setIdentity] = useState<{
    email: string;
    displayName: string | null;
    organization: string | null;
    plan: string | null;
  } | null>(null);
  // Which AI backend this chat is talking to. Persisted in main; we sync
  // on open so switching in one app window reflects in another next time.
  const [provider, setProviderState] = useState<'claude' | 'codex'>('claude');
  // Always-on-top state for the detached agent window. Main owns the truth
  // (BrowserWindow.isAlwaysOnTop); we mirror locally for the toggle.
  const [pinned, setPinned] = useState(false);
  useEffect(() => {
    if (!detached) return;
    void window.lynlens.getAgentWindowPinned().then(setPinned);
  }, [detached]);

  // Fetch who we're authenticated as so the header can show it — also
  // refetch whenever the provider changes because each provider has its
  // own login identity source (.claude.json vs .codex/auth.json).
  useEffect(() => {
    if (!open) return;
    void window.lynlens.agentIdentity().then(setIdentity);
  }, [open, provider]);

  // Load current provider from main on open.
  useEffect(() => {
    if (!open) return;
    void window.lynlens.agentGetProvider().then(setProviderState);
  }, [open]);

  async function switchProvider(next: 'claude' | 'codex'): Promise<void> {
    if (next === provider) return;
    await window.lynlens.agentSetProvider(next);
    setProviderState(next);
    // Clear the visible transcript: each provider has its own session
    // memory, so mixing them would be confusing. The user can still scroll
    // back in their head — that's the cost of switching.
    setMessages([]);
  }

  // Subscribe to streaming agent events
  useEffect(() => {
    const off = window.lynlens.onAgentEvent((event: AgentEvent) => {
      setMessages((prev) => {
        // Find the latest streaming assistant message, or create one
        const last = prev[prev.length - 1];
        const needNew = !last || last.role !== 'assistant' || !last.streaming;
        const base = needNew
          ? [...prev, { id: `a_${Date.now()}`, role: 'assistant' as const, text: '', toolCalls: [], streaming: true }]
          : prev.slice();
        const cur = base[base.length - 1];

        switch (event.type) {
          case 'text_delta':
            // Replace with latest text (SDK emits the full accumulated text, not deltas)
            cur.text = event.text;
            break;
          case 'tool_use':
            cur.toolCalls = [...cur.toolCalls, { name: event.name, input: event.input }];
            break;
          case 'tool_result': {
            // Match the last tool call without a result
            const toolIdx = cur.toolCalls.length - 1;
            while (toolIdx >= 0 && cur.toolCalls[toolIdx].result != null) {
              break;
            }
            if (toolIdx >= 0 && cur.toolCalls[toolIdx].result == null) {
              cur.toolCalls = cur.toolCalls.map((t, i) =>
                i === toolIdx ? { ...t, result: event.summary, ok: event.ok } : t
              );
            }
            break;
          }
          case 'thinking':
            // Not displayed separately; could be shown as small italic
            break;
          case 'text_complete':
            // End of one assistant message block
            break;
          case 'done':
            cur.streaming = false;
            setBusy(false);
            break;
          case 'error':
            cur.streaming = false;
            cur.text += `\n\n出错: ${event.message}`;
            setBusy(false);
            break;
        }
        return base;
      });
    });
    return () => off();
  }, []);

  // Auto-scroll on new content
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages]);

  async function send() {
    const trimmed = input.trim();
    if (!trimmed || !projectId || busy) return;
    const userMsg: ChatMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      text: trimmed,
      toolCalls: [],
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setBusy(true);
    try {
      await window.lynlens.agentSend(projectId, trimmed);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'assistant',
          text: `调用失败: ${(err as Error).message}`,
          toolCalls: [],
        },
      ]);
      setBusy(false);
    }
  }

  function cancel() {
    if (projectId) void window.lynlens.agentCancel(projectId);
  }

  const placeholder = useMemo(() => {
    if (!projectId) return '请先打开视频...';
    return '例: 转录之后帮我找停顿和语气词,告诉我计划删哪些段';
  }, [projectId]);

  if (!open) return null;

  return (
    <div
      className={`chat-panel${detached ? ' detached' : ''}`}
      style={detached ? undefined : width ? { flex: `0 0 ${width}px`, width } : undefined}
    >
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-title">
            <select
              className="chat-provider-select"
              value={provider}
              onChange={(e) => void switchProvider(e.target.value as 'claude' | 'codex')}
              title="切换 AI 后端(切换后会清空当前聊天记录)"
            >
              <option value="claude">Claude Code</option>
              <option value="codex">OpenAI Codex</option>
            </select>
          </div>
          {identity ? (
            <div className="chat-header-identity" title={`subscription: ${identity.plan ?? '—'}`}>
              <span className="dot" /> Connected as {identity.displayName || identity.email}
              {identity.organization ? ` · ${identity.organization}` : ''}
            </div>
          ) : (
            <div className="chat-header-identity warn">
              <span className="dot warn" />{' '}
              {provider === 'claude'
                ? '未检测到 Claude Code 登录状态'
                : '未检测到 Codex 登录状态,终端执行 codex login'}
            </div>
          )}
        </div>
        <div className="spacer" />
        {detached && (
          <button
            className={`chat-icon-btn${pinned ? ' active' : ''}`}
            onClick={async () => {
              const next = !pinned;
              await window.lynlens.setAgentWindowPinned(next);
              setPinned(next);
            }}
            title={pinned ? '取消置顶' : '置顶(切到其他软件时也保持在最上层)'}
            aria-label="置顶"
          >
            {/* Pushpin icon — filled = pinned, outline = not pinned */}
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              {pinned ? (
                <path
                  d="M10.5 1.5L14.5 5.5L12 8L13 12L11.5 13.5L7.5 9.5L4 13H3V12L6.5 8.5L2.5 4.5L4 3L8 4L10.5 1.5Z"
                  fill="currentColor"
                />
              ) : (
                <path
                  d="M10.5 1.5L14.5 5.5L12 8L13 12L11.5 13.5L7.5 9.5L4 13H3V12L6.5 8.5L2.5 4.5L4 3L8 4L10.5 1.5Z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
        )}
        <button
          className="chat-icon-btn"
          onClick={async () => {
            if (!projectId) return;
            await window.lynlens.agentReset(projectId);
            setMessages([]);
          }}
          title="清空对话记录,开新话题"
          aria-label="刷新对话"
        >
          {/* Refresh / reload icon */}
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.5a5.5 5.5 0 014.95 3.1M13.5 3v3h-3M8 13.5a5.5 5.5 0 01-4.95-3.1M2.5 13v-3h3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        {!detached && (
          <button className="chat-icon-btn" onClick={onClose} title="关闭" aria-label="关闭">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M3 3l8 8M11 3l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="chat-list" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-hint">
            我会用本地 whisper + AI 帮你转录、标记、审核和导出。<br />
            所有改动会实时出现在时间轴上，你直接审核。<br />
            <br />
            试试："转录后找出所有停顿和语气词,告诉我计划删哪些段"
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg chat-msg-${m.role}`}>
            {m.role === 'user' ? (
              <div className="chat-bubble user">{m.text}</div>
            ) : (
              <div className="chat-bubble assistant">
                {collapseToolCalls(m.toolCalls).map((g, i) => (
                  <div
                    key={i}
                    className={`chat-tool ${g.anyFailed ? 'err' : ''}`}
                    title={g.count > 1 ? `${g.count} 次调用 — 最后一次: ${g.lastResult ?? ''}` : undefined}
                  >
                    <span className="chat-tool-name">
                      {prettyToolName(g.name)}
                      {g.count > 1 && <span className="chat-tool-count"> ×{g.count}</span>}
                    </span>
                    {g.lastResult && (
                      <span className="chat-tool-result">
                        {g.anyFailed ? '失败: ' : '完成: '}
                        {g.lastResult.slice(0, 120)}
                      </span>
                    )}
                  </div>
                ))}
                {m.text && <div className="chat-text">{m.text}</div>}
                {m.streaming && <div className="chat-dots">● ● ●</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="chat-presets">
        {CHAT_PRESETS.map((p) => (
          <button
            key={p.label}
            className="chat-preset"
            onClick={() => setInput(p.text)}
            disabled={!projectId}
            title={p.text}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="chat-input-wrap">
        <textarea
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={placeholder}
          disabled={!projectId}
          rows={2}
        />
        {busy ? (
          <button className="chat-send cancel" onClick={cancel}>
            停止
          </button>
        ) : (
          <button className="chat-send" onClick={send} disabled={!projectId || !input.trim()}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
