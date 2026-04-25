import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import { createReadStream, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { promises as fsp } from 'node:fs';
import {
  LynLensEngine,
  WhisperLocalService,
  type FfmpegPaths,
} from '@lynlens/core';
import {
  setCodexContext,
  loadSavedProvider,
} from './agent-dispatcher';
import { startMcpHttpServer, type McpHttpServer } from './mcp-http-server';
import { setupAutoUpdater } from './auto-updater';
import { registerAllIpc, type IpcContext } from './ipc';

// ============================================================================
// Custom protocol + dev/prod boot decision
// ============================================================================

function toWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      (nodeStream as unknown as { destroy: () => void }).destroy?.();
    },
  });
}

function guessMime(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.mkv': return 'video/x-matroska';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.flv': return 'video/x-flv';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    default: return 'application/octet-stream';
  }
}

// Register our custom scheme BEFORE app is ready. Must be privileged for <video>
// streaming (range requests) and to bypass the dev-server CSP.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'lynlens-media',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
      corsEnabled: true,
    },
  },
]);

// Use dev server when explicitly requested (LYNLENS_DEV=1). When packaged, always load built files.
const isDev = !app.isPackaged && process.env.LYNLENS_DEV === '1';

// In dev, use a separate userData directory so a stale dev-mode Electron
// process doesn't prevent this one from starting (Chromium cache is locked
// per profile). Packaged builds keep the standard per-app userData location.
if (isDev) {
  const devUserData = path.join(app.getPath('temp'), 'LynLens-dev');
  app.setPath('userData', devUserData);
}

// ============================================================================
// Bundled binary lookup (ffmpeg / whisper / sherpa-onnx)
// ============================================================================

function resolveBundledFfmpegPaths(): FfmpegPaths | undefined {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const platformDir =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
        : null;
  if (!platformDir) return undefined;

  // Packaged: electron-builder puts them directly under process.resourcesPath/ffmpeg/
  // Dev: read from packages/desktop/resources/ffmpeg/<platform>/ in the repo
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg')
    : path.join(__dirname, '..', '..', '..', 'resources', 'ffmpeg', platformDir);

  const ffmpegBin = path.join(dir, `ffmpeg${exe}`);
  const ffprobeBin = path.join(dir, `ffprobe${exe}`);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    if (fs.existsSync(ffmpegBin)) {
      return { ffmpeg: ffmpegBin, ffprobe: fs.existsSync(ffprobeBin) ? ffprobeBin : 'ffprobe' };
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

function resolveBundledWhisperPaths(): { binaryPath: string; modelPath: string } | null {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const platformDir =
    process.platform === 'win32'
      ? 'win'
      : process.platform === 'darwin'
        ? process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
        : null;
  if (!platformDir) return null;
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'whisper')
    : path.join(__dirname, '..', '..', '..', 'resources', 'whisper', platformDir);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  const binaryPath = path.join(dir, `whisper-cli${exe}`);
  const modelPath = path.join(dir, 'ggml-base.bin');
  if (!fs.existsSync(binaryPath) || !fs.existsSync(modelPath)) return null;
  return { binaryPath, modelPath };
}

/**
 * Locate the sherpa-onnx diarization assets the bootstrap script writes
 * into resources/diarization/<platform>/. Returns null (→ fall back to
 * mock engine) if any piece is missing — keeps the feature opt-in and
 * the app usable on machines without the models.
 */
function resolveBundledDiarizationBase(): string | null {
  const platformDir =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'mac-arm64'
        : 'mac-x64'
      : null;
  if (!platformDir) return null;
  return app.isPackaged
    ? path.join(process.resourcesPath, 'diarization')
    : path.join(__dirname, '..', '..', '..', 'resources', 'diarization', platformDir);
}

// ============================================================================
// Engine instance + bundled service wiring
// ============================================================================

const engine = new LynLensEngine({ ffmpegPaths: resolveBundledFfmpegPaths() });
// Swap in the bundled WhisperLocalService when binaries are available.
{
  const whisper = resolveBundledWhisperPaths();
  if (whisper) {
    engine.setTranscriptionService(
      new WhisperLocalService({
        binaryPath: whisper.binaryPath,
        modelPath: whisper.modelPath,
        ffmpegPaths: engine.ffmpegPaths,
      })
    );
    console.log('[lynlens] whisper.cpp local transcription ready:', whisper.binaryPath);
  } else {
    console.log('[lynlens] whisper binaries not found; transcription disabled');
  }
}

// ============================================================================
// Long-running operation registries (drained on quit)
// ============================================================================

const activeExports = new Map<string, AbortController>();
const activeAgents = new Map<string, AbortController>();
/** Persist session_id per project so chat turns share context ("memory"). */
const agentSessionByProject = new Map<string, string>();

// ============================================================================
// Project file watching + autosave
// ============================================================================

/**
 * File watcher state, keyed by projectId. We watch the .qcp file so that when
 * MCP (or any other process) writes to it, the desktop UI picks up the changes
 * automatically and refreshes its view.
 */
interface WatcherState {
  watcher: FSWatcher;
  qcpPath: string;
  lastInternalSave: number; // ms timestamp; ignore events within 1.5s
  reloadTimer: NodeJS.Timeout | null;
}
const projectWatchers = new Map<string, WatcherState>();
const INTERNAL_SAVE_WINDOW_MS = 1500;

// Auto-persist UI-side mutations to the .qcp sidecar so any other process
// (Claude/MCP) sees them. Debounce to avoid thrashing during bulk operations.
const saveDebouncers = new Map<string, NodeJS.Timeout>();
function scheduleAutosave(projectId: string): void {
  const state = projectWatchers.get(projectId);
  if (!state) return;
  const existing = saveDebouncers.get(projectId);
  if (existing) clearTimeout(existing);
  saveDebouncers.set(
    projectId,
    setTimeout(() => {
      saveDebouncers.delete(projectId);
      markInternalSave(projectId);
      void engine.projects.saveProject(projectId, state.qcpPath).catch((err) => {
        console.error('[lynlens] autosave failed:', err);
      });
    }, 300)
  );
}

/**
 * Derive the conventional sidecar .qcp path for a video (same directory,
 * same basename, .qcp extension). This is the convention shared with MCP.
 */
function qcpPathForVideo(videoPath: string): string {
  const ext = path.extname(videoPath);
  return videoPath.slice(0, videoPath.length - ext.length) + '.qcp';
}

async function attachProjectWatcher(projectId: string, explicitQcpPath?: string): Promise<void> {
  const project = engine.projects.get(projectId);
  const qcpPath = explicitQcpPath ?? qcpPathForVideo(project.videoPath);
  project.projectPath = qcpPath;

  // If file doesn't exist yet, create it so the watcher has something to watch
  // and MCP can read the latest state when it opens.
  try {
    await fsp.access(qcpPath);
  } catch {
    await engine.projects.saveProject(projectId, qcpPath);
  }

  // Close any previous watcher for this project
  detachProjectWatcher(projectId);

  const state: WatcherState = {
    qcpPath,
    lastInternalSave: Date.now(),
    reloadTimer: null,
    watcher: fsWatch(qcpPath, { persistent: false }, (eventType) => {
      if (eventType !== 'change') return;
      // Debounce + skip our own writes within the guard window
      if (Date.now() - state.lastInternalSave < INTERNAL_SAVE_WINDOW_MS) return;
      if (state.reloadTimer) clearTimeout(state.reloadTimer);
      state.reloadTimer = setTimeout(() => {
        void (async () => {
          try {
            await engine.projects.reloadFromDisk(projectId);
            // Core emits 'project.reloaded' via eventBus, which we forward
            // to renderer through the existing onAny subscription.
          } catch (err) {
            console.error('[lynlens] reloadFromDisk failed:', err);
          }
        })();
      }, 200);
    }),
  };
  projectWatchers.set(projectId, state);
}

function detachProjectWatcher(projectId: string): void {
  const s = projectWatchers.get(projectId);
  if (!s) return;
  if (s.reloadTimer) clearTimeout(s.reloadTimer);
  try { s.watcher.close(); } catch { /* ignore */ }
  projectWatchers.delete(projectId);
}

function markInternalSave(projectId: string): void {
  const s = projectWatchers.get(projectId);
  if (s) s.lastInternalSave = Date.now();
}

// Any mutation worth persisting triggers a debounced sidecar save.
engine.eventBus.onAny((ev) => {
  if (
    ev.type === 'segment.added' ||
    ev.type === 'segment.removed' ||
    ev.type === 'segment.resized' ||
    ev.type === 'segment.approved' ||
    ev.type === 'segment.rejected' ||
    ev.type === 'segment.merged' ||
    ev.type === 'mode.changed' ||
    ev.type === 'transcription.completed' ||
    ev.type === 'transcript.updated' ||
    ev.type === 'transcript.suggestion'
  ) {
    scheduleAutosave(ev.projectId);
  }
});

// ============================================================================
// Window lifecycle
// ============================================================================

let mainWindow: BrowserWindow | null = null;
/**
 * Agent popup window — created on demand, destroyed on close. We keep a
 * module-level reference so a second "open agent" click focuses the
 * existing window instead of spawning a duplicate.
 */
let agentWindow: BrowserWindow | null = null;
/**
 * Editor's currently-open project id (null = no project). The main
 * window tells us via `agent-set-active-project-id`; we pass it on to
 * the popup so the chat sticks to the same project.
 */
let activeProjectId: string | null = null;

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#1E1E1E',
    title: 'LynLens',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), // dist/main/main/preload.js relative to dist/main/main/index.js
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    // __dirname = dist/main/main; renderer is at dist/renderer
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));
  }

  // Broadcast engine events to renderer.
  const unsubscribe = engine.eventBus.onAny((event) => {
    broadcast('engine-event', event);
  });
  mainWindow.on('closed', () => {
    unsubscribe();
    mainWindow = null;
  });
}

function createAgentWindow(): void {
  if (agentWindow && !agentWindow.isDestroyed()) {
    agentWindow.show();
    agentWindow.focus();
    return;
  }
  agentWindow = new BrowserWindow({
    width: 480,
    height: 720,
    minWidth: 360,
    minHeight: 480,
    title: 'LynLens Agent',
    // Don't auto-place behind the editor — the user clicked Agent to get a
    // visible chat surface.
    alwaysOnTop: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Same bundle, routed to the ChatPanel via ?panel=chat.
  if (isDev) {
    agentWindow.loadURL('http://localhost:5173/?panel=chat');
  } else {
    agentWindow.loadFile(path.join(__dirname, '../../renderer/index.html'), {
      search: 'panel=chat',
    });
  }
  agentWindow.on('closed', () => {
    agentWindow = null;
  });
}

// ============================================================================
// Custom protocol handler (lynlens-media:///f/<encoded-abs-path>)
// ============================================================================

app.whenReady().then(() => {
  // Use the modern protocol.handle API (Electron 25+). registerFileProtocol is
  // deprecated and has range-request issues in Electron 33.
  protocol.handle('lynlens-media', async (request) => {
    try {
      // URL form: lynlens-media:///f/<urlEncodedAbsolutePath>
      const urlStr = request.url;
      const marker = '/f/';
      const idx = urlStr.indexOf(marker);
      if (idx < 0) return new Response('bad url', { status: 400 });
      const encoded = urlStr.slice(idx + marker.length);
      const filePath = decodeURIComponent(encoded);

      const stat = statSync(filePath);
      const fileSize = stat.size;
      const mime = guessMime(filePath);

      // Handle HTTP Range requests so <video> can seek.
      const rangeHeader = request.headers.get('range');
      if (rangeHeader) {
        const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
        if (match) {
          const start = Number(match[1]);
          const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
          if (start > end || start < 0) {
            return new Response('Range not satisfiable', { status: 416 });
          }
          const chunkSize = end - start + 1;
          const nodeStream = createReadStream(filePath, { start, end });
          return new Response(toWebStream(nodeStream), {
            status: 206,
            headers: {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Content-Type': mime,
            },
          });
        }
      }

      // No range: return whole file. Still advertise Accept-Ranges so the
      // client knows it can resume with range requests later.
      const nodeStream = createReadStream(filePath);
      return new Response(toWebStream(nodeStream), {
        status: 200,
        headers: {
          'Content-Length': String(fileSize),
          'Accept-Ranges': 'bytes',
          'Content-Type': mime,
        },
      });
    } catch (err) {
      console.error('[lynlens-media] error:', err, request.url);
      return new Response(String(err), { status: 500 });
    }
  });

  createWindow();
  setupAutoUpdater(mainWindow);
  // Boot the HTTP MCP server that Codex connects to. Claude doesn't need
  // it (in-process tools), but there's no harm leaving it running. Also
  // restore the last-used provider from disk.
  void (async () => {
    try {
      mcpHttpHandle = await startMcpHttpServer(engine);
      setCodexContext({
        url: mcpHttpHandle.url,
        bearerToken: mcpHttpHandle.bearerToken,
      });
      console.log('[lynlens] MCP HTTP server ready at', mcpHttpHandle.url);
    } catch (err) {
      console.error('[lynlens] failed to start MCP HTTP server:', err);
    }
    await loadSavedProvider();
  })();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

/** Handle to the HTTP MCP server — kept so before-quit can stop it cleanly. */
let mcpHttpHandle: McpHttpServer | null = null;

app.on('before-quit', async () => {
  if (mcpHttpHandle) {
    await mcpHttpHandle.stop().catch(() => {});
    mcpHttpHandle = null;
  }
  // Clean the MCP entry we injected into ~/.codex/config.toml so the user's
  // other Codex sessions don't try to connect to our now-dead localhost port.
  try {
    const { removeCodexMcpEntry } = await import('./agent-codex');
    await removeCodexMcpEntry();
  } catch {
    // best-effort — fine if this fails on quit
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ============================================================================
// IPC registration — every handler lives in main/ipc/<domain>.ts
// ============================================================================

const ipcCtx: IpcContext = {
  engine,
  getMainWindow: () => mainWindow,
  getAgentWindow: () => agentWindow,
  setAgentWindow: (w) => { agentWindow = w; },
  getActiveProjectId: () => activeProjectId,
  setActiveProjectId: (pid) => { activeProjectId = pid; },
  broadcast,
  qcpPathForVideo,
  attachProjectWatcher,
  markInternalSave,
  resolveBundledDiarizationBase,
  activeExports,
  activeAgents,
  agentSessionByProject,
  createAgentWindow,
};
registerAllIpc(ipcCtx);
