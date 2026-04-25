import { useEffect } from 'react';
import type { LynLensEvent } from '../core-browser';
import { useStore } from '../store';

/**
 * Subscribe to engine events from the main process and pull authoritative
 * state into the renderer store on the relevant types. The main process
 * is the source of truth for segments / transcripts / speakers; events
 * tell us "something changed", we re-fetch via `getState`.
 *
 * Re-mounts only when the active project changes — that's the boundary
 * where the engine context shifts. Inside the handler we read the latest
 * `store.projectId` from the captured store proxy (zustand setters are
 * stable across renders, so the captured reference stays valid).
 */
export function useEngineEvents(): void {
  const store = useStore();
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
        store.setSpeakerNames(qcp.speakerNames ?? {});
        store.setDiarizationEngine(qcp.diarizationEngine ?? null);
      }
      // Diarization added/renamed/cleared speakers — pull fresh transcript
      // + speaker names. Kept in its own branch so if diarization IPC isn't
      // wired yet (older main), the rest of the event flow still works.
      if (
        (event.type === 'diarization.completed' ||
          event.type === 'diarization.renamed' ||
          event.type === 'diarization.cleared') &&
        store.projectId
      ) {
        const qcp = await window.lynlens.getState(store.projectId);
        store.setTranscript(qcp.transcript);
        store.setSpeakerNames(qcp.speakerNames ?? {});
        store.setDiarizationEngine(qcp.diarizationEngine ?? null);
      }
    });
    return () => off();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.projectId]);
}
