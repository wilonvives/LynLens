/**
 * Shared tool registry used by BOTH agent servers:
 *   - Claude Agent SDK (in-process MCP) → `agent.ts`
 *   - OpenAI Codex (external HTTP MCP)  → `mcp-http-server.ts`
 *
 * Each server iterates `ALL_TOOLS` and calls its own registration API
 * (Claude's `tool()` vs MCP SDK's `server.registerTool()`), so adding
 * or tweaking a tool only requires editing ONE file in this directory.
 *
 * Category files (find-a-tool guide):
 *   project.ts    — get_state, transcribe, save, set_mode
 *   segments.ts   — delete-segment CRUD + approve/reject + ripple + AI mark
 *   transcript.ts — subtitle text edits + suggestions + time adjust
 *   speakers.ts   — diarization + rename/merge/auto-assign/clear
 *   highlights.ts — variant generate + pin/delete + segment-level edits
 *   social.ts     — copywriter generate + edit + style note
 *   export.ts     — final video + highlight variant export
 */

import type { LynLensToolDef } from './types';
import { projectTools } from './project';
import { segmentTools } from './segments';
import { transcriptTools } from './transcript';
import { speakerTools } from './speakers';
import { highlightTools } from './highlights';
import { socialTools } from './social';
import { exportTools } from './export';

export const ALL_TOOLS: LynLensToolDef[] = [
  ...projectTools,
  ...segmentTools,
  ...transcriptTools,
  ...speakerTools,
  ...highlightTools,
  ...socialTools,
  ...exportTools,
];

export { type LynLensToolDef, type ToolResult } from './types';
