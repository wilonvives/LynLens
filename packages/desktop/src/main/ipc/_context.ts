/**
 * Shared dependencies passed to every `registerXxxIpc(ctx)` call from
 * `main/index.ts`. Keeping it as one object means each domain file has a
 * uniform signature and tests can construct a fake context without
 * understanding which subset a particular handler uses.
 *
 * Mutable runtime values (the BrowserWindow references, the active project
 * id) are exposed as getter functions so domain files always read the latest
 * value — never a snapshot taken at registration time.
 */

import type { BrowserWindow } from 'electron';
import type { LynLensEngine } from '@lynlens/core';

export interface IpcContext {
  /** The shared engine instance — every handler uses it. */
  engine: LynLensEngine;

  // ---- Window accessors (refs may be remounted across the session) ----
  getMainWindow: () => BrowserWindow | null;
  getAgentWindow: () => BrowserWindow | null;
  setAgentWindow: (w: BrowserWindow | null) => void;

  // ---- Active project id (renderer announces; agent window subscribes) ----
  getActiveProjectId: () => string | null;
  setActiveProjectId: (pid: string | null) => void;

  // ---- Cross-window broadcast ----
  broadcast: (channel: string, payload: unknown) => void;

  // ---- Project / file utilities ----
  qcpPathForVideo: (videoPath: string) => string;
  attachProjectWatcher: (projectId: string, qcpPath?: string) => Promise<void>;
  markInternalSave: (projectId: string) => void;

  // ---- Bundled binary lookup ----
  resolveBundledDiarizationBase: () => string | null;

  // ---- Long-running operation registries (owned by index.ts so quit drains them) ----
  activeExports: Map<string, AbortController>;
  activeAgents: Map<string, AbortController>;
  agentSessionByProject: Map<string, string>;

  // ---- Agent window factory ----
  createAgentWindow: () => void;
}
