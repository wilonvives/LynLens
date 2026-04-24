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

  // ──────────────────────────────────────────────────────────────
  // Segment edit: reject / erase / resize / undo / save
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'reject_segment',
    {
      description: '拒绝(否决)一个待审 AI 段。对应 UI 里的 ✗ 按钮。',
      inputSchema: { projectId: z.string(), segmentId: z.string() },
    },
    async (args: { projectId: string; segmentId: string }) => {
      const project = engine.projects.get(args.projectId);
      project.segments.reject(args.segmentId, 'codex');
      return {
        content: [
          { type: 'text' as const, text: `段 ${args.segmentId.slice(0, 8)} 已拒绝` },
        ],
      };
    }
  );

  server.registerTool(
    'reject_all_pending',
    {
      description: '一键拒绝所有待审 AI 段。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const pending = project.segments.list().filter((s) => s.status === 'pending');
      for (const s of pending) project.segments.reject(s.id, 'codex');
      return {
        content: [{ type: 'text' as const, text: `拒绝了 ${pending.length} 个待审段` }],
      };
    }
  );

  server.registerTool(
    'erase_range',
    {
      description:
        '擦除某个时间范围内所有标记段。time 为 source 秒。用户说"别删 0:10-0:20 那段的任何标记"时用。',
      inputSchema: {
        projectId: z.string(),
        start: z.number().nonnegative(),
        end: z.number().positive(),
      },
    },
    async (args: { projectId: string; start: number; end: number }) => {
      const project = engine.projects.get(args.projectId);
      const before = project.segments.list().length;
      project.segments.eraseRange(args.start, args.end);
      const after = project.segments.list().length;
      return {
        content: [
          {
            type: 'text' as const,
            text: `擦除 ${args.start.toFixed(2)}-${args.end.toFixed(2)}: 删掉 ${before - after} 个标记`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'resize_segment',
    {
      description: '调整一个已有删除段的起止时间(source 秒)。',
      inputSchema: {
        projectId: z.string(),
        segmentId: z.string(),
        start: z.number().nonnegative(),
        end: z.number().positive(),
      },
    },
    async (args: {
      projectId: string;
      segmentId: string;
      start: number;
      end: number;
    }) => {
      const project = engine.projects.get(args.projectId);
      const seg = project.segments.resize(args.segmentId, args.start, args.end);
      return {
        content: [
          {
            type: 'text' as const,
            text: seg
              ? `段 ${args.segmentId.slice(0, 8)} 已改到 ${args.start.toFixed(2)}-${args.end.toFixed(2)}`
              : `找不到段 ${args.segmentId}`,
          },
        ],
        isError: !seg,
      };
    }
  );

  server.registerTool(
    'undo',
    {
      description: '撤销上一步删除段操作。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const ok = engine.projects.get(args.projectId).segments.undo();
      return {
        content: [
          { type: 'text' as const, text: ok ? '已撤销' : '没有可撤销的操作' },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'redo',
    {
      description: '重做上一次撤销的操作。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const ok = engine.projects.get(args.projectId).segments.redo();
      return {
        content: [
          { type: 'text' as const, text: ok ? '已重做' : '没有可重做的操作' },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'save_project',
    {
      description: '把当前项目状态写到 .qcp 文件。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const savedPath = await engine.projects.saveProject(args.projectId);
      return {
        content: [{ type: 'text' as const, text: `已保存: ${savedPath}` }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Transcript
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'accept_transcript_suggestion',
    {
      description:
        '接受某段字幕的 AI 建议(用建议文本覆盖原文,相当于用户点 ✓ 接受)。',
      inputSchema: { projectId: z.string(), segmentId: z.string() },
    },
    async (args: { projectId: string; segmentId: string }) => {
      const ok = engine.projects
        .get(args.projectId)
        .acceptTranscriptSuggestion(args.segmentId);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已接受 ${args.segmentId.slice(0, 8)} 的建议`
              : '找不到该段或无建议',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'clear_transcript_suggestion',
    {
      description: '忽略某段字幕的 AI 建议(原文不变)。',
      inputSchema: { projectId: z.string(), segmentId: z.string() },
    },
    async (args: { projectId: string; segmentId: string }) => {
      const ok = engine.projects
        .get(args.projectId)
        .clearTranscriptSuggestion(args.segmentId);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已忽略 ${args.segmentId.slice(0, 8)} 的建议`
              : '找不到该段或无建议',
          },
        ],
      };
    }
  );

  server.registerTool(
    'update_transcript_segment_time',
    {
      description:
        '调整某段字幕的起止时间(source 秒)。级联规则:与前/后段碰到时,邻居的就近边会让位。',
      inputSchema: {
        projectId: z.string(),
        segmentId: z.string(),
        newStart: z.number().nonnegative(),
        newEnd: z.number().positive(),
      },
    },
    async (args: {
      projectId: string;
      segmentId: string;
      newStart: number;
      newEnd: number;
    }) => {
      const ok = engine.projects
        .get(args.projectId)
        .updateTranscriptSegmentTime(args.segmentId, args.newStart, args.newEnd);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `已更新 ${args.segmentId.slice(0, 8)}: ${args.newStart.toFixed(2)}-${args.newEnd.toFixed(2)}`
              : '更新失败',
          },
        ],
        isError: !ok,
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Highlights — inspection / pinning / deletion / export
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'get_highlights',
    {
      description: '列出当前项目的所有高光变体及各自的段落(用于定位 variantId / segmentIdx)。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const project = engine.projects.get(args.projectId);
      const slim = project.highlightVariants.map((v) => ({
        id: v.id,
        title: v.title,
        style: v.style,
        pinned: !!v.pinned,
        durationSeconds: Number(v.durationSeconds.toFixed(2)),
        segments: v.segments.map((s) => ({
          start: Number(s.start.toFixed(3)),
          end: Number(s.end.toFixed(3)),
          reason: s.reason,
        })),
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(slim, null, 2) }],
      };
    }
  );

  server.registerTool(
    'set_highlight_pinned',
    {
      description:
        '收藏 / 取消收藏一个高光变体。收藏过的不会被「重新生成」覆盖。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        pinned: z.boolean(),
      },
    },
    async (args: { projectId: string; variantId: string; pinned: boolean }) => {
      const ok = engine.projects
        .get(args.projectId)
        .setHighlightVariantPinned(args.variantId, args.pinned);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? `变体 ${args.variantId.slice(0, 8)} ${args.pinned ? '已收藏' : '已取消收藏'}`
              : '变体不存在',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'delete_highlight_variant',
    {
      description:
        '永久删除整个高光变体(包括收藏的,不做二次确认)。用户明确说"删掉 #2 这个变体"时调用。',
      inputSchema: { projectId: z.string(), variantId: z.string() },
    },
    async (args: { projectId: string; variantId: string }) => {
      const ok = engine.projects.get(args.projectId).deleteHighlightVariant(args.variantId);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok ? `已删除变体 ${args.variantId.slice(0, 8)}` : '变体不存在',
          },
        ],
        isError: !ok,
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Speakers
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'diarize',
    {
      description:
        '跑说话人识别,给每段字幕打标签。speakerCount 可选(默认 AI 自动)。跑完后用 rename_speaker 给人取名。',
      inputSchema: {
        projectId: z.string(),
        speakerCount: z.number().int().min(1).max(8).optional(),
      },
    },
    async (args: { projectId: string; speakerCount?: number }) => {
      try {
        const { runDiarization } = await import('./diarize-helper');
        const diar = await runDiarization(engine, args.projectId, {
          speakerCount: args.speakerCount,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `识别完成,engine=${diar.engine},说话人: ${diar.speakers.join(', ') || '(空)'}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: (err as Error).message }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'rename_speaker',
    {
      description: '给说话人 ID 起显示名字,比如 S1 改叫「主持人」。name 为空则取消命名。',
      inputSchema: {
        projectId: z.string(),
        speakerId: z.string(),
        name: z.string().nullable(),
      },
    },
    async (args: { projectId: string; speakerId: string; name: string | null }) => {
      engine.projects.get(args.projectId).renameSpeaker(args.speakerId, args.name);
      return {
        content: [
          {
            type: 'text' as const,
            text: args.name ? `${args.speakerId} → "${args.name}"` : `${args.speakerId} 取消命名`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'merge_speakers',
    {
      description: '把所有被标成 from 的字幕段重新标成 to。',
      inputSchema: {
        projectId: z.string(),
        from: z.string(),
        to: z.string(),
      },
    },
    async (args: { projectId: string; from: string; to: string }) => {
      const n = engine.projects.get(args.projectId).mergeSpeakers(args.from, args.to);
      return {
        content: [
          { type: 'text' as const, text: `把 ${n} 段从 ${args.from} 合并到 ${args.to}` },
        ],
      };
    }
  );

  server.registerTool(
    'set_segment_speaker',
    {
      description: '改单一字幕段的说话人标签。speaker 为空则清除标签。',
      inputSchema: {
        projectId: z.string(),
        transcriptSegmentId: z.string(),
        speaker: z.string().nullable(),
      },
    },
    async (args: {
      projectId: string;
      transcriptSegmentId: string;
      speaker: string | null;
    }) => {
      const ok = engine.projects
        .get(args.projectId)
        .setSegmentSpeaker(args.transcriptSegmentId, args.speaker);
      return {
        content: [
          {
            type: 'text' as const,
            text: ok
              ? args.speaker
                ? `${args.transcriptSegmentId.slice(0, 8)} → ${args.speaker}`
                : `${args.transcriptSegmentId.slice(0, 8)} 清除标签`
              : '段不存在',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'auto_assign_unlabeled_speakers',
    {
      description: '给所有未标记字幕段自动指派说话人(按就近原则)。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const n = engine.projects.get(args.projectId).autoAssignUnlabeledSpeakers();
      return {
        content: [{ type: 'text' as const, text: `自动指派了 ${n} 段` }],
      };
    }
  );

  server.registerTool(
    'clear_speakers',
    {
      description: '清空所有说话人标签。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      engine.projects.get(args.projectId).clearSpeakers();
      return {
        content: [{ type: 'text' as const, text: '所有说话人标签已清除' }],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Social copies
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'get_social_copies',
    {
      description: '列出所有已生成的文案集(每组里有多个平台的文案)。',
      inputSchema: { projectId: z.string() },
    },
    async (args: { projectId: string }) => {
      const sets = engine.projects.get(args.projectId).socialCopies;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(sets, null, 2) }],
      };
    }
  );

  server.registerTool(
    'update_social_copy',
    {
      description: '改一条生成的文案(标题/正文/hashtags)。patch 里只传要改的字段。',
      inputSchema: {
        projectId: z.string(),
        setId: z.string(),
        copyId: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        hashtags: z.array(z.string()).optional(),
      },
    },
    async (args: {
      projectId: string;
      setId: string;
      copyId: string;
      title?: string;
      body?: string;
      hashtags?: string[];
    }) => {
      const ok = engine.projects
        .get(args.projectId)
        .updateSocialCopy(args.setId, args.copyId, {
          title: args.title,
          body: args.body,
          hashtags: args.hashtags,
        });
      return {
        content: [
          {
            type: 'text' as const,
            text: ok ? `已更新 ${args.copyId.slice(0, 8)}` : '找不到对应文案',
          },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'delete_social_copy',
    {
      description: '从某个文案集里删一个平台的文案。',
      inputSchema: {
        projectId: z.string(),
        setId: z.string(),
        copyId: z.string(),
      },
    },
    async (args: { projectId: string; setId: string; copyId: string }) => {
      const ok = engine.projects
        .get(args.projectId)
        .deleteSocialCopy(args.setId, args.copyId);
      return {
        content: [
          { type: 'text' as const, text: ok ? '已删除' : '找不到对应文案' },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'delete_social_copy_set',
    {
      description: '永久删除一整组文案(包含的所有平台条目)。',
      inputSchema: { projectId: z.string(), setId: z.string() },
    },
    async (args: { projectId: string; setId: string }) => {
      const ok = engine.projects.get(args.projectId).deleteSocialCopySet(args.setId);
      return {
        content: [
          { type: 'text' as const, text: ok ? '已删除文案集' : '找不到' },
        ],
        isError: !ok,
      };
    }
  );

  server.registerTool(
    'set_social_style_note',
    {
      description:
        '设置全局「风格说明」文本 —— 下次生成文案时会被拼进 prompt。空字符串或 null 清除。',
      inputSchema: {
        projectId: z.string(),
        note: z.string().nullable(),
      },
    },
    async (args: { projectId: string; note: string | null }) => {
      engine.projects.get(args.projectId).setSocialStyleNote(args.note);
      return {
        content: [
          {
            type: 'text' as const,
            text: args.note
              ? `风格说明已设为: ${args.note.slice(0, 60)}`
              : '风格说明已清除',
          },
        ],
      };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Generate social copies (was missing from Codex side; parity with Claude)
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'generate_social_copies',
    {
      description:
        '为指定平台生成社群媒体文案。sourceType=rippled 用粗剪后的完整字幕;=variant 则用某个高光变体(需 sourceVariantId)。platforms 数组并行生成。',
      inputSchema: {
        projectId: z.string(),
        sourceType: z.enum(['rippled', 'variant']),
        sourceVariantId: z.string().optional(),
        platforms: z.array(
          z.enum(['xiaohongshu', 'instagram', 'tiktok', 'youtube', 'twitter'])
        ),
        userStyleNote: z.string().optional(),
      },
    },
    async (args: {
      projectId: string;
      sourceType: 'rippled' | 'variant';
      sourceVariantId?: string;
      platforms: string[];
      userStyleNote?: string;
    }) => {
      const project = engine.projects.get(args.projectId);
      if (!project.transcript || project.transcript.segments.length === 0) {
        return {
          content: [{ type: 'text' as const, text: '请先生成字幕后再生成文案。' }],
          isError: true,
        };
      }
      // Inline text-assembly + parallel-generate, mirroring the IPC
      // handler in main/index.ts. We don't delegate through ipcMain so
      // this stays free of Electron-internal coupling.
      let sourceText: string;
      let sourceTitle: string;
      if (args.sourceType === 'variant') {
        if (!args.sourceVariantId) {
          return {
            content: [
              { type: 'text' as const, text: 'sourceType=variant 时必须提供 sourceVariantId' },
            ],
            isError: true,
          };
        }
        const variant = project.findHighlightVariant(args.sourceVariantId);
        if (!variant) {
          return {
            content: [
              { type: 'text' as const, text: `找不到变体 ${args.sourceVariantId}` },
            ],
            isError: true,
          };
        }
        sourceTitle = `高光变体:${variant.title}`;
        const lines: string[] = [];
        for (const vs of variant.segments) {
          for (const t of project.transcript.segments) {
            if (t.end <= vs.start || t.start >= vs.end) continue;
            const txt = t.text.trim();
            if (txt) lines.push(txt);
          }
        }
        sourceText = lines.join('\n');
      } else {
        sourceTitle = '粗剪完整版';
        const lines: string[] = [];
        for (const t of project.transcript.segments) {
          const fullyInCut = project.cutRanges.some(
            (c) => t.start >= c.start && t.end <= c.end
          );
          if (fullyInCut) continue;
          const txt = t.text.trim();
          if (txt) lines.push(txt);
        }
        sourceText = lines.join('\n');
      }

      const { runCopywriterViaCurrentProvider } = await import('./agent-dispatcher');
      const platformResults = await Promise.allSettled(
        args.platforms.map((platform) =>
          runCopywriterViaCurrentProvider({
            sourceTitle,
            sourceText,
            platform: platform as 'xiaohongshu' | 'instagram' | 'tiktok' | 'youtube' | 'twitter',
            userStyleNote: args.userStyleNote ?? project.socialStyleNote ?? undefined,
          })
        )
      );
      const copies: Array<{
        id: string;
        platform: string;
        title: string;
        body: string;
        hashtags: string[];
      }> = [];
      const failures: string[] = [];
      let model: string | undefined;
      for (let i = 0; i < platformResults.length; i++) {
        const r = platformResults[i];
        if (r.status === 'fulfilled') {
          copies.push({
            id: r.value.copy.id,
            platform: r.value.copy.platform,
            title: r.value.copy.title,
            body: r.value.copy.body,
            hashtags: r.value.copy.hashtags,
          });
          if (r.value.model) model = r.value.model;
        } else {
          failures.push(`${args.platforms[i]}: ${(r.reason as Error).message}`);
        }
      }
      if (copies.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: `全部平台生成失败:\n${failures.join('\n')}` },
          ],
          isError: true,
        };
      }
      const setId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      project.addSocialCopySet({
        id: setId,
        sourceType: args.sourceType,
        sourceVariantId: args.sourceVariantId,
        sourceTitle,
        sourceText,
        userStyleNote: args.userStyleNote ?? null,
        copies,
        createdAt: new Date().toISOString(),
        model,
      });
      const summary =
        `生成了 ${copies.length} 个平台的文案。` +
        copies
          .map((c) => `\n- ${c.platform}: ${(c.title || c.body).slice(0, 40)}`)
          .join('') +
        (failures.length > 0 ? `\n\n失败: ${failures.join('\n')}` : '');
      return { content: [{ type: 'text' as const, text: summary }] };
    }
  );

  // ──────────────────────────────────────────────────────────────
  // Export
  // ──────────────────────────────────────────────────────────────
  server.registerTool(
    'export_final_video',
    {
      description:
        '导出最终成片(粗剪执行 ripple 之后的完整视频)。outputPath 必须给绝对路径。mode: fast 流拷贝秒级 / precise 重编码。',
      inputSchema: {
        projectId: z.string(),
        outputPath: z.string(),
        mode: z.enum(['fast', 'precise']).default('fast'),
        quality: z.enum(['low', 'medium', 'high']).default('medium'),
      },
    },
    async (args: {
      projectId: string;
      outputPath: string;
      mode: 'fast' | 'precise';
      quality: 'low' | 'medium' | 'high';
    }) => {
      const project = engine.projects.get(args.projectId);
      const result = await engine.exports.export(project, {
        outputPath: args.outputPath,
        mode: args.mode,
        quality: args.quality,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `导出完成: ${result.outputPath} (${(result.sizeBytes / 1e6).toFixed(1)}MB)`,
          },
        ],
      };
    }
  );

  server.registerTool(
    'export_highlight_variant',
    {
      description: '导出某一个高光变体成单独的视频文件。outputPath 必须给绝对路径。',
      inputSchema: {
        projectId: z.string(),
        variantId: z.string(),
        outputPath: z.string(),
      },
    },
    async (args: { projectId: string; variantId: string; outputPath: string }) => {
      const project = engine.projects.get(args.projectId);
      const variant = project.findHighlightVariant(args.variantId);
      if (!variant) {
        return {
          content: [{ type: 'text' as const, text: `变体 ${args.variantId} 不存在` }],
          isError: true,
        };
      }
      const keepOverride = variant.segments.map((s) => ({
        start: s.start,
        end: s.end,
      }));
      const result = await engine.exports.export(project, {
        outputPath: args.outputPath,
        mode: 'fast',
        quality: 'medium',
        keepOverride,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `变体 ${args.variantId.slice(0, 8)} 导出完成: ${result.outputPath} (${(result.sizeBytes / 1e6).toFixed(1)}MB)`,
          },
        ],
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

      const sessionId = req.headers['mcp-session-id'];
      if (typeof sessionId === 'string' && transports.has(sessionId)) {
        const b = await readJson(req);
        await transports.get(sessionId)!.handleRequest(req, res, b);
        return;
      }

      const body = await readJson(req);
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
