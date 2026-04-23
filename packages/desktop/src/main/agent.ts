/**
 * In-process Claude agent wired directly to the local LynLens engine.
 *
 * We expose the engine as an "SDK MCP server" that lives in this Electron
 * main process. The Claude agent SDK streams model output and tool calls;
 * tool handlers mutate the engine synchronously, so the renderer sees the
 * resulting EventBus events immediately — no file watching required.
 */

import { z } from 'zod';
import type {
  LynLensEngine,
  SegmentSource,
  SegmentStatus,
} from '@lynlens/core';

// Lazy-load the ESM-only Claude SDK. Static `import` would compile to
// `require()` in CJS, which is rejected at runtime (ERR_REQUIRE_ESM).
type AgentSdk = typeof import('@anthropic-ai/claude-agent-sdk');
let sdkPromise: Promise<AgentSdk> | null = null;
function loadSdk(): Promise<AgentSdk> {
  if (!sdkPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
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
 * Build the SDK MCP server with engine-backed tool handlers.
 */
async function buildLynLensSdkServer(engine: LynLensEngine) {
  const { createSdkMcpServer, tool } = await loadSdk();
  return createSdkMcpServer({
    name: 'lynlens-inproc',
    version: '0.1.0',
    tools: [
      tool(
        'get_project_state',
        '获取当前项目状态(视频信息、字幕段文本、所有删除段、AI 模式)。返回精简结构:字幕段只含 id/start/end/text,不含词级时间戳(省 token)。需要逐词定位时直接操作 text。',
        {
          projectId: z.string().describe('项目 ID(从 LynLens UI 打开视频后自动生成;不要从任何路径或 session 文件名里猜)'),
        },
        async ({ projectId }) => {
          const project = engine.projects.get(projectId);
          const qcp = project.toQcp();
          // Slim down transcript: drop word-level timestamps to keep the
          // tool-result under Claude Code's truncation threshold when the
          // video is long (40+ segments × 20+ words each blows past 60KB).
          const slim = {
            ...qcp,
            transcript: qcp.transcript
              ? {
                  language: qcp.transcript.language,
                  segmentCount: qcp.transcript.segments.length,
                  segments: qcp.transcript.segments.map((s) => ({
                    id: s.id,
                    start: Number(s.start.toFixed(3)),
                    end: Number(s.end.toFixed(3)),
                    text: s.text,
                  })),
                }
              : null,
          };
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(slim, null, 2),
              },
            ],
          };
        }
      ),

      tool(
        'transcribe',
        '对当前项目的视频进行语音转文字(本地 whisper.cpp)。返回带词级时间戳的字幕。',
        {
          projectId: z.string(),
          language: z.string().default('auto').describe('zh / en / auto'),
        },
        async ({ projectId, language }) => {
          const project = engine.projects.get(projectId);
          engine.eventBus.emit({
            type: 'transcription.started',
            projectId,
            engine: 'whisper-local',
          });
          try {
            const transcript = await engine.transcription.transcribe(project.videoPath, {
              language,
              onProgress: (percent) =>
                engine.eventBus.emit({
                  type: 'transcription.progress',
                  projectId,
                  percent,
                }),
            });
            project.setTranscript(transcript);
            engine.eventBus.emit({
              type: 'transcription.completed',
              projectId,
              segmentCount: transcript.segments.length,
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `转录完成: ${transcript.segments.length} 段, 语言=${transcript.language}`,
                },
              ],
            };
          } catch (err) {
            engine.eventBus.emit({
              type: 'transcription.failed',
              projectId,
              error: (err as Error).message,
            });
            throw err;
          }
        }
      ),

      tool(
        'ai_mark_silence',
        '内置静音检测(可选:若已有字幕,还会识别语气词和重复段)。添加的段都进 pending 待审状态。',
        {
          projectId: z.string(),
          minPauseSec: z.number().positive().default(1.0),
          silenceThreshold: z.number().min(0).max(1).default(0.03),
        },
        async ({ projectId, minPauseSec, silenceThreshold }) => {
          const project = engine.projects.get(projectId);
          const { detectSilences, detectFillers, detectRetakes, extractWaveform } =
            await import('@lynlens/core');
          const env = await extractWaveform(project.videoPath, 4000, engine.ffmpegPaths);
          const silences = detectSilences(env.peak, project.videoMeta.duration, {
            minPauseSec,
            silenceThreshold,
          });
          let fillerCount = 0;
          let retakeCount = 0;
          const ids: string[] = [];
          for (const s of silences) {
            const seg = project.segments.add({
              start: s.start,
              end: s.end,
              source: 'ai',
              reason: s.reason,
              confidence: 0.75,
              aiModel: 'builtin-silence',
            });
            ids.push(seg.id);
          }
          if (project.transcript) {
            for (const f of detectFillers(project.transcript)) {
              const seg = project.segments.add({
                start: f.start,
                end: f.end,
                source: 'ai',
                reason: f.reason,
                confidence: f.confidence,
                aiModel: 'builtin-filler',
              });
              ids.push(seg.id);
              fillerCount += 1;
            }
            for (const r of detectRetakes(project.transcript)) {
              const seg = project.segments.add({
                start: r.start,
                end: r.end,
                source: 'ai',
                reason: r.reason,
                confidence: r.confidence,
                aiModel: 'builtin-retake',
              });
              ids.push(seg.id);
              retakeCount += 1;
            }
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `已标 ${ids.length} 段: 停顿 ${silences.length}, 语气词 ${fillerCount}, 重复 ${retakeCount}`,
              },
            ],
          };
        }
      ),

      tool(
        'add_segments',
        '手动添加需要删除的段(一般配合已有字幕做精细标记)。',
        {
          projectId: z.string(),
          segments: z
            .array(
              z.object({
                start: z.number().nonnegative(),
                end: z.number().positive(),
                reason: z.string(),
                confidence: z.number().min(0).max(1).optional(),
              })
            )
            .min(1),
        },
        async ({ projectId, segments }) => {
          const project = engine.projects.get(projectId);
          const ids: string[] = [];
          for (const s of segments) {
            const seg = project.segments.add({
              start: s.start,
              end: s.end,
              source: 'ai' as SegmentSource,
              reason: s.reason,
              confidence: s.confidence,
              aiModel: 'claude-agent',
            });
            ids.push(seg.id);
          }
          return {
            content: [
              { type: 'text' as const, text: `添加 ${ids.length} 段: ${ids.join(', ')}` },
            ],
          };
        }
      ),

      tool(
        'remove_segments',
        '移除之前添加的删除段(纠错 / 响应用户"保留 #3"之类的要求)。',
        {
          projectId: z.string(),
          segmentIds: z.array(z.string()).min(1),
        },
        async ({ projectId, segmentIds }) => {
          const project = engine.projects.get(projectId);
          for (const id of segmentIds) project.segments.remove(id);
          return {
            content: [
              { type: 'text' as const, text: `移除 ${segmentIds.length} 段` },
            ],
          };
        }
      ),

      tool(
        'set_segment_status',
        '修改某个段的审核状态(approve / reject)。常用于"保留这几段"或"删掉这几段的待审"。',
        {
          projectId: z.string(),
          segmentId: z.string(),
          status: z.enum(['approved', 'rejected', 'pending'] as const),
        },
        async ({ projectId, segmentId, status }) => {
          const project = engine.projects.get(projectId);
          if (status === 'approved') project.segments.approve(segmentId, 'claude');
          else if (status === 'rejected') project.segments.reject(segmentId, 'claude');
          else {
            // To set to pending we directly mutate (no public API yet)
            const seg = project.segments.find(segmentId);
            if (seg) seg.status = 'pending' as SegmentStatus;
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `段 ${segmentId.slice(0, 8)} 状态→${status}`,
              },
            ],
          };
        }
      ),

      tool(
        'approve_all_pending',
        '一键批准所有待审核的 AI 段(用户说"全部接受"时调用)。',
        { projectId: z.string() },
        async ({ projectId }) => {
          const project = engine.projects.get(projectId);
          const pending = project.segments.list().filter((s) => s.status === 'pending');
          for (const s of pending) project.segments.approve(s.id, 'claude');
          return {
            content: [
              { type: 'text' as const, text: `批准了 ${pending.length} 个待审段` },
            ],
          };
        }
      ),

      tool(
        'commit_ripple',
        '对所有 approved 删除段执行 ripple 剪切:把它们从时间轴里压掉,后面的内容整体往前填补,时间轴变短。只动 approved 的段,pending 和 rejected 不动。用户说"剪掉/执行剪切/ripple"或者确认一批删除段后要真动手时调用。调用前最好让用户知道会删多少秒。',
        { projectId: z.string() },
        async ({ projectId }) => {
          const project = engine.projects.get(projectId);
          const result = project.commitRipple();
          const msg =
            result.cutSegmentIds.length === 0
              ? '没有 approved 段,无需剪切。'
              : `剪掉 ${result.cutSegmentIds.length} 段,共 ${result.totalCutSeconds.toFixed(2)} 秒,时间轴长度变为 ${result.effectiveDuration.toFixed(2)} 秒。`;
          return {
            content: [{ type: 'text' as const, text: msg }],
          };
        }
      ),

      tool(
        'revert_ripple',
        '撤销某一段已经执行的 ripple 剪切:把指定段从 cut 状态恢复为 approved,时间轴会重新变长。参数是要恢复的 segment id。',
        {
          projectId: z.string(),
          segmentId: z.string(),
        },
        async ({ projectId, segmentId }) => {
          const project = engine.projects.get(projectId);
          const ok = project.revertRipple(segmentId);
          return {
            content: [
              {
                type: 'text' as const,
                text: ok
                  ? `已恢复段 ${segmentId.slice(0, 8)}。`
                  : `找不到 cut 状态的段 ${segmentId}。`,
              },
            ],
            isError: !ok,
          };
        }
      ),

      tool(
        'set_mode',
        '设置 AI 工作模式。L2 = 添加 AI 段进 pending 等审核; L3 = 直接 approved。',
        {
          projectId: z.string(),
          mode: z.enum(['L2', 'L3'] as const),
        },
        async ({ projectId, mode }) => {
          engine.projects.get(projectId).setMode(mode);
          return {
            content: [{ type: 'text' as const, text: `模式→${mode}` }],
          };
        }
      ),

      tool(
        'suggest_transcript_fix',
        '对某一段字幕提出一个修改建议(不会立刻改动原文)。UI 会在那段下方显示"✓ 接受 / ✗ 忽略",用户点击后才生效。用于疑似错字、同音字修正、专有名词统一等需要人眼确认的改动。',
        {
          projectId: z.string(),
          segmentId: z.string(),
          newText: z.string().describe('建议的新文本'),
          reason: z.string().optional().describe('为什么要改 (简短,一句话)'),
        },
        async ({ projectId, segmentId, newText, reason }) => {
          const project = engine.projects.get(projectId);
          const ok = project.suggestTranscriptFix(segmentId, newText, reason);
          return {
            content: [
              {
                type: 'text' as const,
                text: ok
                  ? `已对段 ${segmentId.slice(0, 8)} 提交建议,等用户确认。`
                  : `未找到字幕段 ${segmentId}`,
              },
            ],
            isError: !ok,
          };
        }
      ),

      tool(
        'update_transcript_segment',
        '【直接改】修正某一段字幕文字,立刻生效,不经过审核。只在"很明显不需要确认"的机械错误时用(如字面的拼写错);有歧义的改动请改用 suggest_transcript_fix。',
        {
          projectId: z.string(),
          segmentId: z.string(),
          newText: z.string(),
        },
        async ({ projectId, segmentId, newText }) => {
          const project = engine.projects.get(projectId);
          const ok = project.updateTranscriptSegment(segmentId, newText);
          return {
            content: [
              {
                type: 'text' as const,
                text: ok
                  ? `已直接更新字幕段 ${segmentId.slice(0, 8)}`
                  : `未找到字幕段 ${segmentId}`,
              },
            ],
            isError: !ok,
          };
        }
      ),

      tool(
        'replace_in_transcript',
        '全局查找替换字幕文字(批量修错字 / 统一专有名词)。返回改动的段数。',
        {
          projectId: z.string(),
          find: z.string().min(1),
          replace: z.string(),
        },
        async ({ projectId, find, replace }) => {
          const project = engine.projects.get(projectId);
          const n = project.replaceInTranscript(find, replace);
          return {
            content: [
              {
                type: 'text' as const,
                text: `替换 "${find}" → "${replace}": ${n} 段被改动`,
              },
            ],
          };
        }
      ),
    ],
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
- 永远先调 get_project_state 看当前视频信息、已有段、字幕状态。
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
- 先 get_project_state 看 transcript.segments(每段有 id/start/end/text,没有词级时间戳 — 不需要)。
- 默认用 **suggest_transcript_fix** 对可疑段提出建议 — 建议会出现在 UI 那段下方,用户看到"✓接受/✗忽略"再决定。
- replace_in_transcript 只在用户明确说"全局替换 X 为 Y"时用 — 直接生效,不需要审核。
- update_transcript_segment 直接改 — 只用于**机械错误**(如字面打错),不要主动用。
- 做完后,简短汇报你标了几段建议、理由是什么,让用户去 UI 审核。
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

  // Restrict the embedded agent to ONLY our lynlens tools. If Claude ever needs
  // something it can't do (e.g. "read the script from this txt file"), we can
  // loosen this list later. For now: no filesystem / bash / network access.
  const ALLOWED_TOOLS = [
    'mcp__lynlens__get_project_state',
    'mcp__lynlens__transcribe',
    'mcp__lynlens__ai_mark_silence',
    'mcp__lynlens__add_segments',
    'mcp__lynlens__remove_segments',
    'mcp__lynlens__set_segment_status',
    'mcp__lynlens__approve_all_pending',
    'mcp__lynlens__commit_ripple',
    'mcp__lynlens__revert_ripple',
    'mcp__lynlens__set_mode',
    'mcp__lynlens__update_transcript_segment',
    'mcp__lynlens__suggest_transcript_fix',
    'mcp__lynlens__replace_in_transcript',
  ];

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
      // eslint-disable-next-line no-console
      console.error('[claude-code-stderr]', data);
    },
  };
  if (resumeSessionId) queryOptions.resume = resumeSessionId;

  let sessionId: string | null = resumeSessionId ?? null;

  // Per-run de-duplication: the SDK can emit the same assistant / user
  // message twice (partial + final, or retries), which would otherwise
  // surface as duplicate tool chips in the chat UI.
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
    message?: { id?: string; content?: Array<{ type: string; text?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean }> };
    subtype?: string;
  };

  // Skip any assistant/user message we have already processed. The SDK
  // occasionally re-emits the same message (partial + final, or cached
  // repeats) which would surface as duplicate tool chips in the UI.
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
              ? c.map((p: { type: string; text?: string }) => (p.type === 'text' ? p.text ?? '' : '')).join('')
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
