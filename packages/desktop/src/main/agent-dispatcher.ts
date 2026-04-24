/**
 * Runtime provider state + routing.
 *
 * Two AI backends coexist:
 *   - 'claude' → @anthropic-ai/claude-agent-sdk (in-process MCP tools)
 *   - 'codex'  → @openai/codex-sdk (HTTP MCP server we boot in main)
 *
 * The active provider is a single module-level variable — every agent
 * entrypoint (chat, highlight generation, copywriter) reads it and
 * dispatches. UI persists the choice to localStorage; main persists the
 * most-recent choice to a small JSON file so app restarts feel stable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { CopywriterGenerateInput, LynLensEngine, SocialCopy } from '@lynlens/core';
import {
  runAgent as runAgentClaude,
  runHighlightGeneration as runHighlightClaude,
  runCopywriterForPlatform as runCopywriterClaude,
  type AgentOptions,
  type AgentResult,
  type AgentEvent,
} from './agent.js';
import {
  runAgent as runAgentCodex,
  runHighlightGeneration as runHighlightCodex,
  runCopywriterForPlatform as runCopywriterCodex,
  clearCodexSession,
  type CodexContext,
} from './agent-codex.js';

export type AgentProvider = 'claude' | 'codex';

let currentProvider: AgentProvider = 'claude';
let codexContext: CodexContext | null = null;

/** Called once at boot after the HTTP MCP server comes up. */
export function setCodexContext(ctx: CodexContext): void {
  codexContext = ctx;
}

export function getProvider(): AgentProvider {
  return currentProvider;
}

export function setProvider(p: AgentProvider): void {
  currentProvider = p;
  void persistProvider(p).catch(() => {
    /* best-effort: next boot falls back to default, not fatal */
  });
}

/**
 * Restore the last-used provider from disk. Called on app ready.
 * Silently defaults to 'claude' if the file is missing or corrupt.
 */
export async function loadSavedProvider(): Promise<void> {
  try {
    const raw = await fs.readFile(providerFile(), 'utf8');
    const parsed = JSON.parse(raw) as { provider?: unknown };
    if (parsed.provider === 'claude' || parsed.provider === 'codex') {
      currentProvider = parsed.provider;
    }
  } catch {
    // file missing or unreadable — use default
  }
}

async function persistProvider(p: AgentProvider): Promise<void> {
  await fs.writeFile(providerFile(), JSON.stringify({ provider: p }), 'utf8');
}

function providerFile(): string {
  return path.join(app.getPath('userData'), 'agent-provider.json');
}

// ────────────────────────────────────────────────────────────────────────
// Dispatch entrypoints — every caller in main/index.ts uses these instead
// of calling runAgent / runHighlight / runCopywriter directly, so the
// provider flip is the only switch needed.
// ────────────────────────────────────────────────────────────────────────

export async function runAgentViaCurrentProvider(
  engine: LynLensEngine,
  options: AgentOptions
): Promise<AgentResult> {
  if (currentProvider === 'codex') {
    if (!codexContext) throw new Error('Codex context not initialized');
    return runAgentCodex(engine, codexContext, options);
  }
  return runAgentClaude(engine, options);
}

/**
 * Shared one-shot entry used by (a) the main process when the UI triggers
 * highlight / copywriter generation directly, and (b) the HTTP MCP server
 * when Codex invokes those tools during chat. Both paths need the same
 * current-provider behavior.
 */
export async function runOneShotViaCurrentProvider(
  systemPrompt: string,
  userPrompt: string
): Promise<{ text: string; model?: string }> {
  if (currentProvider === 'codex') {
    if (!codexContext) throw new Error('Codex context not initialized');
    return runHighlightCodex({ systemPrompt, userPrompt, codex: codexContext });
  }
  return runHighlightClaude({ systemPrompt, userPrompt });
}

export async function runCopywriterViaCurrentProvider(
  input: CopywriterGenerateInput
): Promise<{ copy: SocialCopy; model?: string }> {
  if (currentProvider === 'codex') {
    if (!codexContext) throw new Error('Codex context not initialized');
    return runCopywriterCodex(input, codexContext);
  }
  return runCopywriterClaude(input);
}

/** Forward reset for the currently-active provider. */
export function resetAgentSession(projectId: string): void {
  if (currentProvider === 'codex') {
    clearCodexSession(projectId);
  }
  // Claude reset is handled by agent.ts's existing IPC handler; no-op here.
}

export type { AgentEvent, AgentOptions, AgentResult };
