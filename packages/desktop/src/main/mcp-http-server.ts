/**
 * In-process HTTP MCP server.
 *
 * Why this exists: @openai/codex-sdk connects to MCP tools only via external
 * servers (no `createSdkMcpServer` equivalent, unlike Claude Agent SDK).
 * Solution: boot an MCP server inside our Electron main process on localhost,
 * then point Codex at it via `config.mcp_servers.lynlens.transport.url`.
 *
 * Tool definitions come from `./agent-tools/` — shared with `agent.ts`
 * (Claude path) so we register the same 46 tools from ONE source of
 * truth. Only the registration API differs (MCP SDK's `server.registerTool`
 * vs Claude SDK's `tool()`).
 *
 * All handlers close over the live `engine` instance — same in-memory
 * state the Claude path mutates, same EventBus the renderer listens to.
 * The HTTP hop is just the transport.
 *
 * Security: binds to 127.0.0.1, picks a random port, requires a per-launch
 * bearer token so nothing else on the machine can silently invoke LynLens
 * tools. Token is generated fresh each boot; can be overridden via
 * LYNLENS_MCP_DEV_TOKEN env var for terminal debugging.
 *
 * ESM note: main is CommonJS but @modelcontextprotocol/sdk is ESM-only.
 * Same lazy-import trick as agent.ts (new Function wrapper to bypass TS's
 * require() compilation).
 */

import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { LynLensEngine } from '@lynlens/core';
import { ALL_TOOLS } from './agent-tools';

// Lazy ESM imports. Types are loose on purpose — TS's CJS resolution
// doesn't honor the package's `exports` field for subpath .js imports,
// so we'd have to upgrade the whole main tsconfig to NodeNext just to
// get type hints. Not worth it; the MCP SDK's API is stable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpSdk = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StreamableHttpSdk = any;
let mcpSdkPromise: Promise<McpSdk> | null = null;
let streamableHttpSdkPromise: Promise<StreamableHttpSdk> | null = null;

function loadMcpSdk(): Promise<McpSdk> {
  if (!mcpSdkPromise) {
     
    mcpSdkPromise = (new Function('m', 'return import(m)') as (m: string) => Promise<McpSdk>)(
      '@modelcontextprotocol/sdk/server/mcp.js'
    );
  }
  return mcpSdkPromise;
}
function loadStreamableHttpSdk(): Promise<StreamableHttpSdk> {
  if (!streamableHttpSdkPromise) {
     
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
 * Build an MCP server by iterating the shared ALL_TOOLS registry. Each
 * tool def gives us name/description/schema/handler — we hand those to
 * MCP SDK's `server.registerTool()` and capture engine in a closure.
 */
async function buildMcpServer(engine: LynLensEngine) {
  const { McpServer } = await loadMcpSdk();
  const server = new McpServer({ name: 'lynlens-inproc-http', version: '0.1.0' });
  for (const def of ALL_TOOLS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.schema },
      // MCP SDK passes (args, extra) — we only need args.
      async (args: Record<string, unknown>) => def.handler(args, engine)
    );
  }
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
         
        console.warn('[mcp-http] unauthorized request from', req.socket.remoteAddress);
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
