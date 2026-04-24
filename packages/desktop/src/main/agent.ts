/**
 * In-process Claude agent wired directly to the local LynLens engine.
 *
 * Exposes the engine as an "SDK MCP server" that lives in the Electron
 * main process. Tool definitions come from `./agent-tools/` — shared
 * with `mcp-http-server.ts` (Codex path) so we register the same 46
 * tools from ONE source of truth.
 *
 * Also hosts two one-shot entry points used by non-chat flows:
 *   - runHighlightGeneration: single-turn prompt, text out
 *   - runCopywriterForPlatform: same shape, platform-specialised
 */

import {
  buildCopywriterSystemPrompt,
  buildCopywriterUserPrompt,
  parseCopywriterResponse,
  type CopywriterGenerateInput,
  type LynLensEngine,
  type SocialCopy,
} from '@lynlens/core';
import { ALL_TOOLS } from './agent-tools';

// Lazy-load the ESM-only Claude SDK. Static `import` would compile to
// `require()` in CJS, which is rejected at runtime (ERR_REQUIRE_ESM).
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<AgentSdk> | null = null;
function loadSdk(): Promise<AgentSdk> {
  if (!sdkPromise) {
     
    sdkPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<AgentSdk>)(
      '@anthropic-ai/claude-agent-sdk'
    );
  }
  return sdkPromise;
}

/**
 * Events forwarded to the renderer so the chat panel can render streaming
 * content and tool activity.
 */
export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_complete' }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'thinking'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/**
 * Build the SDK MCP server by iterating our shared ALL_TOOLS list. Each
 * tool def gives us name/description/schema/handler — we hand those to
 * Claude's `tool()` helper and capture the engine in a closure so the
 * handler can mutate shared project state.
 */
async function buildLynLensSdkServer(engine: LynLensEngine) {
  const { createSdkMcpServer, tool } = await loadSdk();
  return createSdkMcpServer({
    name: 'lynlens-inproc',
    version: '0.1.0',
    // Cast through `any` on the handler's return — Claude SDK's tool()
    // has a slightly richer content union than our ToolResult (audio /
    // image content types we don't use). The shape is a structural
    // subset, so the cast is safe at runtime.
    tools: ALL_TOOLS.map((def) =>
      tool(
        def.name,
        def.description,
        def.schema,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        async (args) => (await def.handler(args, engine)) as any
      )
    ),
  });
}

export interface AgentOptions {
  projectId: string;
  message: string;
  /** If present, resume an existing conversation so Claude keeps context. */
  resumeSessionId?: string;
  signal?: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
}

export interface AgentResult {
  /** The SDK session_id we can pass back next turn to continue the chat. */
  sessionId: string | null;
}

const SYSTEM_PROMPT = `
你是 LynLens 的内置剪辑助手,专门帮用户剪口播视频并审校字幕。用户会在打开的项目里直接看到你的操作。

核心原则:
- 永远先调 get_project_state 看当前视频信息、已有段、字幕状态、高光变体。
- 默认用 L2 模式(pending 待审),让用户最后决定;除非用户明确说"全部自动"。
- 回答简洁,用中文。抓重点(总段数、风险、建议)即可,不要大段列出所有段落。
- 只做剪辑和字幕相关的操作,不要乱走。

**项目 ID 使用规则(极重要):**
- 本消息末尾会告诉你"当前项目 ID",所有工具调用都用这个,不要改、不要猜。
- 不要从任何工具返回的文件路径、会话 ID、错误消息里抽取 UUID 当项目 ID 用 —— 那些不是。
- 如果某次工具报 "Project not found",100% 是你用错 ID 了,立刻回到系统提示末尾的正确 ID。

你只能用 lynlens 开头的工具,没有文件读写、没有网络、没有 shell。想做的事用不了工具,就直接告诉用户,不要反复尝试。

删除段标记:
- ai_mark_silence 标停顿/语气词/重复;手动 add_segments 用于特殊情况。
- 每段都要给清楚的 reason(停顿 N 秒 / 语气词「嗯」 / 重拍 等)。

字幕审校(用户明确要求时才做):
- 先 get_project_state 看 transcript.segments。
- 默认用 **suggest_transcript_fix** 对可疑段提出建议 — UI 会显示"✓接受/✗忽略"让用户决定。
- replace_in_transcript 只在用户明确说"全局替换 X 为 Y"时用。
- update_transcript_segment 只用于机械错误。
- 做完后,简短汇报你标了几段建议、理由是什么,让用户去 UI 审核。

高光变体微调(用户说"第 3 段前移 2 秒"/"去掉第 1 段"/"把最后一段挪前面"/"改一下那段描述"这类话时):
- 先 get_project_state 或 get_highlights 看每个 variant 的 id 和 segments[idx].start/end/reason。
- 调对应工具:
  * update_highlight_variant_segment — 改某段的起止或描述
  * add_highlight_variant_segment — 加新段
  * delete_highlight_variant_segment — 删段
  * reorder_highlight_variant_segment — 换顺序
- 所有时间都是 **source 秒**(从视频头算)。用户用 "2:30" 这种人读格式,自己换算成秒。
- 每步改完都简短汇报做了什么,别一口气改 10 处还不说。改错了用户会立刻说"撤销"。

说话人、文案、导出 —— 同类思路:先 get_project_state 看 ids,再调对应工具;outputPath 要绝对路径,用户没给就先问。
`.trim();

/**
 * Kick off an agent query. Streaming output flows through onEvent.
 * Resolves when the agent is fully done (or throws on fatal error).
 */
export async function runAgent(
  engine: LynLensEngine,
  options: AgentOptions
): Promise<AgentResult> {
  const { projectId, message, resumeSessionId, signal, onEvent } = options;
  const { query } = await loadSdk();
  const sdkServer = await buildLynLensSdkServer(engine);

  // Allow-list exactly the tools we registered, prefixed with the MCP
  // server namespace. Derived from ALL_TOOLS so adding a tool in the
  // shared registry auto-flows to the allow-list — no more forgetting
  // to edit two places.
  const ALLOWED_TOOLS = ALL_TOOLS.map((t) => `mcp__lynlens__${t.name}`);

  const queryOptions: Record<string, unknown> = {
    systemPrompt: SYSTEM_PROMPT + `\n\n当前项目 ID: ${projectId}`,
    maxTurns: 20,
    permissionMode: 'bypassPermissions' as const,
    // Empty `tools` array disables ALL Claude Code built-in tools
    // (Bash/Read/Grep/Glob/Edit/Write/Task/Monitor/ToolSearch/TodoWrite/etc.)
    // Only the MCP tools registered below remain callable.
    tools: [] as string[],
    allowedTools: ALLOWED_TOOLS,
    settingSources: [] as never[],
    mcpServers: {
      lynlens: sdkServer,
    },
    abortController: signal ? asAbortController(signal) : undefined,
    stderr: (data: string) => {
       
      console.error('[claude-code-stderr]', data);
    },
  };
  if (resumeSessionId) queryOptions.resume = resumeSessionId;

  let sessionId: string | null = resumeSessionId ?? null;
  // Per-run de-dupe: the SDK can emit the same assistant / user message
  // twice (partial + final, or retries), which would otherwise surface
  // as duplicate tool chips in the chat UI.
  const seenUuids = new Set<string>();

  try {
    for await (const msg of query({
      prompt: message,
      options: queryOptions as Parameters<typeof query>[0]['options'],
    })) {
      handleSdkMessage(msg, onEvent, seenUuids);
      // Capture session_id from any message that carries one so we can
      // resume next turn.
      const anyMsg = msg as unknown as { session_id?: string };
      if (anyMsg.session_id) sessionId = anyMsg.session_id;
    }
    onEvent({ type: 'done' });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      onEvent({ type: 'done' });
    } else {
      onEvent({ type: 'error', message: (err as Error).message });
    }
  }
  return { sessionId };
}

function asAbortController(signal: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

function handleSdkMessage(
  msg: unknown,
  onEvent: (e: AgentEvent) => void,
  seenUuids: Set<string>
): void {
  // The SDK streams multiple message types. We only care about:
  //  - assistant text (for the chat bubble)
  //  - tool_use blocks (for the "called X" chip)
  //  - tool_result blocks (to confirm success / show error)
  const anyMsg = msg as unknown as {
    type: string;
    uuid?: string;
    message?: {
      id?: string;
      content?: Array<{
        type: string;
        text?: string;
        name?: string;
        input?: Record<string, unknown>;
        tool_use_id?: string;
        content?: unknown;
        is_error?: boolean;
      }>;
    };
    subtype?: string;
  };

  // Skip any assistant/user message we have already processed.
  if (anyMsg.type === 'assistant' || anyMsg.type === 'user') {
    const id = anyMsg.uuid ?? anyMsg.message?.id;
    if (id) {
      if (seenUuids.has(id)) return;
      seenUuids.add(id);
    }
  }

  if (anyMsg.type === 'assistant' && anyMsg.message?.content) {
    for (const block of anyMsg.message.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        onEvent({ type: 'text_delta', text: block.text });
      } else if (block.type === 'thinking' && typeof block.text === 'string') {
        onEvent({ type: 'thinking', text: block.text });
      } else if (block.type === 'tool_use') {
        onEvent({
          type: 'tool_use',
          name: String(block.name ?? ''),
          input: block.input ?? {},
        });
      }
    }
    onEvent({ type: 'text_complete' });
  } else if (anyMsg.type === 'user' && anyMsg.message?.content) {
    // tool_result messages come wrapped as user messages
    for (const block of anyMsg.message.content) {
      if (block.type === 'tool_result') {
        const c = block.content;
        const txt =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c
                  .map((p: { type: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : ''))
                  .join('')
              : JSON.stringify(c);
        onEvent({
          type: 'tool_result',
          name: '',
          ok: !block.is_error,
          summary: txt.slice(0, 500),
        });
      }
    }
  }
}

/**
 * One-shot highlight generation. Deliberately separate from runAgent —
 * no tool use, no multi-turn, just "give the prompt, get text back".
 * The MCP HTTP server uses this too (via agent-dispatcher) so both
 * Claude and Codex paths share the same orchestration.
 */
export interface HighlightGenerationOptions {
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}

export async function runHighlightGeneration(
  opts: HighlightGenerationOptions
): Promise<{ text: string; model?: string }> {
  const { query } = await loadSdk();
  const queryOptions: Record<string, unknown> = {
    systemPrompt: opts.systemPrompt,
    maxTurns: 1,
    permissionMode: 'bypassPermissions' as const,
    tools: [] as string[],
    allowedTools: [] as string[],
    settingSources: [] as never[],
    abortController: opts.signal ? asAbortController(opts.signal) : undefined,
    stderr: (data: string) => {
       
      console.error('[highlight-gen-stderr]', data);
    },
  };

  let collected = '';
  let modelSeen: string | undefined;

  for await (const msg of query({
    prompt: opts.userPrompt,
    options: queryOptions as Parameters<typeof query>[0]['options'],
  })) {
    const anyMsg = msg as unknown as {
      type?: string;
      message?: { content?: Array<{ type?: string; text?: string }>; model?: string };
    };
    if (anyMsg.type === 'assistant' && anyMsg.message?.content) {
      if (anyMsg.message.model && !modelSeen) modelSeen = anyMsg.message.model;
      for (const block of anyMsg.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          collected += block.text;
        }
      }
    }
  }

  if (!collected.trim()) {
    throw new Error('Model returned no text output');
  }
  return { text: collected, model: modelSeen };
}

/** One-shot copywriter call for a single platform. */
export async function runCopywriterForPlatform(
  input: CopywriterGenerateInput,
  signal?: AbortSignal
): Promise<{ copy: SocialCopy; model?: string }> {
  const systemPrompt = buildCopywriterSystemPrompt(input.platform);
  const userPrompt = buildCopywriterUserPrompt(input);
  const { text, model } = await runHighlightGeneration({
    systemPrompt,
    userPrompt,
    signal,
  });
  const copy = parseCopywriterResponse(text, input.platform);
  return { copy, model };
}
