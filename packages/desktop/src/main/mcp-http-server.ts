/**
 * In-process HTTP MCP server.
 *
 * Why this exists: @openai/codex-sdk connects to MCP tools only via external
 * servers (no `createSdkMcpServer` equivalent, unlike Claude Agent SDK).
 * Solution: boot an MCP server inside our Electron main process on localhost,
 * then point Codex at it via `config.mcp_servers.lynlens.transport.url`.
 *
 * All tool handlers close over the live `engine` instance — same in-memory
 * state the Claude path mutates, same EventBus the renderer listens to. The
 * HTTP hop is just the transport.
 *
 * Security: binds to 127.0.0.1, picks a random port, requires a per-launch
 * bearer token so nothing else on the machine can silently invoke LynLens
 * tools. Token is generated fresh each boot.
 *
 * ESM note: main is CommonJS but @modelcontextprotocol/sdk is ESM-only.
 * Same lazy-import trick as agent.ts (new Function wrapper to bypass TS's
 * require() compilation).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { LynLensEngine, SegmentSource, SegmentStatus } from '@lynlens/core';

// Lazy ESM import — required because main compiles to CJS and the MCP SDK
// only ships ESM entry points. Types are loose on purpose: TS's CJS
// resolution doesn't honor the package's `exports` field for subpath .js
// imports, so we'd have to upgrade the whole main tsconfig to NodeNext
// just to get type hints here. Not worth it for 15 tool handlers whose
// shapes are obvious from the schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpSdk = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamableHttpSdk = any;
let mcpSdkPromise: Promise<McpSdk> | null = null;
let streamableHttpSdkPromise: Promise<StreamableHttpSdk> | null = null;

function loadMcpSdk(): Promise<McpSdk> {
  if (!mcpSdkPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    mcpSdkPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<McpSdk>)(
      '@modelcontextprotocol/sdk/server/mcp.js'
    );
  }
  return mcpSdkPromise;
}
function loadStreamableHttpSdk(): Promise<StreamableHttpSdk> {
  if (!streamableHttpSdkPromise) {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    streamableHttpSdkPromise = (new Function('m', 'return import(m)') as (
      m: string
    ) => Promise<StreamableHttpSdk>)(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
  }
  return streamableHttpSdkPromise;
}

/**
 * Public handle returned by `startMcpHttpServer`. The caller keeps this
 * around to (a) pass `url` + `bearerToken` to the Codex SDK and (b) call
 * `stop()` on app quit so the port gets freed.
 */
export interface McpHttpServer {
  url: string;
  bearerToken: string;
  stop(): Promise<void>;
}

/**
 * Build an MCP server populated with every LynLens tool. Identical semantics
 * to the in-process tools registered in agent.ts — kept separate for now to
 * avoid coupling Claude's path to MCP SDK's tool API (slightly different
 * schema shape). If the two drift, consolidate in a follow-up.
 */
async function buildMcpServer(engine: LynLensEngine) {
  const { McpServer } = await loadMcpSdk();
  const server = new McpServer({ name: 'lynlens-inproc-http', version: '0.1.0' });

  server.registerTool(
    'get_project_state',
    {
      description:
        '获取当前项目状态(视频信息、字幕段文本、所有删除段、AI 模式)。返回精简结构:字幕段只含 id/start/end/text,不含词级时间戳(省 token)。',
      inputSchema: {
        projectId: z.string().describe('项目 ID(从 LynLens UI 打开视频后自动生成)'),
      },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const qcp = project.toQcp();
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
        content: [{ type: 'text' as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );

  server.registerTool(
    'transcribe',
    {
      description: '对当前项目的视频进行语音转文字(本地 whisper.cpp)。',
      inputSchema: {
        projectId: z.string(),
        language: z.string().default('auto'),
      },
    },
    async (args: { projectId: string; language: string }) => {
      const { projectId, language } = args;
      const project = engine.projects.get(projectId);
      engine.eventBus.emit({ type: 'transcription.started', projectId, engine: 'whisper-local' });
      try {
        const transcript = await engine.transcription.transcribe(project.videoPath, {
          language,
          onProgress: (percent) =>
            engine.eventBus.emit({ type: 'transcription.progress', projectId, percent }),
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
  );

  server.registerTool(
    'ai_mark_silence',
    {
      description:
        '内置静音检测(可选:若已有字幕,还会识别语气词和重复段)。添加的段都进 pending 待审状态。',
      inputSchema: {
        projectId: z.string(),
        minPauseSec: z.number().positive().default(1.0),
        silenceThreshold: z.number().min(0).max(1).default(0.03),
      },
    },
    async (args: { projectId: string; minPauseSec: number; silenceThreshold: number }) => {
      const { projectId, minPauseSec, silenceThreshold } = args;
      const project = engine.projects.get(projectId);
      const { detectSilences, detectFillers, detectRetakes, extractWaveform } = await import(
        '@lynlens/core'
      );
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
  );

  server.registerTool(
    'add_segments',
    {
      description: '手动添加需要删除的段(一般配合已有字幕做精细标记)。',
      inputSchema: {
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
    },
    async (args: {
      projectId: string;
      segments: Array<{ start: number; end: number; reason: string; confidence?: number }>;
    }) => {
      const project = engine.projects.get(args.projectId);
      const ids: string[] = [];
      for (const s of args.segments) {
        const seg = project.segments.add({
          start: s.start,
          end: s.end,
          source: 'ai' as SegmentSource,
          reason: s.reason,
          confidence: s.confidence,
          aiModel: 'codex-agent',
        });
        ids.push(seg.id);
      }
      return {
        content: [{ type: 'text' as const, text: `添加 ${ids.length} 段: ${ids.join(', ')}` }],
      };
    }
  );

  server.registerTool(
    'remove_segments',
    {
      description: '移除之前添加的删除段(纠错 / 响应用户"保留 #3"之类的要求)。',
      inputSchema: { projectId: z.string(), segmentIds: z.array(z.string()).min(1) },
    },
    async (args: { projectId: string; segmentIds: string[] }) => {
      const project = engine.projects.get(args.projectId);
      for (const id of args.segmentIds) project.segments.remove(id);
      return {
        content: [{ type: 'text' as const, text: `移除 ${args.segmentIds.length} 段` }],
      };
    }
  );

  server.registerTool(
    'set_segment_status',
    {
      description: '修改某个段的审核状态(approve / reject / pending)。',
      inputSchema: {
        projectId: z.string(),
        segmentId: z.string(),
        status: z.enum(['approved', 'rejected', 'pending']),
      },
    },
    async (args: {
      projectId: string;
      segmentId: string;
      status: 'approved' | 'rejected' | 'pending';
    }) => {
      const project = engine.projects.get(args.projectId);
      if (args.status === 'approved') project.segments.approve(args.segmentId, 'codex');
      else if (args.status === 'rejected') project.segments.reject(args.segmentId, 'codex');
      else {
        const seg = project.segments.find(args.segmentId);
        if (seg) seg.status = 'pending' as SegmentStatus;
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `段 ${args.segmentId.slice(0, 8)} 状态→${args.status}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'approve_all_pending',
    {
      description: '一键批准所有待审核的 AI 段。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const pending = project.segments.list().filter((s) => s.status === 'pending');
      for (const s of pending) project.segments.approve(s.id, 'codex');
      return {
        content: [{ type: 'text' as const, text: `批准了 ${pending.length} 个待审段` }],
      };
    }
  );

  server.registerTool(
    'commit_ripple',
    {
      description:
        '对所有 approved 删除段执行 ripple 剪切:把它们从时间轴里压掉,后面的内容整体往前填补。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const result = project.commitRipple();
      const msg =
        result.cutSegmentIds.length === 0
          ? '没有 approved 段,无需剪切。'
          : `剪掉 ${result.cutSegmentIds.length} 段,共 ${result.totalCutSeconds.toFixed(2)} 秒,时间轴长度变为 ${result.effectiveDuration.toFixed(2)} 秒。`;
      return { content: [{ type: 'text' as const, text: msg }] };
    }
  );

  server.registerTool(
    'revert_ripple',
    {
      description: '撤销某一段已经执行的 ripple 剪切。',
      inputSchema: { projectId: z.string(), segmentId: z.string() },
    },
    async (args: { projectId: string; segmentId: string }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.revertRipple(args.segmentId);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已恢复段 ${args.segmentId.slice(0, 8)}。`
              : `找不到 cut 状态的段 ${args.segmentId}。`,
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'set_mode',
    {
      description: '设置 AI 工作模式。L2 = 添加 AI 段进 pending; L3 = 直接 approved。',
      inputSchema: { projectId: z.string(), mode: z.enum(['L2', 'L3']) },
    },
    async (args: { projectId: string; mode: 'L2' | 'L3' }) => {
      engine.projects.get(args.projectId).setMode(args.mode);
      return { content: [{ type: 'text' as const, text: `模式→${args.mode}` }] };
    }
  );

  server.registerTool(
    'suggest_transcript_fix',
    {
      description:
        '对某一段字幕提出一个修改建议(不会立刻改动原文)。UI 会在那段下方显示"✓ 接受 / ✗ 忽略"。',
      inputSchema: {
        projectId: z.string(),
        segmentId: z.string(),
        newText: z.string().describe('建议的新文本'),
        reason: z.string().optional().describe('为什么要改 (简短)'),
      },
    },
    async (args: {
      projectId: string;
      segmentId: string;
      newText: string;
      reason?: string;
    }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.suggestTranscriptFix(args.segmentId, args.newText, args.reason);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已对段 ${args.segmentId.slice(0, 8)} 提交建议。`
              : `未找到字幕段 ${args.segmentId}`,
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'update_transcript_segment',
    {
      description:
        '【直接改】修正某一段字幕文字,立刻生效,不经过审核。只在"很明显不需要确认"的机械错误时用。',
      inputSchema: { projectId: z.string(), segmentId: z.string(), newText: z.string() },
    },
    async (args: { projectId: string; segmentId: string; newText: string }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.updateTranscriptSegment(args.segmentId, args.newText);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已直接更新字幕段 ${args.segmentId.slice(0, 8)}`
              : `未找到字幕段 ${args.segmentId}`,
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'replace_in_transcript',
    {
      description: '全局查找替换字幕文字。返回改动的段数。',
      inputSchema: { projectId: z.string(), find: z.string().min(1), replace: z.string() },
    },
    async (args: { projectId: string; find: string; replace: string }) => {
      const project = engine.projects.get(args.projectId);
      const n = project.replaceInTranscript(args.find, args.replace);
      return {
        content: [
          {
            type: 'text' as const,
            text: `替换 "${args.find}" → "${args.replace}": ${n} 段被改动`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'generate_highlights',
    {
      description:
        '从已经粗剪(ripple)过的字幕里挑出高光段,生成短视频变体。style: default/hero/ai-choice。',
      inputSchema: {
        projectId: z.string(),
        style: z.enum(['default', 'hero', 'ai-choice']),
        count: z.number().int().min(1).max(5),
        targetSeconds: z.number().int().min(5).max(300),
      },
    },
    async (args: {
      projectId: string;
      style: 'default' | 'hero' | 'ai-choice';
      count: number;
      targetSeconds: number;
    }) => {
      const project = engine.projects.get(args.projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '请先生成字幕后再生成高光。' }],
          isError: true,
        };
      }
      const { buildHighlightSystemPrompt, buildHighlightUserPrompt, parseHighlightResponse } =
        await import('@lynlens/core');
      const sys = buildHighlightSystemPrompt();
      const user = buildHighlightUserPrompt({
        transcript: project.transcript,
        cutRanges: project.cutRanges,
        effectiveDuration: project.getEffectiveDuration(),
        style: args.style,
        count: args.count,
        targetSeconds: args.targetSeconds,
      });
      const { runOneShotViaCurrentProvider } = await import('./agent-dispatcher');
      const { text, model } = await runOneShotViaCurrentProvider(sys, user);
      const variants = parseHighlightResponse(text, project.cutRanges, model, args.style);
      project.setHighlightVariants(variants);
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `生成了 ${variants.length} 个高光变体。` +
              variants.map((v) => `\n- ${v.title} (${v.durationSeconds.toFixed(1)}s)`).join(''),
          },
        ],
      };
    }
  );

  server.registerTool(
    'clear_highlights',
    {
      description: '清空当前高光变体。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const n = project.highlightVariants.length;
      project.clearHighlightVariants();
      return { content: [{ type: 'text' as const, text: `清空了 ${n} 个高光变体。` }] };
    }
  );

  server.registerTool(
    'update_highlight_variant_segment',
    {
      description:
        '修改某一段高光的起止时间(source 秒)和/或描述文字。用户说"第 3 段前移 2 秒" / "第 1 段缩短到 5 秒" / "改描述" 时调用。先用 get_project_state 查 variantId 和 segmentIdx。不能和同变体其他段重叠,时长 < 0.2s 或越界会被拒。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        segmentIdx: z.number().int().min(0),
        newStart: z.number().nonnegative(),
        newEnd: z.number().positive(),
        newReason: z.string().optional(),
      },
    },
    async (args: {
      projectId: string;
      variantId: string;
      segmentIdx: number;
      newStart: number;
      newEnd: number;
      newReason?: string;
    }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.updateHighlightVariantSegment(
        args.variantId,
        args.segmentIdx,
        args.newStart,
        args.newEnd,
        args.newReason
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已更新变体 ${args.variantId.slice(0, 8)} 的第 ${args.segmentIdx + 1} 段`
              : '更新失败 —— 可能和其他段重叠、越界、或段长 < 0.2s。',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'add_highlight_variant_segment',
    {
      description:
        '给某个高光变体加一段(source 秒)。用户说"在第 3 段后加一段 1:20 到 1:25" / "漏了开头那句补上" 时调用。新段加在变体末尾,用 reorder 改位置。必须不重叠。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        startSec: z.number().nonnegative(),
        endSec: z.number().positive(),
        reason: z.string().default('AI 手动添加'),
      },
    },
    async (args: {
      projectId: string;
      variantId: string;
      startSec: number;
      endSec: number;
      reason: string;
    }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.addHighlightVariantSegment(
        args.variantId,
        args.startSec,
        args.endSec,
        args.reason
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已添加新段到变体 ${args.variantId.slice(0, 8)}: ${args.startSec.toFixed(2)} - ${args.endSec.toFixed(2)}`
              : '添加失败 —— 重叠、越界或长度 < 0.2s。',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'delete_highlight_variant_segment',
    {
      description:
        '从某个高光变体里删掉一段。用户说"第 2 段不要"时调用。变体必须剩至少一段(否则拒绝)。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        segmentIdx: z.number().int().min(0),
      },
    },
    async (args: { projectId: string; variantId: string; segmentIdx: number }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.deleteHighlightVariantSegment(args.variantId, args.segmentIdx);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已删除变体 ${args.variantId.slice(0, 8)} 的第 ${args.segmentIdx + 1} 段`
              : '删除失败 —— 可能是最后一段(保留至少 1 段)或编号越界。',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'reorder_highlight_variant_segment',
    {
      description:
        '调整变体里段落的播放顺序。用户说"把第 3 段挪到第 1 段之前" 时调用。时间不变,只改数组顺序。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        fromIdx: z.number().int().min(0),
        toIdx: z.number().int().min(0),
      },
    },
    async (args: {
      projectId: string;
      variantId: string;
      fromIdx: number;
      toIdx: number;
    }) => {
      const project = engine.projects.get(args.projectId);
      const ok = project.reorderHighlightVariantSegment(
        args.variantId,
        args.fromIdx,
        args.toIdx
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已把变体 ${args.variantId.slice(0, 8)} 的第 ${args.fromIdx + 1} 段移到第 ${args.toIdx + 1} 位`
              : '重排失败 —— 编号越界。',
          },
        ],
        isError: !ok,
      };
    }
  );

  return server;
}

/**
 * Boot the HTTP MCP server, returning its URL and a cleanup function.
 * Binds to 127.0.0.1:0 so the OS picks a free port. Stateful session mode
 * (each Codex thread establishes its own session ID via the Mcp-Session-Id
 * header) so multi-turn conversations see a consistent server state.
 */
export async function startMcpHttpServer(engine: LynLensEngine): Promise<McpHttpServer> {
  // Pre-warm the SDKs so the first request doesn't pay for the dynamic import.
  await loadMcpSdk();
  const { StreamableHTTPServerTransport } = await loadStreamableHttpSdk();
  // Allow overriding the token via env var so we can drive the server from
  // `codex exec` in a terminal for debugging without digging the random
  // token out of Electron memory.
  const bearerToken = process.env.LYNLENS_MCP_DEV_TOKEN ?? randomBytes(24).toString('hex');

  // Per-session transport map. Each session also owns its OWN McpServer
  // instance — the MCP SDK's Protocol layer forbids sharing one server
  // across multiple concurrent transports ("Already connected to a
  // transport" error). Building a server is cheap (just tool registration),
  // so we just do it fresh per session.
  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  const httpServer: HttpServer = createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400).end('bad request');
        return;
      }
      const auth = req.headers['authorization'];
      if (typeof auth !== 'string' || auth !== `Bearer ${bearerToken}`) {
        // eslint-disable-next-line no-console
        console.warn('[mcp-http] unauthorized request from', req.socket.remoteAddress, 'auth=', auth);
        res.writeHead(401).end('unauthorized');
        return;
      }
      if (!req.url.startsWith('/mcp')) {
        res.writeHead(404).end('not found');
        return;
      }
      // eslint-disable-next-line no-console
      console.log(
        '[mcp-http] ←',
        req.method,
        req.url,
        'session=',
        req.headers['mcp-session-id'] ?? '(new)'
      );

      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && transports.has(sessionId)) {
        const b = await readJson(req);
        // eslint-disable-next-line no-console
        console.log(
          '[mcp-http] body:',
          b === undefined ? '(no body)' : JSON.stringify(b).slice(0, 400)
        );
        await transports.get(sessionId)!.handleRequest(req, res, b);
        return;
      }

      const body = await readJson(req);
      // eslint-disable-next-line no-console
      console.log(
        '[mcp-http] init body:',
        body === undefined ? '(no body)' : JSON.stringify(body).slice(0, 400)
      );
      // Each session gets its own McpServer — the Protocol layer inside the
      // SDK tracks request/response correlation per-transport and refuses
      // to multiplex. We used to share one server; that manifested as the
      // "Already connected to a transport" error on session reconnect.
      const perSessionServer = await buildMcpServer(engine);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport);
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      await perSessionServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-http-server] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500).end(String(err));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    httpServer.close();
    throw new Error('mcp http server: failed to resolve bound address');
  }
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    bearerToken,
    async stop() {
      for (const t of transports.values()) {
        await t.close().catch(() => {});
      }
      transports.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

/**
 * Read a request body as JSON (or undefined for GET / empty bodies).
 * StreamableHTTPServerTransport expects the caller to have pre-parsed JSON
 * when passing `parsedBody`.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.method === 'GET' || req.method === 'DELETE') return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
