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

interface Props {
  open: boolean;
  onClose: () => void;
  width?: number;
}

export function ChatPanel({ open, onClose, width }: Props) {
  const projectId = useStore((s) => s.projectId);
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

  // Fetch who we're authenticated as so the header can show it
  useEffect(() => {
    if (!open) return;
    void window.lynlens.agentIdentity().then(setIdentity);
  }, [open]);

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
            cur.text += `\n\n⚠ 出错: ${event.message}`;
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
          text: `⚠ 调用失败: ${(err as Error).message}`,
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
      className="chat-panel"
      style={width ? { flex: `0 0 ${width}px`, width } : undefined}
    >
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-header-title">💬 Anthropic Claude Code</div>
          {identity ? (
            <div className="chat-header-identity" title={`subscription: ${identity.plan ?? '—'}`}>
              <span className="dot" /> Connected as {identity.displayName || identity.email}
              {identity.organization ? ` · ${identity.organization}` : ''}
            </div>
          ) : (
            <div className="chat-header-identity warn">
              <span className="dot warn" /> 未检测到 Claude Code 登录状态
            </div>
          )}
        </div>
        <div className="spacer" />
        <button
          className="chat-close"
          onClick={async () => {
            if (!projectId) return;
            await window.lynlens.agentReset(projectId);
            setMessages([]);
          }}
          title="清空对话记录,开新话题"
        >
          🔄
        </button>
        <button className="chat-close" onClick={onClose} title="关闭">
          ✕
        </button>
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
                {m.toolCalls.map((t, i) => (
                  <div key={i} className={`chat-tool ${t.ok === false ? 'err' : ''}`}>
                    <span className="chat-tool-name">🔧 {prettyToolName(t.name)}</span>
                    {t.result && (
                      <span className="chat-tool-result">
                        {t.ok === false ? '❌ ' : '✓ '}
                        {t.result.slice(0, 120)}
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
