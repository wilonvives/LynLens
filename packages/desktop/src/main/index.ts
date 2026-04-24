import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import path from 'node:path';
import { createReadStream, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { promises as fsp } from 'node:fs';
import {
  LynLensEngine,
  MockDiarizationEngine,
  WhisperLocalService,
  buildHighlightSystemPrompt,
  buildHighlightUserPrompt,
  detectFillers,
  detectRetakes,
  detectSilences,
  extractWaveform,
  parseHighlightResponse,
  type FfmpegPaths,
  type HighlightStyle,
  type SocialPlatform,
} from '@lynlens/core';
import type { AddSegmentRequest, ExportRequest } from '../shared/ipc-types';
import {
  runAgent,
  runCopywriterForPlatform,
  runHighlightGeneration,
  type AgentEvent,
} from './agent';
import { setupAutoUpdater } from './auto-updater';

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
  const fs = require('node:fs') as typeof import('node:fs');
  const binaryPath = path.join(dir, `whisper-cli${exe}`);
  const modelPath = path.join(dir, 'ggml-base.bin');
  if (!fs.existsSync(binaryPath) || !fs.existsSync(modelPath)) return null;
  return { binaryPath, modelPath };
}

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
    // eslint-disable-next-line no-console
    console.log('[lynlens] whisper.cpp local transcription ready:', whisper.binaryPath);
  } else {
    // eslint-disable-next-line no-console
    console.log('[lynlens] whisper binaries not found; transcription disabled');
  }
}
const activeExports = new Map<string, AbortController>();

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
        // eslint-disable-next-line no-console
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
            // eslint-disable-next-line no-console
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

let mainWindow: BrowserWindow | null = null;

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
    if (!mainWindow?.isDestroyed()) {
      mainWindow?.webContents.send('engine-event', event);
    }
  });
  mainWindow.on('closed', () => {
    unsubscribe();
    mainWindow = null;
  });
}

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
      // eslint-disable-next-line no-console
      console.error('[lynlens-media] error:', err, request.url);
      return new Response(String(err), { status: 500 });
    }
  });

  createWindow();
  setupAutoUpdater(mainWindow);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC handlers ----------

function toMediaUrl(absPath: string): string {
  // Fully percent-encode the path (including : / \) so Chromium treats the
  // whole thing as opaque path and doesn't try to parse "C:" as host:port.
  return `lynlens-media:///f/${encodeURIComponent(absPath)}`;
}

ipcMain.handle('open-video-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'flv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const videoPath = result.filePaths[0];
  // Detect existing <video>.qcp sidecar and load it if present
  const qcpPath = qcpPathForVideo(videoPath);
  let existingQcp: string | undefined;
  try {
    await fsp.access(qcpPath);
    existingQcp = qcpPath;
  } catch { /* no existing sidecar */ }
  const project = await engine.openFromVideo({ videoPath, projectPath: existingQcp });
  await attachProjectWatcher(project.id, qcpPath);
  return {
    projectId: project.id,
    videoMeta: project.videoMeta,
    videoPath,
    videoUrl: toMediaUrl(videoPath),
  };
});

ipcMain.handle('open-video-by-path', async (_ev, videoPath: string) => {
  const qcpPath = qcpPathForVideo(videoPath);
  let existingQcp: string | undefined;
  try {
    await fsp.access(qcpPath);
    existingQcp = qcpPath;
  } catch { /* no existing sidecar */ }
  const project = await engine.openFromVideo({ videoPath, projectPath: existingQcp });
  await attachProjectWatcher(project.id, qcpPath);
  return {
    projectId: project.id,
    videoMeta: project.videoMeta,
    videoPath,
    videoUrl: toMediaUrl(videoPath),
  };
});

async function openProjectFromQcpPath(qcpPath: string) {
  const raw = await fsp.readFile(qcpPath, 'utf-8');
  const parsed = JSON.parse(raw) as { videoPath: string };
  const project = await engine.openFromVideo({
    videoPath: parsed.videoPath,
    projectPath: qcpPath,
  });
  await attachProjectWatcher(project.id, qcpPath);
  return {
    projectId: project.id,
    videoMeta: project.videoMeta,
    videoPath: parsed.videoPath,
    videoUrl: toMediaUrl(parsed.videoPath),
  };
}

ipcMain.handle('open-project-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'LynLens Project', extensions: ['qcp'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return openProjectFromQcpPath(result.filePaths[0]);
});

ipcMain.handle('open-project-by-path', async (_ev, qcpPath: string) => {
  // Used by drag-and-drop: user dropped a .qcp file onto the app. Same code
  // path as the menu dialog, just skips the native file picker.
  return openProjectFromQcpPath(qcpPath);
});

ipcMain.handle('save-dialog', async (_ev, defaultName: string) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: defaultName,
    filters: [{ name: 'Video', extensions: ['mp4', 'mov'] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

ipcMain.handle('add-segment', async (_ev, req: AddSegmentRequest) => {
  const project = engine.projects.get(req.projectId);
  return project.segments.add({
    start: req.start,
    end: req.end,
    source: req.source,
    reason: req.reason ?? null,
    confidence: req.confidence,
    aiModel: req.aiModel,
  });
});

ipcMain.handle('remove-segment', async (_ev, projectId: string, segmentId: string) => {
  const project = engine.projects.get(projectId);
  project.segments.remove(segmentId);
});

ipcMain.handle('erase-range', async (_ev, projectId: string, start: number, end: number) => {
  const project = engine.projects.get(projectId);
  project.segments.eraseRange(start, end);
});

ipcMain.handle('resize-segment', async (_ev, projectId: string, segmentId: string, start: number, end: number) => {
  const project = engine.projects.get(projectId);
  return project.segments.resize(segmentId, start, end);
});

ipcMain.handle('approve-segment', async (_ev, projectId: string, segmentId: string) => {
  engine.projects.get(projectId).segments.approve(segmentId);
});

ipcMain.handle('reject-segment', async (_ev, projectId: string, segmentId: string) => {
  engine.projects.get(projectId).segments.reject(segmentId);
});

ipcMain.handle('undo', async (_ev, projectId: string) => {
  return engine.projects.get(projectId).segments.undo();
});
ipcMain.handle('redo', async (_ev, projectId: string) => {
  return engine.projects.get(projectId).segments.redo();
});

ipcMain.handle('get-state', async (_ev, projectId: string) => {
  return engine.projects.get(projectId).toQcp();
});

ipcMain.handle('save-project', async (_ev, projectId: string, outputPath?: string) => {
  let target = outputPath;
  if (!target) {
    const project = engine.projects.get(projectId);
    const defaultName =
      path.basename(project.videoPath, path.extname(project.videoPath)) + '.qcp';
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: defaultName,
      filters: [{ name: 'LynLens Project', extensions: ['qcp'] }],
    });
    if (result.canceled || !result.filePath) throw new Error('Save canceled');
    target = result.filePath;
  }
  markInternalSave(projectId);
  return engine.projects.saveProject(projectId, target);
});

/**
 * Forwards the conventional .qcp path for the current project so the UI can
 * build a "copy-paste to Claude Code" command referencing it.
 */
ipcMain.handle('get-qcp-path', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  return project.projectPath ?? qcpPathForVideo(project.videoPath);
});

/**
 * Ensure the current project is persisted to its .qcp sidecar (so Claude /
 * MCP can read it). Used by the UI's "交给 Claude" button.
 */
ipcMain.handle('flush-project', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  const target = project.projectPath ?? qcpPathForVideo(project.videoPath);
  markInternalSave(projectId);
  await engine.projects.saveProject(projectId, target);
  return target;
});

ipcMain.handle('get-waveform', async (_ev, projectId: string, _buckets: number) => {
  const project = engine.projects.get(projectId);
  // Adaptive bucket count: ~500 buckets/sec (2ms precision) for sharp zoom detail.
  // Capped so very long videos stay under ~4 MB of Float32 data.
  const duration = project.videoMeta.duration || 60;
  const buckets = Math.min(1_000_000, Math.max(8000, Math.round(duration * 500)));
  const env = await extractWaveform(project.videoPath, buckets, engine.ffmpegPaths);
  return { peak: Array.from(env.peak), rms: Array.from(env.rms) };
});

ipcMain.handle('export', async (_ev, req: ExportRequest) => {
  const project = engine.projects.get(req.projectId);
  const existing = activeExports.get(req.projectId);
  if (existing) existing.abort();
  const ac = new AbortController();
  activeExports.set(req.projectId, ac);
  try {
    const result = await engine.exports.export(project, {
      outputPath: req.outputPath,
      mode: req.mode,
      quality: req.quality,
      signal: ac.signal,
      // CRITICAL: forward the bundled ffmpeg binary. Without this, export
      // tries literal 'ffmpeg' from PATH and ENOENTs on machines without
      // system ffmpeg installed. Probe works even without this because
      // probeVideo already threads engine.ffmpegPaths through its own IPC.
      ffmpegPaths: engine.ffmpegPaths,
    });
    return result;
  } finally {
    activeExports.delete(req.projectId);
  }
});

ipcMain.handle('cancel-export', async (_ev, projectId: string) => {
  const ac = activeExports.get(projectId);
  if (ac) ac.abort();
});

// ---- Embedded Claude agent ----
const activeAgents = new Map<string, AbortController>();
/** Persist session_id per project so chat turns share context ("memory"). */
const agentSessionByProject = new Map<string, string>();

ipcMain.handle('agent-send', async (_ev, projectId: string, message: string) => {
  // Cancel previous agent run if any
  const prev = activeAgents.get(projectId);
  if (prev) prev.abort();
  const ac = new AbortController();
  activeAgents.set(projectId, ac);
  try {
    const result = await runAgent(engine, {
      projectId,
      message,
      resumeSessionId: agentSessionByProject.get(projectId),
      signal: ac.signal,
      onEvent: (event: AgentEvent) => {
        if (!mainWindow?.isDestroyed()) {
          mainWindow?.webContents.send('agent-event', event);
        }
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
});

/**
 * Read the user's Claude Code OAuth identity (email / display name / plan)
 * from ~/.claude.json so the chat panel can show "Connected as ...".
 */
ipcMain.handle('agent-identity', async () => {
  try {
    const os = await import('node:os');
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
  } catch {
    return null;
  }
});

ipcMain.handle(
  'ai-mark-silence',
  async (_ev, projectId: string, opts: { minPauseSec: number; silenceThreshold: number }) => {
    const project = engine.projects.get(projectId);
    const env = await extractWaveform(project.videoPath, 4000, engine.ffmpegPaths);
    const silences = detectSilences(env.peak, project.videoMeta.duration, opts);
    const ids: string[] = [];

    for (const s of silences) {
      const seg = project.segments.add({
        start: s.start,
        end: s.end,
        source: 'ai',
        reason: s.reason,
        confidence: 0.75,
        aiModel: 'builtin-silence-detector',
      });
      ids.push(seg.id);
    }

    // If the project has a transcript, also flag filler/hesitation words and
    // near-duplicate retakes. These complement the pure silence heuristic.
    let fillerCount = 0;
    let retakeCount = 0;
    if (project.transcript) {
      for (const f of detectFillers(project.transcript)) {
        const seg = project.segments.add({
          start: f.start,
          end: f.end,
          source: 'ai',
          reason: f.reason,
          confidence: f.confidence,
          aiModel: 'builtin-filler-detector',
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
          aiModel: 'builtin-retake-detector',
        });
        ids.push(seg.id);
        retakeCount += 1;
      }
    }

    return {
      added: ids.length,
      segmentIds: ids,
      breakdown: {
        silences: silences.length,
        fillers: fillerCount,
        retakes: retakeCount,
      },
    };
  }
);

ipcMain.handle('approve-all-pending', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  const pending = project.segments.list().filter((s) => s.status === 'pending');
  for (const s of pending) project.segments.approve(s.id, 'human');
  return pending.length;
});

ipcMain.handle('reject-all-pending', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  const pending = project.segments.list().filter((s) => s.status === 'pending');
  for (const s of pending) project.segments.reject(s.id, 'human');
  return pending.length;
});

ipcMain.handle('commit-ripple', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  return project.commitRipple();
});

ipcMain.handle(
  'revert-ripple',
  async (_ev, projectId: string, segmentId: string) => {
    const project = engine.projects.get(projectId);
    return project.revertRipple(segmentId);
  }
);

ipcMain.handle(
  'generate-highlights',
  async (
    _ev,
    projectId: string,
    opts: { style: HighlightStyle; count: number; targetSeconds: number }
  ) => {
    const project = engine.projects.get(projectId);
    if (!project.transcript || project.transcript.segments.length === 0) {
      throw new Error('请先生成字幕后再生成高光变体');
    }
    const effectiveDuration = project.getEffectiveDuration();
    const systemPrompt = buildHighlightSystemPrompt();
    const userPrompt = buildHighlightUserPrompt({
      transcript: project.transcript,
      cutRanges: project.cutRanges,
      effectiveDuration,
      style: opts.style,
      count: Math.max(1, Math.min(5, Math.floor(opts.count || 1))),
      targetSeconds: Math.max(5, Math.floor(opts.targetSeconds || 30)),
    });
    const { text, model } = await runHighlightGeneration({ systemPrompt, userPrompt });
    const variants = parseHighlightResponse(text, project.cutRanges, model);
    project.setHighlightVariants(variants);
    return variants;
  }
);

ipcMain.handle('get-highlights', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  return project.highlightVariants;
});

ipcMain.handle('clear-highlights', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  project.clearHighlightVariants();
});

ipcMain.handle(
  'export-highlight',
  async (_ev, projectId: string, variantId: string, outputPath: string) => {
    const project = engine.projects.get(projectId);
    const variant = project.findHighlightVariant(variantId);
    if (!variant) throw new Error(`Highlight variant not found: ${variantId}`);
    const keepOverride = variant.segments.map((s) => ({ start: s.start, end: s.end }));
    const existing = activeExports.get(projectId);
    if (existing) existing.abort();
    const ac = new AbortController();
    activeExports.set(projectId, ac);
    try {
      return await engine.exports.export(project, {
        outputPath,
        mode: 'fast',          // stream copy, identical bytes
        quality: 'original',    // irrelevant for fast mode
        signal: ac.signal,
        ffmpegPaths: engine.ffmpegPaths,
        keepOverride,
      });
    } finally {
      activeExports.delete(projectId);
    }
  }
);

// ============================================================================
// Social copy (文案 tab) — generate / read / edit / delete
// ============================================================================

/**
 * Assemble transcript text for a given source. We keep the two
 * helpers private to this handler so core stays pure and the
 * file-system-free shape of the engine isn't disturbed.
 */
function assembleRippledSourceText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  cutRanges: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const t of transcriptSegs) {
    const fullyInCut = cutRanges.some((c) => t.start >= c.start && t.end <= c.end);
    if (fullyInCut) continue;
    const txt = t.text.trim();
    if (txt) lines.push(txt);
  }
  return lines.join('\n');
}

function assembleVariantSourceText(
  transcriptSegs: ReadonlyArray<{ start: number; end: number; text: string }>,
  variantSegs: ReadonlyArray<{ start: number; end: number }>
): string {
  const lines: string[] = [];
  for (const v of variantSegs) {
    for (const t of transcriptSegs) {
      if (t.end <= v.start || t.start >= v.end) continue;
      const txt = t.text.trim();
      if (txt) lines.push(txt);
    }
  }
  return lines.join('\n');
}

ipcMain.handle(
  'generate-social-copies',
  async (
    _ev,
    projectId: string,
    opts: {
      sourceType: 'rippled' | 'variant';
      sourceVariantId?: string;
      platforms: SocialPlatform[];
      userStyleNote?: string;
    }
  ) => {
    const project = engine.projects.get(projectId);
    if (!project.transcript || project.transcript.segments.length === 0) {
      throw new Error('请先生成字幕后再生成文案');
    }

    let sourceTitle: string;
    let sourceText: string;
    if (opts.sourceType === 'variant') {
      if (!opts.sourceVariantId) {
        throw new Error('sourceType=variant 时必须提供 sourceVariantId');
      }
      const variant = project.findHighlightVariant(opts.sourceVariantId);
      if (!variant) {
        throw new Error(`找不到变体 ${opts.sourceVariantId}`);
      }
      sourceTitle = `高光变体：${variant.title}`;
      sourceText = assembleVariantSourceText(project.transcript.segments, variant.segments);
    } else {
      sourceTitle = '粗剪完整版';
      sourceText = assembleRippledSourceText(project.transcript.segments, project.cutRanges);
    }

    if (!sourceText.trim()) {
      throw new Error('拼装出来的源文本为空,请先完成字幕和剪辑');
    }

    // Per-platform calls in parallel. allSettled lets us surface partial
    // successes — one platform hiccup shouldn't wipe out the others.
    const results = await Promise.allSettled(
      opts.platforms.map((platform) =>
        runCopywriterForPlatform({
          sourceTitle,
          sourceText,
          platform,
          userStyleNote: opts.userStyleNote ?? project.socialStyleNote ?? undefined,
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
    const failures: Array<{ platform: SocialPlatform; error: string }> = [];
    let model: string | undefined;

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        if (r.value.model) model = r.value.model;
        copies.push({
          id: r.value.copy.id,
          platform: r.value.copy.platform,
          title: r.value.copy.title,
          body: r.value.copy.body,
          hashtags: r.value.copy.hashtags,
        });
      } else {
        failures.push({
          platform: opts.platforms[i],
          error: (r.reason as Error).message,
        });
      }
    }

    if (copies.length === 0) {
      throw new Error(
        '全部平台都生成失败:\n' +
          failures.map((f) => `${f.platform}: ${f.error}`).join('\n')
      );
    }

    const setId = `sc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    project.addSocialCopySet({
      id: setId,
      sourceType: opts.sourceType,
      sourceVariantId: opts.sourceVariantId,
      sourceTitle,
      sourceText,
      userStyleNote: opts.userStyleNote ?? null,
      copies,
      createdAt,
      model,
    });

    // Persist immediately so a crash before Ctrl+S doesn't lose the copy.
    if (project.projectPath) {
      await engine.projects.saveProject(projectId);
    }

    return {
      setId,
      copies,
      failures,
    };
  }
);

ipcMain.handle('get-social-copies', async (_ev, projectId: string) => {
  return engine.projects.get(projectId).socialCopies;
});

ipcMain.handle(
  'update-social-copy',
  async (
    _ev,
    projectId: string,
    setId: string,
    copyId: string,
    patch: { title?: string; body?: string; hashtags?: string[] }
  ) => {
    const project = engine.projects.get(projectId);
    const ok = project.updateSocialCopy(setId, copyId, patch);
    if (ok && project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
    return ok;
  }
);

ipcMain.handle(
  'delete-social-copy',
  async (_ev, projectId: string, setId: string, copyId: string) => {
    const project = engine.projects.get(projectId);
    const ok = project.deleteSocialCopy(setId, copyId);
    if (ok && project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
    return ok;
  }
);

ipcMain.handle(
  'delete-social-copy-set',
  async (_ev, projectId: string, setId: string) => {
    const project = engine.projects.get(projectId);
    const ok = project.deleteSocialCopySet(setId);
    if (ok && project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
    return ok;
  }
);

ipcMain.handle(
  'set-social-style-note',
  async (_ev, projectId: string, note: string | null) => {
    const project = engine.projects.get(projectId);
    project.setSocialStyleNote(note);
    if (project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
  }
);

ipcMain.handle(
  'add-social-style-preset',
  async (_ev, projectId: string, name: string, content: string) => {
    const project = engine.projects.get(projectId);
    const preset = project.addSocialStylePreset(name, content);
    if (project.projectPath) await engine.projects.saveProject(projectId);
    return preset;
  }
);

ipcMain.handle(
  'update-social-style-preset',
  async (
    _ev,
    projectId: string,
    presetId: string,
    patch: { name?: string; content?: string }
  ) => {
    const project = engine.projects.get(projectId);
    const ok = project.updateSocialStylePreset(presetId, patch);
    if (ok && project.projectPath) await engine.projects.saveProject(projectId);
    return ok;
  }
);

ipcMain.handle(
  'delete-social-style-preset',
  async (_ev, projectId: string, presetId: string) => {
    const project = engine.projects.get(projectId);
    const ok = project.deleteSocialStylePreset(presetId);
    if (ok && project.projectPath) await engine.projects.saveProject(projectId);
    return ok;
  }
);

ipcMain.handle('get-social-style-presets', async (_ev, projectId: string) => {
  return engine.projects.get(projectId).socialStylePresets;
});

// ============================================================================
// Diarization (speaker labeling) — MVP
// ============================================================================
//
// Today this is backed by MockDiarizationEngine (deterministic, no audio).
// When we bundle sherpa-onnx, we swap the engine instance here — the IPC
// contract doesn't change.
//
// Isolation: failures throw to the renderer; project state is NEVER modified
// on failure. Missing transcript is a caller-side error (renderer disables
// the button), not a silent no-op.

ipcMain.handle('diarize', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  if (!project.transcript || project.transcript.segments.length === 0) {
    throw new Error('请先生成字幕后再区分说话人');
  }
  const diarEngine = new MockDiarizationEngine(() => project.transcript);
  const result = await diarEngine.diarize(project.videoPath);
  project.applyDiarization(result);
  if (project.projectPath) {
    await engine.projects.saveProject(projectId);
  }
  return {
    engine: result.engine,
    speakers: result.speakers,
    segmentCount: result.segments.length,
  };
});

ipcMain.handle(
  'rename-speaker',
  async (_ev, projectId: string, speakerId: string, name: string | null) => {
    const project = engine.projects.get(projectId);
    project.renameSpeaker(speakerId, name);
    if (project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
  }
);

ipcMain.handle('clear-speakers', async (_ev, projectId: string) => {
  const project = engine.projects.get(projectId);
  project.clearSpeakers();
  if (project.projectPath) {
    await engine.projects.saveProject(projectId);
  }
});

ipcMain.handle(
  'update-transcript-segment',
  async (_ev, projectId: string, segmentId: string, newText: string) => {
    const project = engine.projects.get(projectId);
    return project.updateTranscriptSegment(segmentId, newText);
  }
);

ipcMain.handle(
  'replace-in-transcript',
  async (_ev, projectId: string, find: string, replace: string) => {
    const project = engine.projects.get(projectId);
    return project.replaceInTranscript(find, replace);
  }
);

ipcMain.handle(
  'set-user-orientation',
  async (_ev, projectId: string, o: 'landscape' | 'portrait' | null) => {
    engine.projects.get(projectId).setUserOrientation(o);
  }
);

ipcMain.handle(
  'set-preview-rotation',
  async (_ev, projectId: string, rotation: 0 | 90 | 180 | 270) => {
    const project = engine.projects.get(projectId);
    project.setPreviewRotation(rotation);
    // Persist immediately so the rotation survives app restarts even if
    // the user never hits Ctrl+S.
    if (project.projectPath) {
      await engine.projects.saveProject(projectId);
    }
  }
);

ipcMain.handle(
  'accept-transcript-suggestion',
  async (_ev, projectId: string, segmentId: string) => {
    return engine.projects.get(projectId).acceptTranscriptSuggestion(segmentId);
  }
);

ipcMain.handle(
  'clear-transcript-suggestion',
  async (_ev, projectId: string, segmentId: string) => {
    return engine.projects.get(projectId).clearTranscriptSuggestion(segmentId);
  }
);

ipcMain.handle(
  'transcribe',
  async (
    _ev,
    projectId: string,
    opts: { engine?: 'whisper-local' | 'openai-api'; language?: string }
  ) => {
    const project = engine.projects.get(projectId);
    engine.eventBus.emit({
      type: 'transcription.started',
      projectId,
      engine: opts.engine ?? 'whisper-local',
    });
    try {
      const transcript = await engine.transcription.transcribe(project.videoPath, {
        engine: opts.engine,
        language: opts.language,
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
        language: transcript.language,
        engine: transcript.engine,
        segmentCount: transcript.segments.length,
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

