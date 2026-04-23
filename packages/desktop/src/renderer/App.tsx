import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveToSource,
  getEffectiveDuration,
  sourceToEffective,
  type LynLensEvent,
  type Segment,
} from './core-browser';
import { Timeline } from './Timeline';
import { ExportDialog } from './ExportDialog';
import { ChatPanel } from './ChatPanel';
import { SubtitlePanel } from './SubtitlePanel';
import { OrientationDialog } from './OrientationDialog';
import { QuickMarkDialog } from './QuickMarkDialog';
import { HighlightPanel } from './HighlightPanel';
import { SocialCopyPanel } from './SocialCopyPanel';
import { Resizer } from './Resizer';

type WorkMode = 'precision' | 'highlight' | 'copywriter';

function usePersistedSize(key: string, defaultValue: number): [number, (n: number) => void] {
  const [value, setValue] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultValue;
    const raw = window.localStorage.getItem(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : defaultValue;
  });
  const set = useCallback(
    (n: number) => {
      setValue(n);
      window.localStorage.setItem(key, String(n));
    },
    [key]
  );
  return [value, set];
}
import { useStore } from './store';
import { formatBytes, formatTime } from './util';

type SegmentFilter = 'all' | 'human' | 'ai' | 'pending';

export function App() {
  const store = useStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [segFilter, setSegFilter] = useState<SegmentFilter>('all');
  const [chatOpen, setChatOpen] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<'segments' | 'subtitles'>('segments');
  const [showOrientDialog, setShowOrientDialog] = useState(false);
  const [showQuickMarkDialog, setShowQuickMarkDialog] = useState(false);
  const [workMode, setWorkMode] = useState<WorkMode>('precision');

  // Persisted panel sizes so the user's preferred layout survives restarts.
  const [sidebarWidth, setSidebarWidth] = usePersistedSize('lynlens.sidebarWidth', 340);
  const [chatWidth, setChatWidth] = usePersistedSize('lynlens.chatWidth', 380);
  const [timelineHeight, setTimelineHeight] = usePersistedSize('lynlens.timelineHeight', 210);

  // Track a "brush paint" state: while holding D, paint marks as playhead moves.
  const brushRef = useRef<{ start: number } | null>(null);

  /**
   * Preview-only rotation, in degrees. PURELY VISUAL: applied as a CSS
   * transform on the <video> element, never sent to ffmpeg on export. The
   * source video and all exported output keep their original orientation
   * metadata intact. We DO persist the choice into the .qcp (as
   * previewRotation) so re-opening a project remembers the last angle —
   * same shape as userOrientation: a display preference, not a content edit.
   */
  const [previewRotation, setPreviewRotation] = useState<0 | 90 | 180 | 270>(0);
  useEffect(() => {
    if (!store.projectId) {
      setPreviewRotation(0);
      return;
    }
    let cancelled = false;
    void window.lynlens.getState(store.projectId).then((qcp) => {
      if (cancelled) return;
      const r = qcp.previewRotation;
      if (r === 90 || r === 180 || r === 270) setPreviewRotation(r);
      else setPreviewRotation(0);
    });
    return () => {
      cancelled = true;
    };
  }, [store.projectId]);

  /**
   * Switch between 粗剪 and 高光 tabs.
   *
   * Going precision → highlight: free (just changes what's rendered).
   *
   * Going highlight → precision: variants reference source-time ranges
   * that are only meaningful relative to the current cutRanges. If the
   * user ripples again, those variants desync. Rather than trying to
   * migrate them, we clear them on switch-back and warn the user so they
   * can export first if they want to keep any.
   */
  const switchMode = useCallback(
    async (next: WorkMode) => {
      if (next === workMode) return;
      if (next === 'precision' && store.projectId) {
        const pid = store.projectId;
        const currentVariants = await window.lynlens.getHighlights(pid);
        if (currentVariants.length > 0) {
          const ok = confirm(
            `返回粗剪会清空当前 ${currentVariants.length} 个高光变体。` +
              '建议先导出你想保留的变体。继续?'
          );
          if (!ok) return;
          await window.lynlens.clearHighlights(pid);
        }
      }
      setWorkMode(next);
    },
    [workMode, store.projectId]
  );

  const rotatePreview = useCallback(() => {
    setPreviewRotation((prev) => {
      const next = ((prev + 90) % 360) as 0 | 90 | 180 | 270;
      const pid = store.projectId;
      if (pid) {
        // Fire-and-forget: main persists into the .qcp so next session picks
        // it up via the hydration effect above.
        void window.lynlens.setPreviewRotation(pid, next);
      }
      return next;
    });
  }, [store.projectId]);

  /**
   * When the preview is rotated 90° or 270°, the video's pre-rotation
   * bounding box needs to be constrained by the container's SWAPPED
   * dimensions so that after the CSS rotate() the visible frame lands back
   * inside the container. We measure the container with a ResizeObserver so
   * this survives panel resizes.
   */
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const [playerWrapSize, setPlayerWrapSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = playerWrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setPlayerWrapSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /**
   * Source-time ranges that are currently rippled out of the effective
   * timeline. Derived from segments with status='cut' so there's one source
   * of truth. When empty, every effective↔source helper below is identity
   * and the UI behaves exactly as before any ripple.
   */
  const cutRanges = useMemo(
    () =>
      store.segments
        .filter((s) => s.status === 'cut')
        .map((s) => ({ start: s.start, end: s.end }))
        .sort((a, b) => a.start - b.start),
    [store.segments]
  );

  // Apply engine events and trigger state refresh for segment changes.
  useEffect(() => {
    const off = window.lynlens.onEngineEvent(async (event: LynLensEvent) => {
      store.applyEvent(event);
      if (
        event.type.startsWith('segment.') ||
        event.type === 'project.opened' ||
        event.type === 'project.saved'
      ) {
        if (store.projectId) {
          const qcp = await window.lynlens.getState(store.projectId);
          store.refreshSegments(qcp.deleteSegments);
        }
      }
      if (
        (event.type === 'transcription.completed' ||
          event.type === 'transcript.updated' ||
          event.type === 'transcript.suggestion') &&
        store.projectId
      ) {
        const qcp = await window.lynlens.getState(store.projectId);
        store.setTranscript(qcp.transcript);
      }
      // Ripple committed/reverted fires segment.cut / segment.uncut per
      // segment, which the segment.* branch above already refreshes. We
      // don't need a separate handler — cutRanges is derived from segments.
      if (event.type === 'project.reloaded' && store.projectId) {
        const qcp = await window.lynlens.getState(store.projectId);
        store.refreshSegments(qcp.deleteSegments);
        store.setTranscript(qcp.transcript);
        store.setAiMode(qcp.aiMode);
        store.setUserOrientation(qcp.userOrientation ?? null);
      }
    });
    return () => off();
  }, [store.projectId]);

  // Playhead RAF update
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v) {
        setCurrentTime(v.currentTime);
        // Committed ripple cuts: ALWAYS skip. A cut is permanent until the
        // user clicks ↶ on its segment. If the playhead lands inside a cut
        // zone (after seeking, or right after a fresh cut was committed),
        // jump to the far side.
        const cut = store.segments.find(
          (s) =>
            s.status === 'cut' && v.currentTime >= s.start && v.currentTime < s.end
        );
        if (cut) {
          v.currentTime = Math.min(v.duration, cut.end + 0.02);
        }
        // Preview mode: also skip approved delete segments that haven't been
        // rippled yet. This keeps the "preview成品" button useful before the
        // user commits a cut.
        if (store.previewMode && !v.paused) {
          const currentSeg = store.segments.find(
            (s) =>
              s.status === 'approved' &&
              v.currentTime >= s.start &&
              v.currentTime < s.end
          );
          if (currentSeg) {
            v.currentTime = Math.min(v.duration, currentSeg.end + 0.02);
          }
        }
        // Brush painting: extend mark to current playhead
        if (brushRef.current && !v.paused && store.projectId) {
          // do nothing visible; we'll commit on keyup
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [store.previewMode, store.segments, store.projectId]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKeyDown = async (e: KeyboardEvent) => {
      const v = videoRef.current;
      const active = document.activeElement;
      const inField =
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active instanceof HTMLSelectElement;
      if (inField) return;

      // Ctrl+Z / Ctrl+Y / Ctrl+S / Ctrl+E
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === 'z' && !e.shiftKey) {
        if (!store.projectId) return;
        e.preventDefault();
        await window.lynlens.undo(store.projectId);
        return;
      }
      if (meta && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
        if (!store.projectId) return;
        e.preventDefault();
        await window.lynlens.redo(store.projectId);
        return;
      }
      if (meta && e.key.toLowerCase() === 's') {
        if (!store.projectId) return;
        e.preventDefault();
        await window.lynlens.saveProject(store.projectId);
        return;
      }
      if (meta && e.key.toLowerCase() === 'e') {
        if (!store.projectId) return;
        e.preventDefault();
        setShowExport(true);
        return;
      }
      if (meta && e.key.toLowerCase() === 'r') {
        if (!store.projectId) return;
        e.preventDefault();
        void window.lynlens.aiMarkSilence(store.projectId, {
          minPauseSec: 1.0,
          silenceThreshold: 0.03,
        });
        return;
      }
      if (e.shiftKey && e.key.toLowerCase() === 'a') {
        if (!store.projectId) return;
        e.preventDefault();
        void window.lynlens.approveAllPending(store.projectId);
        return;
      }

      if (!v) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (v.paused) void v.play();
          else v.pause();
          break;
        case 'Escape':
          if (store.previewMode) store.setPreviewMode(false);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 5 : 1));
          break;
        case 'ArrowRight':
          e.preventDefault();
          v.currentTime = Math.min(v.duration, v.currentTime + (e.shiftKey ? 5 : 1));
          break;
        case ',':
          e.preventDefault();
          if (store.videoMeta) v.currentTime = Math.max(0, v.currentTime - 1 / store.videoMeta.fps);
          break;
        case '.':
          e.preventDefault();
          if (store.videoMeta) v.currentTime = Math.min(v.duration, v.currentTime + 1 / store.videoMeta.fps);
          break;
        case 'j':
        case 'J':
          e.preventDefault();
          // Approximation of J-K-L: we don't reverse decode, so J = half speed step and pause-rewind
          v.playbackRate = Math.max(0.25, (v.playbackRate > 0 ? -1 : v.playbackRate - 1));
          if (v.paused) void v.play();
          break;
        case 'k':
        case 'K':
          e.preventDefault();
          v.playbackRate = 1;
          if (!v.paused) v.pause();
          break;
        case 'l':
        case 'L':
          e.preventDefault();
          v.playbackRate = v.playbackRate >= 4 ? 4 : Math.max(1, v.playbackRate) * 2;
          if (v.paused) void v.play();
          break;
        case 'd':
        case 'D':
          if (e.repeat) return;
          e.preventDefault();
          if (!store.projectId) return;
          brushRef.current = { start: v.currentTime };
          break;
        case '+':
        case '=':
          e.preventDefault();
          dispatchTimelineZoom('in');
          break;
        case '-':
        case '_':
          e.preventDefault();
          dispatchTimelineZoom('out');
          break;
        case '0':
          e.preventDefault();
          dispatchTimelineZoom('fit');
          break;
      }
    };

    const onKeyUp = async (e: KeyboardEvent) => {
      const v = videoRef.current;
      if (!v || !store.projectId) return;
      if (e.key === 'd' || e.key === 'D') {
        const brush = brushRef.current;
        brushRef.current = null;
        if (brush) {
          const s = Math.min(brush.start, v.currentTime);
          const eT = Math.max(brush.start, v.currentTime);
          if (eT - s > 0.05) {
            await window.lynlens.addSegment({
              projectId: store.projectId,
              start: s,
              end: eT,
              source: 'human',
              reason: null,
            });
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [store.projectId, store.previewMode, store.videoMeta]);

  const openVideo = useCallback(async () => {
    const result = await window.lynlens.openVideoDialog();
    if (!result) return;
    store.setProject(result);
    // kick off waveform
    void window.lynlens.getWaveform(result.projectId, 0).then((env) => {
      store.setWaveform({
        peak: Float32Array.from(env.peak),
        rms: Float32Array.from(env.rms),
      });
    });
  }, []);

  const openFromDrop = useCallback(async (file: File) => {
    // Electron 32+ removed File.path for sandbox safety; use webUtils.getPathForFile via preload.
    const filePath = window.lynlens.getPathForFile(file);
    if (!filePath) {
      alert('无法获取拖入文件的本地路径,请改用"文件 · 打开视频"菜单。');
      return;
    }
    // Route .qcp files to the project opener so users can drag a workflow
    // file directly instead of having to click "文件 · 打开工程".
    const isProject = /\.qcp$/i.test(filePath);
    try {
      const result = isProject
        ? await window.lynlens.openProjectByPath(filePath)
        : await window.lynlens.openVideoByPath(filePath);
      store.setProject(result);

      // Pull segments + transcript + rotation from the persisted state so the
      // freshly-opened project comes up with every prior edit intact.
      if (isProject) {
        const qcp = await window.lynlens.getState(result.projectId);
        store.refreshSegments(qcp.deleteSegments);
        store.setTranscript(qcp.transcript);
        store.setAiMode(qcp.aiMode);
        store.setUserOrientation(qcp.userOrientation ?? null);
      }

      void window.lynlens.getWaveform(result.projectId, 0).then((env) => {
        store.setWaveform({
          peak: Float32Array.from(env.peak),
          rms: Float32Array.from(env.rms),
        });
      });
    } catch (err) {
      alert(`打开失败: ${(err as Error).message}`);
    }
  }, []);

  // Timeline emits EFFECTIVE seconds; segments live in SOURCE seconds. Map at
  // the boundary so cut-aware math stays confined to the renderer ↔ core line.
  const onMarkRange = useCallback(
    async (effStart: number, effEnd: number) => {
      if (!store.projectId) return;
      const start = effectiveToSource(effStart, cutRanges);
      const end = effectiveToSource(effEnd, cutRanges);
      if (end - start < 0.02) return;
      await window.lynlens.addSegment({
        projectId: store.projectId,
        start,
        end,
        source: 'human',
        reason: null,
      });
    },
    [store.projectId, cutRanges]
  );

  const onEraseRange = useCallback(
    async (effStart: number, effEnd: number) => {
      if (!store.projectId) return;
      const start = effectiveToSource(effStart, cutRanges);
      const end = effectiveToSource(effEnd, cutRanges);
      if (end - start < 0.02) return;
      await window.lynlens.eraseRange(store.projectId, start, end);
    },
    [store.projectId, cutRanges]
  );

  // Segment edges come back as EFFECTIVE seconds (that's how Timeline draws
  // them). Convert both ends to source before persisting.
  const onResizeSegment = useCallback(
    async (id: string, effStart: number, effEnd: number) => {
      if (!store.projectId) return;
      const start = effectiveToSource(effStart, cutRanges);
      const end = effectiveToSource(effEnd, cutRanges);
      await window.lynlens.resizeSegment(store.projectId, id, start, end);
    },
    [store.projectId, cutRanges]
  );

  // Timeline and sidebar both speak EFFECTIVE time (what the user sees on
  // the compacted timeline). We translate to source time only at the boundary
  // with the <video> element. This keeps the rest of the UI simple and
  // symmetric — segments still store source times, but seeks / scrubs can
  // arrive in either units depending on the caller, so each handler names
  // its input explicitly.
  const seekSource = useCallback((sourceSec: number) => {
    const v = videoRef.current;
    if (v && Number.isFinite(sourceSec)) v.currentTime = sourceSec;
  }, []);

  const onSeek = useCallback(
    (effectiveSec: number) => {
      const src = effectiveToSource(effectiveSec, cutRanges);
      seekSource(src);
    },
    [cutRanges, seekSource]
  );

  /**
   * Jump used by sidebar segment list / subtitles: the caller passes a
   * SOURCE-time second (segments and transcripts live in source time).
   * We seek the video there and dispatch the jump event carrying EFFECTIVE
   * time so the timeline view auto-centers on the compacted position.
   */
  const onJumpTo = useCallback(
    (sourceSec: number) => {
      seekSource(sourceSec);
      const el = document.querySelector('.timeline-wrap');
      if (el) {
        const effectiveSec = sourceToEffective(sourceSec, cutRanges);
        el.dispatchEvent(new CustomEvent('lynlens-jump', { detail: effectiveSec }));
      }
    },
    [seekSource, cutRanges]
  );

  // Scrub: pause the video and let frames follow the mouse position tightly.
  // Timeline reports EFFECTIVE seconds; we convert to source at this boundary.
  const scrubPrevPlaying = useRef(false);
  const onScrubStart = useCallback(
    (effectiveSec: number) => {
      const v = videoRef.current;
      if (!v) return;
      scrubPrevPlaying.current = !v.paused;
      if (!v.paused) v.pause();
      v.currentTime = effectiveToSource(effectiveSec, cutRanges);
    },
    [cutRanges]
  );

  const onScrubUpdate = useCallback(
    (effectiveSec: number) => {
      const v = videoRef.current;
      if (v) v.currentTime = effectiveToSource(effectiveSec, cutRanges);
    },
    [cutRanges]
  );

  const onScrubEnd = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (scrubPrevPlaying.current) void v.play().catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    if (segFilter === 'all') return store.segments;
    if (segFilter === 'human') return store.segments.filter((s) => s.source === 'human');
    if (segFilter === 'ai') return store.segments.filter((s) => s.source === 'ai');
    return store.segments.filter((s) => s.status === 'pending');
  }, [store.segments, segFilter]);

  const totalDeleted = useMemo(
    () =>
      store.segments
        .filter((s) => s.status === 'approved')
        .reduce((sum, s) => sum + (s.end - s.start), 0),
    [store.segments]
  );
  const pendingCount = store.segments.filter((s) => s.status === 'pending').length;
  const approvedCount = store.segments.filter((s) => s.status === 'approved').length;
  const cutCount = store.segments.filter((s) => s.status === 'cut').length;

  const sourceDuration = store.videoMeta?.duration ?? 0;
  const effectiveDuration = useMemo(
    () => getEffectiveDuration(sourceDuration, cutRanges),
    [sourceDuration, cutRanges]
  );
  const effectiveCurrentTime = useMemo(
    () => sourceToEffective(currentTime, cutRanges),
    [currentTime, cutRanges]
  );
  const totalCut = useMemo(
    () => cutRanges.reduce((sum, r) => sum + (r.end - r.start), 0),
    [cutRanges]
  );

  /**
   * Commit all approved delete segments as a ripple cut. Segments transition
   * to `status: 'cut'` — they stay in the sidebar list with a ↶ button so the
   * user can undo any individual cut any time. Skip the confirm — undo is
   * now one click away.
   */
  async function handleCommitRipple() {
    if (!store.projectId) return;
    if (approvedCount === 0) {
      alert('没有已批准的删除段。请先批准一些段(或标记人工删除段),再按剪切。');
      return;
    }
    try {
      const result = await window.lynlens.commitRipple(store.projectId);
      if (result.cutSegmentIds.length === 0) {
        alert('没有可剪切的段。');
      }
      // No explicit alert on success — the visible timeline collapse is the
      // confirmation. The refresh happens via ripple.committed event.
    } catch (err) {
      alert(`剪切失败: ${(err as Error).message}`);
    }
  }

  async function handleExportConfirm(args: {
    outputPath: string;
    mode: 'fast' | 'precise';
    quality: 'original' | 'high' | 'medium' | 'low';
  }) {
    if (!store.projectId) return;
    // L3 mode: 3-second countdown before actually exporting. UI remains cancelable.
    if (store.aiMode === 'L3') {
      const ok = await runL3Countdown();
      if (!ok) return;
    }
    void window.lynlens
      .export({ projectId: store.projectId, ...args })
      .then((result) => {
        alert(`导出完成: ${result.outputPath}\n大小: ${formatBytes(result.sizeBytes)}`);
        setShowExport(false);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') alert(`导出失败: ${err.message}`);
      });
  }

  function runL3Countdown(): Promise<boolean> {
    return new Promise((resolve) => {
      let left = 3;
      const container = document.createElement('div');
      container.className = 'dialog-backdrop';
      container.innerHTML = `
        <div class="dialog" style="text-align:center">
          <h3>L3 模式 · 即将自动导出</h3>
          <div style="font-size:48px;margin:12px 0" data-count>${left}</div>
          <div style="color:#ccc;font-size:12px">AI 将直接导出文件。点"取消"中止。</div>
          <div class="dialog-actions" style="justify-content:center">
            <button data-cancel>取消</button>
          </div>
        </div>`;
      document.body.appendChild(container);
      const countEl = container.querySelector('[data-count]') as HTMLElement;
      const cancelEl = container.querySelector('[data-cancel]') as HTMLButtonElement;
      let timer: number | null = null;
      const cleanup = () => {
        if (timer) window.clearInterval(timer);
        container.remove();
      };
      cancelEl.onclick = () => {
        cleanup();
        resolve(false);
      };
      timer = window.setInterval(() => {
        left -= 1;
        if (countEl) countEl.textContent = String(left);
        if (left <= 0) {
          cleanup();
          resolve(true);
        }
      }, 1000);
    });
  }

  const defaultOutputPath = useMemo(() => {
    if (!store.videoPath) return '';
    const dot = store.videoPath.lastIndexOf('.');
    const base = dot > 0 ? store.videoPath.slice(0, dot) : store.videoPath;
    const ext = dot > 0 ? store.videoPath.slice(dot) : '.mp4';
    return base + '_edited' + ext;
  }, [store.videoPath]);

  const aiStatusClass =
    store.aiStatus === 'transcribing' ? 'working' : store.aiStatus === 'error' ? 'error' : 'ready';

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (f) void openFromDrop(f);
      }}
    >
      <div className="menu-bar">
        <span className="menu-item" onClick={openVideo}>
          文件 · 打开视频
        </span>
        <span
          className="menu-item"
          onClick={async () => {
            const result = await window.lynlens.openProjectDialog();
            if (!result) return;
            store.setProject(result);
            // Restore segments + transcript. Cut ranges come along inside
            // deleteSegments (as status='cut'), so one refreshSegments suffices.
            const qcp = await window.lynlens.getState(result.projectId);
            store.refreshSegments(qcp.deleteSegments);
            store.setTranscript(qcp.transcript);
            store.setAiMode(qcp.aiMode);
            store.setUserOrientation(qcp.userOrientation ?? null);
            void window.lynlens.getWaveform(result.projectId, 0).then((env) => {
              store.setWaveform({
                peak: Float32Array.from(env.peak),
                rms: Float32Array.from(env.rms),
              });
            });
          }}
        >
          文件 · 打开工程
        </span>
        <span
          className="menu-item"
          onClick={() => store.projectId && window.lynlens.saveProject(store.projectId)}
          style={{ opacity: store.projectId ? 1 : 0.4 }}
        >
          保存工程 <span className="kbd">Ctrl+S</span>
        </span>
        <span
          className="menu-item"
          onClick={() => store.projectId && setShowExport(true)}
          style={{ opacity: store.projectId ? 1 : 0.4 }}
        >
          导出 <span className="kbd">Ctrl+E</span>
        </span>
      </div>

      <div className="work-mode-tabs">
        <button
          className={`work-mode-tab${workMode === 'precision' ? ' active' : ''}`}
          onClick={() => void switchMode('precision')}
        >
          粗剪
        </button>
        <button
          className={`work-mode-tab${workMode === 'highlight' ? ' active' : ''}`}
          onClick={() => void switchMode('highlight')}
          disabled={!store.projectId}
          title={store.projectId ? undefined : '请先打开视频'}
        >
          高光
        </button>
        <button
          className={`work-mode-tab${workMode === 'copywriter' ? ' active' : ''}`}
          onClick={() => void switchMode('copywriter')}
          disabled={!store.projectId}
          title={store.projectId ? undefined : '请先打开视频'}
        >
          文案
        </button>
      </div>

      {workMode === 'highlight' ? (
        <HighlightPanel
          effectiveDuration={effectiveDuration}
          videoPath={store.videoPath}
          previewRotation={previewRotation}
        />
      ) : workMode === 'copywriter' ? (
        <SocialCopyPanel />
      ) : (
      <>
      <div className="ai-bar">
        <span>
          <span className={`status-dot ${aiStatusClass}`} />
          AI 状态: {store.aiStatus === 'idle' ? '就绪' : store.aiStatus === 'transcribing' ? '转录中' : '错误'}
        </span>
        <span>AI 模式:</span>
        <div className="mode-switch">
          <button
            className={store.aiMode === 'L2' ? 'active' : ''}
            onClick={() => store.setAiMode('L2')}
            title="L2: AI 标记进入待审核状态，你逐条批准"
          >
            审核
          </button>
          <button
            className={store.aiMode === 'L3' ? 'active' : ''}
            onClick={() => {
              if (
                confirm(
                  '启用自动模式? AI 标记将直接生效、可自动导出。建议仅在日常批处理且信任 AI 的场景使用。'
                )
              ) {
                store.setAiMode('L3');
              }
            }}
            title="L3: AI 标记直接生效,跳过人工审核"
          >
            自动
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <button
          className={`ai ${chatOpen ? 'active' : ''}`}
          disabled={!store.projectId}
          onClick={() => setChatOpen((v) => !v)}
          title="打开/关闭内置 Claude 助手(用你已登录的 Claude Code 订阅)"
        >
          Claude
        </button>
        <button
          className="ai"
          disabled={!store.projectId || store.aiStatus === 'transcribing'}
          onClick={async () => {
            if (!store.projectId) return;
            // If we haven't asked the user about orientation for this
            // project yet, open the dialog; the dialog's "确认" will
            // then kick off the transcription.
            if (!store.userOrientation) {
              setShowOrientDialog(true);
              return;
            }
            try {
              await window.lynlens.transcribe(store.projectId, { language: 'auto' });
            } catch (err) {
              alert(`转录失败: ${(err as Error).message}`);
            }
          }}
          title="本地 whisper.cpp 转录(离线)"
        >
          {store.aiStatus === 'transcribing'
            ? `转录中 ${Math.round(store.transcribeProgress * 100)}%`
            : store.transcript
              ? `重新转录 (${store.transcript.segments.length} 段)`
              : '生成字幕'}
        </button>
        <button
          className="ai"
          disabled={!store.projectId}
          onClick={() => setShowQuickMarkDialog(true)}
          title="自动标出停顿 / 语气词 / 重复段 (自选阈值)"
        >
          快速标记
        </button>
      </div>

      <div className="main-area">
        <div className="player-wrap" ref={playerWrapRef}>
          {store.videoUrl ? (
            <>
              <video
                ref={videoRef}
                src={store.videoUrl}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                // eslint-disable-next-line no-console
                onError={(e) => console.error('[video] error', (e.target as HTMLVideoElement).error)}
                controls={false}
                style={(() => {
                  const isSide = previewRotation === 90 || previewRotation === 270;
                  // When rotated 90/270 the pre-rotation box must fit within
                  // (containerH × containerW), not (containerW × containerH),
                  // so after the transform the visible frame lands back inside
                  // the player. maxWidth+maxHeight+objectFit:contain together
                  // give us a clean letterboxed rotation.
                  const maxW = isSide && playerWrapSize.h ? `${playerWrapSize.h}px` : '100%';
                  const maxH = isSide && playerWrapSize.w ? `${playerWrapSize.w}px` : '100%';
                  return {
                    maxWidth: maxW,
                    maxHeight: maxH,
                    objectFit: 'contain' as const,
                    transform: `rotate(${previewRotation}deg)`,
                    transition: 'transform 0.2s ease',
                  };
                })()}
              />
              <button
                className="preview-rotate-btn"
                onClick={rotatePreview}
                title="仅旋转预览画面,不影响原视频和导出"
              >
                旋转 {previewRotation}°
              </button>
            </>
          ) : (
            <div className="drop-hint">
              <h2>拖入视频文件,或点击菜单「文件 · 打开视频」</h2>
              支持 mp4 / mov / mkv / webm。导入后按 <span className="kbd">空格</span> 播放,
              按住 <span className="kbd">D</span> 键刷选要删除的段落。
            </div>
          )}
        </div>

        <Resizer
          direction="horizontal"
          value={sidebarWidth}
          onChange={setSidebarWidth}
          min={220}
          max={700}
          invert
        />
        <div className="sidebar" style={{ flex: `0 0 ${sidebarWidth}px`, width: sidebarWidth }}>
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab${sidebarTab === 'segments' ? ' active' : ''}`}
              onClick={() => setSidebarTab('segments')}
            >
              标记段 ({store.segments.length})
            </button>
            <button
              className={`sidebar-tab${sidebarTab === 'subtitles' ? ' active' : ''}`}
              onClick={() => setSidebarTab('subtitles')}
            >
              字幕稿 {store.transcript ? `(${store.transcript.segments.length})` : ''}
            </button>
          </div>
          {sidebarTab === 'segments' ? (
            <>
          <div className="sidebar-header">
            <span>标记段 ({store.segments.length})</span>
            <div className="sidebar-filter">
              <button className={segFilter === 'all' ? 'active' : ''} onClick={() => setSegFilter('all')}>全部</button>
              <button className={segFilter === 'human' ? 'active' : ''} onClick={() => setSegFilter('human')}>人工</button>
              <button className={segFilter === 'ai' ? 'active' : ''} onClick={() => setSegFilter('ai')}>AI</button>
              <button className={segFilter === 'pending' ? 'active' : ''} onClick={() => setSegFilter('pending')}>待审</button>
            </div>
          </div>
          <div className="segment-list">
            {filtered.length === 0 && (
              <div style={{ padding: 20, color: '#666', fontSize: 12, textAlign: 'center' }}>
                暂无标记段
              </div>
            )}
            {filtered.map((s, i) => (
              <SegmentRow key={s.id} seg={s} index={i + 1} onJump={onJumpTo} />
            ))}
          </div>
          <div className="sidebar-footer">
            共 {store.segments.length} 段 · 已删 {formatTime(totalDeleted)}
            {pendingCount > 0 && (
              <>
                {' · '}
                <span style={{ color: '#9b59b6' }}>待审 {pendingCount}</span>
              </>
            )}
          </div>
            </>
          ) : (
            <SubtitlePanel
              projectId={store.projectId}
              videoMeta={store.videoMeta}
              transcript={store.transcript}
              userOrientation={store.userOrientation}
              currentTime={currentTime}
              onJump={onJumpTo}
            />
          )}
        </div>

        {chatOpen && (
          <Resizer
            direction="horizontal"
            value={chatWidth}
            onChange={setChatWidth}
            min={280}
            max={720}
            invert
          />
        )}
        <ChatPanel open={chatOpen} onClose={() => setChatOpen(false)} width={chatWidth} />
      </div>

      <div className="toolbar">
        <button
          onClick={() => {
            const v = videoRef.current;
            if (v) {
              if (v.paused) void v.play();
              else v.pause();
            }
          }}
          disabled={!store.videoUrl}
        >
          {isPlaying ? '暂停' : '播放'}
        </button>
        <button
          className={store.previewMode ? 'ai' : ''}
          onClick={() => store.setPreviewMode(!store.previewMode)}
          disabled={!store.videoUrl}
        >
          {store.previewMode ? '预览中 (Esc 退出)' : '预览成品'}
        </button>
        <button
          onClick={handleCommitRipple}
          disabled={!store.videoUrl || approvedCount === 0}
          title="把所有已批准的红框真的剪掉,时间轴压缩成品状态。原视频不动,可撤销。"
        >
          剪切 ({approvedCount})
        </button>
        <button
          className="primary"
          onClick={() => setShowExport(true)}
          disabled={
            !store.videoUrl || (store.segments.length === 0 && cutRanges.length === 0)
          }
        >
          导出
        </button>
        <div className="spacer" />
        <div className="stats">
          {formatTime(effectiveCurrentTime)} / {formatTime(effectiveDuration)}
          {totalCut > 0 && (
            <>
              {' · '}
              <span style={{ color: '#f39c12' }}>已剪 {formatTime(totalCut)}</span>
            </>
          )}
          {totalDeleted > 0 && (
            <>
              {' · '}待剪 {formatTime(totalDeleted)}
            </>
          )}
        </div>
      </div>

      {pendingCount > 0 && (
        <div
          style={{
            background: '#3a2d4a',
            padding: '6px 14px',
            borderTop: '1px solid #5a4373',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
          }}
        >
          <span style={{ color: '#d0b3ff' }}>
            有 {pendingCount} 个 AI 待审核段落
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="ai"
            onClick={async () => {
              if (!store.projectId) return;
              const n = await window.lynlens.approveAllPending(store.projectId);
              console.log(`approved ${n} segments`);
            }}
          >
            ✓ 全部批准 (Shift+A)
          </button>
          <button
            onClick={async () => {
              if (!store.projectId) return;
              await window.lynlens.rejectAllPending(store.projectId);
            }}
          >
            ✗ 全部拒绝
          </button>
        </div>
      )}
      <Resizer
        direction="vertical"
        value={timelineHeight}
        onChange={setTimelineHeight}
        min={120}
        max={500}
        invert
      />
      <div className="timeline-outer" style={{ height: timelineHeight }}>
        <Timeline
          duration={effectiveDuration}
          sourceDuration={sourceDuration}
          cutRanges={cutRanges}
          currentTime={effectiveCurrentTime}
          waveform={store.waveform}
          segments={store.segments}
          transcript={store.transcript}
          onSeek={onSeek}
          onScrubStart={onScrubStart}
          onScrubUpdate={onScrubUpdate}
          onScrubEnd={onScrubEnd}
          onMarkRange={onMarkRange}
          onEraseRange={onEraseRange}
          onResizeSegment={onResizeSegment}
        />
      </div>
      </>
      )}

      {showExport && store.videoPath && (
        <ExportDialog
          defaultPath={defaultOutputPath}
          onClose={() => {
            if (useStore.getState().export.active && store.projectId) {
              void window.lynlens.cancelExport(store.projectId);
            }
            setShowExport(false);
          }}
          onConfirm={handleExportConfirm}
        />
      )}
      {showOrientDialog && store.videoMeta && store.projectId && (
        <OrientationDialog
          videoMeta={store.videoMeta}
          onCancel={() => setShowOrientDialog(false)}
          onConfirm={async (o) => {
            setShowOrientDialog(false);
            if (!store.projectId) return;
            await window.lynlens.setUserOrientation(store.projectId, o);
            store.setUserOrientation(o);
            try {
              await window.lynlens.transcribe(store.projectId, { language: 'auto' });
            } catch (err) {
              alert(`转录失败: ${(err as Error).message}`);
            }
          }}
        />
      )}
      {showQuickMarkDialog && store.projectId && (
        <QuickMarkDialog
          hasTranscript={!!store.transcript}
          onCancel={() => setShowQuickMarkDialog(false)}
          onConfirm={async (opts) => {
            setShowQuickMarkDialog(false);
            if (!store.projectId) return;
            try {
              const res = await window.lynlens.aiMarkSilence(store.projectId, opts);
              if (res.added === 0) {
                alert(
                  `没找到符合条件的段。\n\n当前阈值: ≥${opts.minPauseSec.toFixed(
                    1
                  )} 秒的停顿。\n试试再降低阈值重新标记。`
                );
              } else {
                const b = res.breakdown;
                alert(
                  `已添加 ${res.added} 段待审核:\n` +
                    `  停顿 ${b.silences} 段 (≥${opts.minPauseSec.toFixed(1)}s)` +
                    (b.fillers ? `\n  语气词 ${b.fillers} 段` : '') +
                    (b.retakes ? `\n  重复/重拍 ${b.retakes} 段` : '') +
                    (!store.transcript
                      ? '\n\n提示: 先点「生成字幕」后,能额外识别语气词和重复段。'
                      : '')
                );
              }
            } catch (err) {
              alert(`分析失败: ${(err as Error).message}`);
            }
          }}
        />
      )}
    </div>
  );
}

function SegmentRow({
  seg,
  index,
  onJump,
}: {
  seg: Segment;
  index: number;
  onJump: (t: number) => void;
}) {
  const cls = seg.status;
  const isCut = seg.status === 'cut';
  return (
    <div className={`segment-item ${cls}`} onClick={() => onJump(seg.start)}>
      <div className="num">#{index}</div>
      <div className="meta">
        <div>
          <span style={{ opacity: 0.7, marginRight: 4 }}>{seg.source === 'ai' ? 'AI' : '人'}</span>
          {isCut && <span style={{ color: '#f39c12', marginRight: 4 }}>已剪</span>}
          <span
            className="time"
            style={isCut ? { textDecoration: 'line-through', opacity: 0.7 } : undefined}
          >
            {formatTime(seg.start)} - {formatTime(seg.end)} ({(seg.end - seg.start).toFixed(2)}s)
          </span>
        </div>
        {seg.reason && <div className="reason">{seg.reason}</div>}
      </div>
      <div className="segment-actions" onClick={(e) => e.stopPropagation()}>
        {seg.source === 'ai' && seg.status === 'pending' && (
          <>
            <button
              title="批准 (A)"
              onClick={() => {
                const pid = useStore.getState().projectId;
                if (pid) void window.lynlens.approveSegment(pid, seg.id);
              }}
            >
              ✓
            </button>
            <button
              title="拒绝 (X)"
              onClick={() => {
                const pid = useStore.getState().projectId;
                if (pid) void window.lynlens.rejectSegment(pid, seg.id);
              }}
            >
              ✗
            </button>
          </>
        )}
        {isCut && (
          <button
            title="撤销这一刀:段恢复为已批准,时间轴重新变长"
            onClick={() => {
              const pid = useStore.getState().projectId;
              if (pid) void window.lynlens.revertRipple(pid, seg.id);
            }}
          >
            ↶
          </button>
        )}
        <button
          title="删除"
          onClick={() => {
            const pid = useStore.getState().projectId;
            if (pid) void window.lynlens.removeSegment(pid, seg.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function dispatchTimelineZoom(detail: 'in' | 'out' | 'fit') {
  const el = document.querySelector('.timeline-wrap');
  if (el) el.dispatchEvent(new CustomEvent('lynlens-zoom', { detail }));
}
