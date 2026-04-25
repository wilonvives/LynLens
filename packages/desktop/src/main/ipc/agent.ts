/**
 * Embedded chat agent — provider-agnostic dispatch (Claude SDK or Codex SDK
 * are wired in `agent-dispatcher.ts`). This file owns the IPC surface only.
 * Window lifecycle (open / pin / active-project tracking) lives in
 * `agent-window.ts`.
 */

import { ipcMain } from 'electron';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  runAgentViaCurrentProvider,
  resetAgentSession,
  setProvider,
  getProvider,
  type AgentProvider,
} from '../agent-dispatcher';
import type { AgentEvent } from '../agent';
import type { IpcContext } from './_context';

export function registerAgentIpc(ctx: IpcContext): void {
  const { engine, activeAgents, agentSessionByProject, broadcast } = ctx;

  ipcMain.handle('agent-send', async (_ev, projectId: string, message: string) => {
    // Cancel previous agent run if any
    const prev = activeAgents.get(projectId);
    if (prev) prev.abort();
    const ac = new AbortController();
    activeAgents.set(projectId, ac);
    try {
      const result = await runAgentViaCurrentProvider(engine, {
        projectId,
        message,
        resumeSessionId: agentSessionByProject.get(projectId),
        signal: ac.signal,
        onEvent: (event: AgentEvent) => {
          // Both windows subscribe — editor shows the chip count, popup
          // renders the actual transcript. Same event, fanned out.
          broadcast('agent-event', event);
        },
      });
      if (result.sessionId) {
        agentSessionByProject.set(projectId, result.sessionId);
      }
    } finally {
      activeAgents.delete(projectId);
    }
  });

  ipcMain.handle('agent-cancel', async (_ev, projectId: string) => {
    const ac = activeAgents.get(projectId);
    if (ac) ac.abort();
  });

  ipcMain.handle('agent-reset', async (_ev, projectId: string) => {
    // Drop the stored session so the next message starts a fresh chat.
    agentSessionByProject.delete(projectId);
    // Also clear provider-specific caches (e.g. Codex resumable thread).
    resetAgentSession(projectId);
  });

  ipcMain.handle('agent-get-provider', async () => {
    return getProvider();
  });

  ipcMain.handle('agent-set-provider', async (_ev, provider: AgentProvider) => {
    setProvider(provider);
    // Also reset active sessions — switching mid-conversation would confuse
    // both models since they don't share memory.
    for (const sid of agentSessionByProject.keys()) {
      agentSessionByProject.delete(sid);
    }
  });

  /**
   * Read the current provider's login identity so the chat panel can show
   * "Connected as ...". For Claude that's ~/.claude.json; for Codex it's
   * ~/.codex/auth.json. Returns null if not signed in — renderer shows a
   * "not logged in" warning in that case.
   */
  ipcMain.handle('agent-identity', async () => {
    const provider = getProvider();
    const os = await import('node:os');
    try {
      if (provider === 'claude') {
        const configPath = path.join(os.homedir(), '.claude.json');
        const raw = await fsp.readFile(configPath, 'utf-8');
        const data = JSON.parse(raw) as {
          oauthAccount?: {
            emailAddress?: string;
            displayName?: string;
            organizationName?: string;
            billingType?: string;
          };
        };
        const acc = data.oauthAccount;
        if (!acc?.emailAddress) return null;
        return {
          email: acc.emailAddress,
          displayName: acc.displayName ?? null,
          organization: acc.organizationName ?? null,
          plan: acc.billingType ?? null,
        };
      }
      // Codex: ~/.codex/auth.json has { tokens: { id_token: ... } } where the
      // id_token is a JWT whose payload carries email / ChatGPT plan.
      const configPath = path.join(os.homedir(), '.codex', 'auth.json');
      const raw = await fsp.readFile(configPath, 'utf-8');
      const data = JSON.parse(raw) as {
        tokens?: { id_token?: string };
        OPENAI_API_KEY?: string | null;
      };
      const jwt = data.tokens?.id_token;
      if (jwt) {
        // Decode JWT payload (middle segment) — no verification needed since
        // we're only reading a local file we trust.
        try {
          const parts = jwt.split('.');
          if (parts.length >= 2) {
            const payload = JSON.parse(
              Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
            ) as {
              email?: string;
              name?: string;
              ['https://api.openai.com/auth']?: { chatgpt_plan_type?: string };
            };
            return {
              email: payload.email ?? 'codex-user',
              displayName: payload.name ?? null,
              organization: null,
              plan: payload['https://api.openai.com/auth']?.chatgpt_plan_type ?? null,
            };
          }
        } catch {
          // fall through to api-key branch
        }
      }
      if (data.OPENAI_API_KEY) {
        return {
          email: 'OpenAI API key',
          displayName: null,
          organization: null,
          plan: 'api-key',
        };
      }
      return null;
    } catch {
      return null;
    }
  });
}
