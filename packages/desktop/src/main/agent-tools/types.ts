import type { ZodType } from 'zod';
import type { LynLensEngine } from '@lynlens/core';

/**
 * Normalised MCP-tool-result shape. Both registration APIs we target
 * (Claude Agent SDK's `tool()` and MCP SDK's `server.registerTool()`)
 * accept this shape, so we emit it directly from our handlers.
 */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Single source-of-truth tool definition.
 *
 * We intentionally use `Record<string, ZodType>` (zod raw shape) for
 * schemas — this is what both Claude's `tool()` helper and MCP SDK's
 * `registerTool` expect in their 3rd arg / inputSchema. Keeping the
 * shape uniform lets both servers consume the same list unchanged.
 *
 * Handlers take `args: any` on purpose. Encoding the zod-inferred type
 * here would require generic gymnastics on every call site for minor
 * payoff — each tool file casts args to its own typed struct in the
 * handler body, which is plenty of safety for this surface.
 */
export interface LynLensToolDef {
  name: string;
  description: string;
  schema: Record<string, ZodType>;
  handler: (args: any, engine: LynLensEngine) => Promise<ToolResult>;
}

/**
 * Tiny helper to DRY up the common "boolean success → text result" pattern
 * used by ~40% of our tools. Pass the expected success message and a
 * fallback failure reason; the helper assembles the right ToolResult.
 */
export function okOrFail(ok: boolean, success: string, failure: string): ToolResult {
  return {
    content: [{ type: 'text', text: ok ? success : failure }],
    isError: !ok,
  };
}

/** Short-hand for handlers that just want to return a single text. */
export function text(msg: string): ToolResult {
  return { content: [{ type: 'text', text: msg }] };
}
