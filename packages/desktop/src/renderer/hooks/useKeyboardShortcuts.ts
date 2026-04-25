import { useEffect, type RefObject } from 'react';
import { useStore } from '../store';

/**
 * Dispatch a custom timeline event so the Timeline component (which is
 * managed independently from App) can handle zoom in / out / fit
 * uniformly across keyboard, button, and (future) menu triggers.
 */
function dispatchTimelineZoom(detail: 'in' | 'out' | 'fit'): void {
  const el = document.querySelector('.timeline-wrap');
  if (el) el.dispatchEvent(new CustomEvent('lynlens-zoom', { detail }));
}

interface KeyboardShortcutsArgs {
  videoRef: RefObject<HTMLVideoElement | null>;
  brushRef: RefObject<{ start: number } | null>;
  /** Open the export dialog (Ctrl/Cmd+E). */
  setShowExport: (show: boolean) => void;
}

/**
 * Global keyboard shortcuts for the precision editor. Suppressed when the
 * focus is inside an input/textarea/select so typing in the subtitle
 * editor doesn't trigger Space → play/pause etc.
 *
 * Shortcuts (mostly mirroring premiere/davinci-style):
 *   Cmd/Ctrl+Z / Cmd/Ctrl+Shift+Z  — undo / redo
 *   Cmd/Ctrl+S                     — save project
 *   Cmd/Ctrl+E                     — open export dialog
 *   Cmd/Ctrl+R                     — AI mark silence
 *   Shift+A                        — approve all pending
 *   Space                          — play / pause
 *   Esc                            — exit preview mode
 *   ←/→                            — seek 1s (Shift = 5s)
 *   ,/.                            — frame step
 *   J / K / L                      — half-speed / pause / 2× (approximate)
 *   D (hold)                       — brush mark (release commits a delete segment)
 *   + / = / - / _ / 0              — timeline zoom in / out / fit
 */
export function useKeyboardShortcuts({
  videoRef,
  brushRef,
  setShowExport,
}: KeyboardShortcutsArgs): void {
  const store = useStore();
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
          (brushRef as React.MutableRefObject<{ start: number } | null>).current = {
            start: v.currentTime,
          };
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
        (brushRef as React.MutableRefObject<{ start: number } | null>).current = null;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.projectId, store.previewMode, store.videoMeta, videoRef, brushRef, setShowExport]);
}
