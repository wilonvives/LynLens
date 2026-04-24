/**
 * Codex (OpenAI) agent wrapper — mirrors the public surface of agent.ts so
 * the dispatcher can swap between providers without the callers knowing.
 *
 * Architecture:
 *   Codex CLI does NOT support in-process tool registration (unlike Claude's
 *   createSdkMcpServer). So we boot an HTTP MCP server elsewhere in main
 *   (see mcp-http-server.ts) and point Codex at it via `config.mcp_servers`.
 *   The `CodexContext` struct carries the URL + bearer token.
 *
 * Auth:
 *   @openai/codex-sdk spawns the bundled codex binary, which reads
 *   ~/.codex/auth.json for ChatGPT login OR falls back to OPENAI_API_KEY.
 *   If neither is present the SDK errors out at first call — we forward
 *   that to the UI as an agent error.
 */

// Codex SDK is ESM-only and main is CJS — same lazy-import trick as agent.ts.
type CodexSdk = typeof import('@openai/codex-sdk');
type Codex = InstanceType<CodexSdk['Codex']>;
type Thread = InstanceType<CodexSdk['Thread']>;
type ThreadEvent = import('@openai/codex-sdk').ThreadEvent;
let codexSdkPromise: Promise<CodexSdk> | null = null;
function loadCodexSdk(): Promise<CodexSdk> {
  if (!codexSdkPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    codexSdkPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<CodexSdk>)(
      '@openai/codex-sdk'
    );
  }
  return codexSdkPromise;
}
import {
  buildCopywriterSystemPrompt,
  buildCopywriterUserPrompt,
  parseCopywriterResponse,
  type CopywriterGenerateInput,
  type LynLensEngine,
  type SocialCopy,
} from '@lynlens/core';

export interface AgentEvent {
  type: string;
  [k: string]: unknown;
}

// Intentionally duplicated from agent.ts (instead of import) so both paths
// can evolve independently. Shape is what the renderer already consumes.
export type AgentEventUnion =
  | { type: 'text_delta'; text: string }
  | { type: 'text_complete' }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'thinking'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface AgentOptions {
  projectId: string;
  message: string;
  resumeSessionId?: string;
  signal?: AbortSignal;
  onEvent: (ev: AgentEventUnion) => void;
}

export interface AgentResult {
  sessionId: string | null;
}

/**
 * Handle to the HTTP MCP server. Injected by the dispatcher so this module
 * doesn't need to know how the server was started.
 */
export interface CodexContext {
  url: string;
  bearerToken: string;
}

const SYSTEM_PROMPT = `
你是 LynLens 的内置剪辑助手,专门帮用户剪口播视频并审校字幕。用户会在打开的项目里直接看到你的操作。

核心原则:
- 永远先调 get_project_state 看当前视频信息、已有段、字幕状态。
- 默认用 L2 模式(pending 待审),让用户最后决定;除非用户明确说"全部自动"。
- 回答简洁,用中文。抓重点(总段数、风险、建议)即可,不要大段列出所有段落。
- 只做剪辑和字幕相关的操作,不要乱走。

**项目 ID 使用规则(极重要):**
- 本消息末尾会告诉你"当前项目 ID",所有工具调用都用这个,不要改、不要猜。
- 不要从任何工具返回的文件路径、会话 ID、错误消息里抽取 UUID 当项目 ID 用 —— 那些不是。
- 如果某次工具报 "Project not found",100% 是你用错 ID 了,立刻回到系统提示末尾的正确 ID。

你只能用 lynlens 这个 MCP server 提供的工具,没有 shell / 文件读写 / 网络访问。想做的事用不了工具,就直接告诉用户,不要反复尝试。

删除段标记:
- ai_mark_silence 标停顿/语气词/重复;手动 add_segments 用于特殊情况。
- 每段都要给清楚的 reason(停顿 N 秒 / 语气词「嗯」 / 重拍 等)。

字幕审校(用户明确要求时才做):
- 先 get_project_state 看 transcript.segments。
- 默认用 **suggest_transcript_fix** 对可疑段提出建议 — UI 会显示"✓接受/✗忽略"让用户决定。
- replace_in_transcript 只在用户明确说"全局替换 X 为 Y"时用。
- update_transcript_segment 只用于机械错误。
- 做完后,简短汇报你标了几段建议、理由是什么。

高光变体微调(用户说"第 3 段前移 2 秒" / "删第 1 段" / "最后一段挪前面" / "改描述"):
- 先 get_project_state 看 highlightVariants 里每个 variant 的 id 和 segments[idx].start/end/reason。
- 调用:
  * update_highlight_variant_segment — 改某段的起止或描述
  * add_highlight_variant_segment — 加新段
  * delete_highlight_variant_segment — 删段
  * reorder_highlight_variant_segment — 换顺序
- 所有时间是 **source 秒**(从头算)。用户说 "2:30" 就是 150。
- 每步改完简短汇报做了什么,别闷头连改 10 处。
`.trim();

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Inject our MCP server entry into ~/.codex/config.toml.
 *
 * Why on-disk instead of @openai/codex-sdk's `config` option: the SDK
 * flattens nested objects to dotted keys (mcp_servers.lynlens.transport.type
 * = "..."), but Codex's serde deserializer treats `transport` as a tagged
 * enum that needs inline-table syntax (transport = { type = "...", url =
 * "..." }). The dotted form parses to a sub-table, which fails with
 * "invalid transport". Writing to config.toml sidesteps the SDK's
 * serializer entirely.
 *
 * Idempotent: if our block already exists (previous run, crash recovery)
 * it gets replaced rather than duplicated. Uses a fenced marker pair so
 * the user's other mcp_servers entries stay untouched.
 */
const BLOCK_START = '# ===BEGIN LYNLENS (auto-managed, do not edit) ===';
const BLOCK_END = '# ===END LYNLENS===';

function codexConfigPath(): string {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

export async function writeCodexMcpEntry(
  ctx: CodexContext,
  tokenEnvVar: string
): Promise<void> {
  const configPath = codexConfigPath();
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  let existing = '';
  try {
    existing = await fsp.readFile(configPath, 'utf8');
  } catch {
    // no existing file — we'll create one
  }
  // Two cleanup passes before injecting our block:
  //   1. Strip any previous marker-fenced block we wrote.
  //   2. Strip any STANDALONE `[mcp_servers.lynlens]` section OUTSIDE our
  //      markers. This happens if the user (or a past dev build) ran
  //      `codex mcp add lynlens ...` manually — that writes an unfenced
  //      copy which would duplicate-key-crash against ours.
  existing = stripLynLensBlock(existing);
  existing = stripStandaloneLynLensServer(existing);
  // Format verified against `codex mcp add --url ...`: just `url` at the
  // top level, no `transport = { type = ... }` wrapper. Transport is
  // inferred from the presence of `url` (HTTP) vs `command` (stdio).
  const block = [
    BLOCK_START,
    '[mcp_servers.lynlens]',
    `url = "${ctx.url}"`,
    `bearer_token_env_var = "${tokenEnvVar}"`,
    BLOCK_END,
  ].join('\n');
  const newContent = existing.trimEnd() + '\n\n' + block + '\n';
  await fsp.writeFile(configPath, newContent, 'utf8');
}

/**
 * Strip a bare `[mcp_servers.lynlens]` TOML section — the section header
 * plus all its keys up to the next `[...]` header (or EOF). Used to clean
 * up orphans left by `codex mcp add lynlens` or earlier versions of this
 * code that didn't fence their block.
 */
function stripStandaloneLynLensServer(content: string): string {
  const lines = content.split('\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '[mcp_servers.lynlens]') {
      skipping = true;
      continue;
    }
    if (skipping) {
      // End skip block at the next table header or the next marker line.
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        skipping = false;
        out.push(line);
        continue;
      }
      if (trimmed.startsWith('# ===')) {
        skipping = false;
        out.push(line);
        continue;
      }
      // Otherwise, still inside the section's body — drop it.
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Remove our MCP server entry on app quit. Best-effort: if the file is
 * missing or unreadable we silently skip — the block will just linger
 * until the next run, where `writeCodexMcpEntry` overwrites it.
 */
export async function removeCodexMcpEntry(): Promise<void> {
  try {
    const configPath = codexConfigPath();
    const existing = await fsp.readFile(configPath, 'utf8');
    const stripped = stripLynLensBlock(existing);
    if (stripped.trim() === '') {
      // We were the only content — just delete the file cleanly.
      await fsp.rm(configPath, { force: true });
    } else {
      await fsp.writeFile(configPath, stripped, 'utf8');
    }
  } catch {
    // nothing to do
  }
}

function stripLynLensBlock(content: string): string {
  const startIdx = content.indexOf(BLOCK_START);
  if (startIdx < 0) return content;
  const endIdx = content.indexOf(BLOCK_END, startIdx);
  if (endIdx < 0) return content; // malformed — leave alone
  const before = content.slice(0, startIdx).trimEnd();
  const after = content.slice(endIdx + BLOCK_END.length).trimStart();
  return [before, after].filter(Boolean).join('\n');
}

/**
 * Module-level Codex instance cache. Starting Codex is expensive (spawns a
 * subprocess), so reuse across turns. Key includes the MCP URL so a server
 * restart invalidates the cache.
 */
const codexInstanceCache = new Map<string, Codex>();

async function getCodex(ctx: CodexContext): Promise<Codex> {
  const key = ctx.url;
  const existing = codexInstanceCache.get(key);
  if (existing) return existing;

  // Token lives in a per-session env var so the Codex subprocess inherits
  // it. Name chosen to be obvious in a process list.
  const tokenEnvVar = 'LYNLENS_MCP_TOKEN';
  process.env[tokenEnvVar] = ctx.bearerToken;

  // Inject our MCP server config into ~/.codex/config.toml (see comment on
  // writeCodexMcpEntry for why this is on-disk rather than via SDK option).
  await writeCodexMcpEntry(ctx, tokenEnvVar);

  const { Codex } = await loadCodexSdk();
  const codex = new Codex({
    // Why these settings (all necessary to dodge the "user cancelled MCP
    // tool call" error in SDK exec mode):
    //
    //   features.tool_call_mcp_elicitation = false
    //     Stops Codex from assuming every MCP call might request user
    //     input. Our tools never elicit.
    //
    //   features.guardian_approval = false
    //     Disables Codex's built-in approval layer (normally used to
    //     confirm shell / file actions with the human).
    //
    //   approvals_reviewer = "auto_review"
    //     When an approval IS still requested (rare but possible), use an
    //     AI subagent to auto-approve instead of waiting for a human.
    //     Exec mode has no human channel, so the default "user" reviewer
    //     would time out → cancellation.
    //
    // All three are simple scalars — the SDK's dotted-key config flattener
    // handles them correctly (only mcp_servers.* needed the config.toml
    // workaround because of its inline-table schema).
    config: {
      features: {
        tool_call_mcp_elicitation: false,
        guardian_approval: false,
      },
      approvals_reviewer: 'auto_review',
    },
  });
  codexInstanceCache.set(key, codex);
  return codex;
}

/**
 * Thread cache keyed by projectId + sessionId — Codex threads are resumable,
 * so we hand Codex the thread id and it loads state from ~/.codex/sessions.
 * A fresh thread is used whenever the caller passes no resumeSessionId
 * (e.g. after the user clicks "重置").
 */
const threadCache = new Map<string, Thread>();

function getOrStartThread(codex: Codex, projectId: string, resumeId?: string): Thread {
  const cacheKey = `${projectId}::${resumeId ?? 'new'}`;
  const cached = threadCache.get(cacheKey);
  if (cached) return cached;

  // The combo that actually works in SDK / exec mode:
  //   sandboxMode: 'danger-full-access'  +  approvalPolicy: 'never'
  //
  // This is the equivalent of passing `--dangerously-bypass-approvals-and-sandbox`
  // on the CLI. Yes, the name sounds scary — here's why it's safe for us:
  //   - Our Codex subprocess is restricted to calling our MCP tools only.
  //   - Our MCP tools don't touch the filesystem, shell, or external network.
  //     They only mutate the in-memory LynLens engine.
  //   - The "sandbox" in Codex gates file writes / shell commands, neither
  //     of which we ever invoke. So turning it off doesn't change our
  //     threat surface — but it DOES stop Codex from preemptively
  //     cancelling every MCP call with "user cancelled MCP tool call",
  //     which is what happens in any less-permissive mode under exec.
  //
  // Tried and discarded:
  //   - approvalPolicy: 'never' alone          → still cancels
  //   - features.guardian_approval = false     → still cancels
  //   - features.tool_call_mcp_elicitation = false → still cancels
  //   - approvals_reviewer: 'auto_review'      → docs claim works, doesn't
  const threadOpts = {
    sandboxMode: 'danger-full-access',
    webSearchEnabled: false,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
  } as const;
  const thread = resumeId
    ? codex.resumeThread(resumeId, threadOpts)
    : codex.startThread(threadOpts);
  threadCache.set(cacheKey, thread);
  return thread;
}

export async function runAgent(
  _engine: LynLensEngine,
  ctx: CodexContext,
  options: AgentOptions
): Promise<AgentResult> {
  const { projectId, message, resumeSessionId, signal, onEvent } = options;
  const codex = await getCodex(ctx);
  const thread = getOrStartThread(codex, projectId, resumeSessionId);

  const prompt = `${SYSTEM_PROMPT}\n\n当前项目 ID: ${projectId}\n\n用户消息:\n${message}`;

  let sessionId: string | null = resumeSessionId ?? thread.id;
  const textBuf: string[] = [];
  const toolStartById = new Map<string, { name: string; input: Record<string, unknown> }>();

  try {
    const { events } = await thread.runStreamed(prompt, { signal });
    for await (const event of events) {
      translate(event, (mapped) => {
        if (mapped.type === 'text_delta') textBuf.push(mapped.text);
        onEvent(mapped);
      }, textBuf, toolStartById);
      if ('thread_id' in event && typeof event.thread_id === 'string') {
        sessionId = event.thread_id;
      }
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

/**
 * Translate a Codex ThreadEvent to the same AgentEvent shape Claude emits.
 * Codex streams richer events (items.started / updated / completed) — we
 * collapse them to the minimum the chat UI cares about.
 */
function translate(
  event: ThreadEvent,
  emit: (ev: AgentEventUnion) => void,
  _textBuf: string[],
  toolStartById: Map<string, { name: string; input: Record<string, unknown> }>
): void {
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    const item = event.item;
    switch (item.type) {
      case 'agent_message':
        // Codex emits the FULL accumulated text on each update — matches
        // what Claude SDK does, so the renderer's replace-not-append logic
        // just works.
        emit({ type: 'text_delta', text: item.text });
        if (event.type === 'item.completed') emit({ type: 'text_complete' });
        return;
      case 'reasoning':
        if (event.type === 'item.updated' || event.type === 'item.completed') {
          emit({ type: 'thinking', text: item.text });
        }
        return;
      case 'mcp_tool_call': {
        const toolName = `mcp__${item.server}__${item.tool}`;
        if (event.type === 'item.started') {
          toolStartById.set(item.id, {
            name: toolName,
            input: (item.arguments as Record<string, unknown>) ?? {},
          });
          emit({
            type: 'tool_use',
            name: toolName,
            input: (item.arguments as Record<string, unknown>) ?? {},
          });
        } else if (event.type === 'item.completed') {
          const ok = item.status === 'completed';
          const summary = ok
            ? stringifyContent(item.result?.content)
            : item.error?.message ?? 'tool failed';
          emit({ type: 'tool_result', name: toolName, ok, summary: summary.slice(0, 500) });
          toolStartById.delete(item.id);
        }
        return;
      }
      case 'command_execution':
      case 'file_change':
      case 'web_search':
      case 'todo_list':
        // Not relevant for our restricted sandbox — ignore.
        return;
      case 'error':
        emit({ type: 'error', message: item.message });
        return;
    }
  } else if (event.type === 'error') {
    emit({ type: 'error', message: event.message });
  } else if (event.type === 'turn.failed') {
    emit({ type: 'error', message: event.error.message });
  }
  // thread.started / turn.started / turn.completed — nothing useful for us.
}

function stringifyContent(content: unknown): string {
  if (!content) return '';
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p && typeof p === 'object' && 'type' in p && (p as { type: string }).type === 'text') {
          return (p as { text?: string }).text ?? '';
        }
        return '';
      })
      .join('');
  }
  return String(content);
}

// ────────────────────────────────────────────────────────────────────────
// One-shot entrypoints (no tools) — used for highlight + copywriter
// generation. We just want a text response; no MCP, no multi-turn.
// ────────────────────────────────────────────────────────────────────────

export interface OneShotOptions {
  systemPrompt: string;
  userPrompt: string;
  codex: CodexContext;
  signal?: AbortSignal;
}

export async function runHighlightGeneration(
  opts: OneShotOptions
): Promise<{ text: string; model?: string }> {
  const codex = await getCodex(opts.codex);
  // Fresh throwaway thread — no MCP tools, no history. Same bypass combo
  // as runAgent() so the call doesn't get preemptively cancelled.
  const thread = codex.startThread({
    sandboxMode: 'danger-full-access',
    webSearchEnabled: false,
    skipGitRepoCheck: true,
    approvalPolicy: 'never',
  });
  const prompt = `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`;
  const turn = await thread.run(prompt, { signal: opts.signal });
  const text = turn.finalResponse;
  if (!text.trim()) throw new Error('Codex returned empty response');
  return { text };
}

export async function runCopywriterForPlatform(
  input: CopywriterGenerateInput,
  ctx: CodexContext,
  signal?: AbortSignal
): Promise<{ copy: SocialCopy; model?: string }> {
  const systemPrompt = buildCopywriterSystemPrompt(input.platform);
  const userPrompt = buildCopywriterUserPrompt(input);
  const { text, model } = await runHighlightGeneration({
    systemPrompt,
    userPrompt,
    codex: ctx,
    signal,
  });
  const copy = parseCopywriterResponse(text, input.platform);
  return { copy, model };
}

/** Clear the Codex thread cache for a project (called on chat reset). */
export function clearCodexSession(projectId: string): void {
  for (const key of threadCache.keys()) {
    if (key.startsWith(`${projectId}::`)) threadCache.delete(key);
  }
}
