import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  effectiveToSource,
  getEffectiveDuration,
  sourceToEffective,
} from './core-browser';
import { ExportDialog } from './ExportDialog';
import { OrientationDialog } from './OrientationDialog';
import { QuickMarkDialog } from './QuickMarkDialog';
import { HighlightPanel } from './HighlightPanel';
import { SocialCopyPanel } from './SocialCopyPanel';
import { Resizer } from './Resizer';
import { usePlayerWrapSize } from './hooks/usePlayerWrapSize';
import { useEngineEvents } from './hooks/useEngineEvents';
import { usePlaybackLoop } from './hooks/usePlaybackLoop';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { MenuBar } from './components/MenuBar';
import { WorkModeTabs, type WorkMode } from './components/WorkModeTabs';
import { AIBar } from './components/AIBar';
import { MediaPlayer } from './components/MediaPlayer';
import { SegmentSidebar, type SegmentFilter, type SidebarTab } from './components/SegmentSidebar';
import { BottomToolbar } from './components/BottomToolbar';
import { PendingBanner } from './components/PendingBanner';
import { TimelineSection } from './components/TimelineSection';

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

export function App() {
  const store = useStore();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [segFilter, setSegFilter] = useState<SegmentFilter>('all');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('segments');
  const [showOrientDialog, setShowOrientDialog] = useState(false);
  const [showQuickMarkDialog, setShowQuickMarkDialog] = useState(false);
  const [workMode, setWorkMode] = useState<WorkMode>('precision');
  const [diarizing, setDiarizing] = useState(false);
  /**
   * Mark-over-cut prompt. Set when the user's Shift+drag covers a range
   * that overlaps one or more cut segments — we pause the normal addSegment
   * flow and let them pick: extend the cut, restore + re-mark, or cancel.
   */
  const [markOverCut, setMarkOverCut] = useState<
    | null
    | {
        srcStart: number;
        srcEnd: number;
        overlappingCutIds: string[];
      }
  >(null);

  // Persisted panel sizes so the user's preferred layout survives restarts.
  const [sidebarWidth, setSidebarWidth] = usePersistedSize('lynlens.sidebarWidth', 340);
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
   * user ripples again, variant source-times don't line up with the new
   * effective timeline. With variant persistence (method C), we no longer
   * clear on switch — broken variants surface via the per-card status
   * banner, unaffected ones stay usable, and pinned ones are safe. So
   * this is just a no-op tab flip now; no prompt, no clear.
   */
  const switchMode = useCallback(
    async (next: WorkMode) => {
      if (next === workMode) return;
      setWorkMode(next);
    },
    [workMode]
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
  const playerWrapRef = useRef<HTMLDivElement>(null);
  const playerWrapSize = usePlayerWrapSize(playerWrapRef);

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

  /**
   * Same "cut" set but keeping segment ids. SubtitlePanel needs the ids to
   * build per-subtitle warning fingerprints (so dismissing a ⚠ auto-resets
   * when the underlying cuts change). Sort by start so the fingerprint is
   * stable regardless of insertion order.
   */
  const cutSegmentsForPanel = useMemo(
    () =>
      store.segments
        .filter((s) => s.status === 'cut')
        .map((s) => ({ id: s.id, start: s.start, end: s.end }))
        .sort((a, b) => a.start - b.start),
    [store.segments]
  );

  useEngineEvents();

  usePlaybackLoop({
    videoRef,
    segments: store.segments,
    previewMode: store.previewMode,
    projectId: store.projectId,
    setCurrentTime,
  });

  useKeyboardShortcuts({ videoRef, brushRef, setShowExport });

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
        store.setSpeakerNames(qcp.speakerNames ?? {});
        store.setDiarizationEngine(qcp.diarizationEngine ?? null);
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

      // Check whether the source range intersects any cut segment. If so,
      // pause and ask the user what they mean — silently absorbing the
      // mark into a cut (rank merge) was the confusing old behaviour.
      const overlappingCuts = store.segments.filter(
        (s) => s.status === 'cut' && !(s.end <= start || s.start >= end)
      );
      if (overlappingCuts.length > 0) {
        setMarkOverCut({
          srcStart: start,
          srcEnd: end,
          overlappingCutIds: overlappingCuts.map((s) => s.id),
        });
        return;
      }

      // No cut in the way — normal flow.
      await window.lynlens.addSegment({
        projectId: store.projectId,
        start,
        end,
        source: 'human',
        reason: null,
      });
    },
    [store.projectId, store.segments, cutRanges]
  );

  /** Handles the user's choice from the mark-over-cut prompt. */
  const resolveMarkOverCut = useCallback(
    async (choice: 'extend-cut' | 'restore-and-mark' | 'cancel') => {
      const pending = markOverCut;
      setMarkOverCut(null);
      if (!pending || !store.projectId || choice === 'cancel') return;
      const pid = store.projectId;

      if (choice === 'restore-and-mark') {
        // Revert every overlapping cut first. Each revertRipple flips a
        // single cut-status segment back to approved; the subsequent
        // addSegment will then merge with those approved segments (same
        // class) into one big red box — exactly what the user wants when
        // they say "I changed my mind about that cut".
        for (const cutId of pending.overlappingCutIds) {
          await window.lynlens.revertRipple(pid, cutId);
        }
      }
      // choice === 'extend-cut' falls through with no revert — the new
      // segment's mergeOverlapping will naturally absorb into the cut
      // thanks to the status-rank rule (cut > approved).
      await window.lynlens.addSegment({
        projectId: pid,
        start: pending.srcStart,
        end: pending.srcEnd,
        source: 'human',
        reason: null,
      });
    },
    [markOverCut, store.projectId]
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
      <MenuBar onOpenVideo={openVideo} onOpenExport={() => setShowExport(true)} />

      <WorkModeTabs workMode={workMode} onSwitchMode={(m) => void switchMode(m)} />

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
          <AIBar
            diarizing={diarizing}
            onOpenOrientDialog={() => setShowOrientDialog(true)}
            onOpenQuickMarkDialog={() => setShowQuickMarkDialog(true)}
          />
          <div className="main-area">
            <MediaPlayer
              videoRef={videoRef}
              playerWrapRef={playerWrapRef}
              videoUrl={store.videoUrl}
              playerWrapSize={playerWrapSize}
              previewRotation={previewRotation}
              setCurrentTime={setCurrentTime}
              setIsPlaying={setIsPlaying}
              onRotatePreview={rotatePreview}
            />
            <Resizer
              direction="horizontal"
              value={sidebarWidth}
              onChange={setSidebarWidth}
              min={220}
              max={700}
              invert
            />
            <div className="sidebar" style={{ flex: `0 0 ${sidebarWidth}px`, width: sidebarWidth }}>
              <SegmentSidebar
                projectId={store.projectId}
                videoMeta={store.videoMeta}
                transcript={store.transcript}
                userOrientation={store.userOrientation}
                currentTime={currentTime}
                speakerNames={store.speakerNames}
                cutSegmentsForPanel={cutSegmentsForPanel}
                filtered={filtered}
                totalDeleted={totalDeleted}
                pendingCount={pendingCount}
                segFilter={segFilter}
                onSegFilterChange={setSegFilter}
                sidebarTab={sidebarTab}
                onSidebarTabChange={setSidebarTab}
                onJumpTo={onJumpTo}
              />
            </div>
          </div>
          <BottomToolbar
            videoRef={videoRef}
            isPlaying={isPlaying}
            approvedCount={approvedCount}
            effectiveCurrentTime={effectiveCurrentTime}
            effectiveDuration={effectiveDuration}
            totalCut={totalCut}
            totalDeleted={totalDeleted}
            cutRangeCount={cutRanges.length}
            onCommitRipple={handleCommitRipple}
            onOpenExport={() => setShowExport(true)}
          />
          <PendingBanner pendingCount={pendingCount} />
          <TimelineSection
            timelineHeight={timelineHeight}
            onTimelineHeightChange={setTimelineHeight}
            effectiveDuration={effectiveDuration}
            sourceDuration={sourceDuration}
            cutRanges={cutRanges}
            effectiveCurrentTime={effectiveCurrentTime}
            isPlaying={isPlaying}
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
            onResizeSubtitle={(segId, srcStart, srcEnd) => {
              // Timeline already ran the source-time cascade; server will run
              // it again (authoritative), which is fine — same result.
              if (!store.projectId) return;
              void window.lynlens.updateTranscriptSegmentTime(
                store.projectId,
                segId,
                srcStart,
                srcEnd
              );
            }}
          />
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
          defaultOrientation={store.userOrientation}
          onCancel={() => setShowOrientDialog(false)}
          onConfirm={async ({ orientation, speakerCount }) => {
            setShowOrientDialog(false);
            if (!store.projectId) return;
            const pid = store.projectId;
            // 1. Persist orientation preference first (whisper re-reads
            //    it for line splitting).
            await window.lynlens.setUserOrientation(pid, orientation);
            store.setUserOrientation(orientation);

            // 2. Run whisper.
            try {
              await window.lynlens.transcribe(pid, { language: 'auto' });
            } catch (err) {
              alert(`转录失败: ${(err as Error).message}`);
              return;
            }

            // 3. Run diarization right after. Pass speakerCount
            //    (undefined for 'auto') straight to sherpa.
            setDiarizing(true);
            try {
              const count =
                typeof speakerCount === 'number' ? speakerCount : undefined;
              const r = await window.lynlens.diarize(pid, { speakerCount: count });
              const qcp = await window.lynlens.getState(pid);
              store.setTranscript(qcp.transcript);
              store.setSpeakerNames(qcp.speakerNames ?? {});
              const msg =
                r.engine === 'mock'
                  ? `转录完成, 声纹用演示数据识别出 ${r.speakers.length} 人。`
                  : `转录 + 声纹区分完成: ${r.speakers.length} 位说话人, ${r.segmentCount} 段已贴标签。`;
              alert(msg);
            } catch (err) {
              alert(`声纹区分失败 (字幕已生成): ${(err as Error).message}`);
            } finally {
              setDiarizing(false);
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
      {markOverCut && (
        <MarkOverCutDialog
          overlappingCount={markOverCut.overlappingCutIds.length}
          onChoice={(c) => void resolveMarkOverCut(c)}
        />
      )}
    </div>
  );
}

/**
 * Confirmation dialog shown when a Shift+drag mark intersects one or more
 * existing cut segments. Three exits:
 *   - 扩展剪切: new segment is added normally; mergeOverlapping rank
 *     rule absorbs it into the cut (grows the cut region).
 *   - 还原并标红框: each overlapping cut is revertRipple'd first, then
 *     the new segment becomes an approved red box spanning the whole
 *     range. User can click 剪切 again later to re-commit.
 *   - 取消: nothing happens.
 */
function MarkOverCutDialog({
  overlappingCount,
  onChoice,
}: {
  overlappingCount: number;
  onChoice: (c: 'extend-cut' | 'restore-and-mark' | 'cancel') => void;
}): JSX.Element {
  return (
    <div
      className="dialog-backdrop"
      onClick={(e) => e.target === e.currentTarget && onChoice('cancel')}
    >
      <div className="dialog" style={{ minWidth: 440 }}>
        <h3>标记碰到了已剪切段</h3>
        <div style={{ color: 'var(--text2)', fontSize: 13, lineHeight: 1.6 }}>
          你刚画的红框和 <strong>{overlappingCount}</strong> 处已经剪掉的段重叠。
          怎么处理?
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 14 }}>
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--text3)',
            }}
          >
            <div style={{ color: 'var(--text1)', fontSize: 13, marginBottom: 4 }}>
              方案 A: 扩展剪切
            </div>
            新红框和已有的剪切合并成一个更大的 cut,时间轴继续压缩。
          </div>
          <div
            style={{
              padding: '10px 12px',
              border: '1px solid #2a2a2a',
              borderRadius: 6,
              fontSize: 12,
              color: 'var(--text3)',
            }}
          >
            <div style={{ color: 'var(--text1)', fontSize: 13, marginBottom: 4 }}>
              方案 B: 还原并标红框
            </div>
            先把那 {overlappingCount} 刀还原(时间轴会变长),整个范围变红框。想剪再点「剪切」。
          </div>
        </div>
        <div className="dialog-actions">
          <button onClick={() => onChoice('cancel')}>取消</button>
          <button onClick={() => onChoice('extend-cut')}>扩展剪切 (A)</button>
          <button className="primary" onClick={() => onChoice('restore-and-mark')}>
            还原并标红框 (B)
          </button>
        </div>
      </div>
    </div>
  );
}


