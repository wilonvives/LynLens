import { create } from 'zustand';
import type { AiMode, LynLensEvent, Segment, Transcript, VideoMeta } from '@lynlens/core';

export type AiStatus = 'idle' | 'transcribing' | 'error';

interface ExportState {
  active: boolean;
  percent: number;
  stage: string;
}

interface State {
  projectId: string | null;
  videoPath: string | null;
  videoUrl: string | null;
  videoMeta: VideoMeta | null;
  /**
   * All segments, every status (pending / approved / rejected / cut). The
   * renderer derives its "cut ranges" for timeline compaction by filtering
   * `segments.filter(s => s.status === 'cut')` — single source of truth.
   */
  segments: Segment[];
  aiMode: AiMode;
  userOrientation: 'landscape' | 'portrait' | null;
  aiStatus: AiStatus;
  transcribeProgress: number; // 0..1
  transcript: Transcript | null;
  waveform: { peak: Float32Array; rms: Float32Array } | null;

  previewMode: boolean;
  export: ExportState;

  setProject(p: { projectId: string; videoPath: string; videoUrl: string; videoMeta: VideoMeta }): void;
  clearProject(): void;
  refreshSegments(segs: Segment[]): void;
  setAiMode(m: AiMode): void;
  setUserOrientation(o: 'landscape' | 'portrait' | null): void;
  setTranscript(t: Transcript | null): void;
  setWaveform(wf: { peak: Float32Array; rms: Float32Array } | null): void;
  setPreviewMode(v: boolean): void;
  applyEvent(e: LynLensEvent): void;
}

export const useStore = create<State>((set, get) => ({
  projectId: null,
  videoPath: null,
  videoUrl: null,
  videoMeta: null,
  segments: [],
  aiMode: 'L2',
  userOrientation: null,
  aiStatus: 'idle',
  transcribeProgress: 0,
  transcript: null,
  waveform: null,
  previewMode: false,
  export: { active: false, percent: 0, stage: '' },

  setProject(p) {
    set({
      projectId: p.projectId,
      videoPath: p.videoPath,
      videoUrl: p.videoUrl,
      videoMeta: p.videoMeta,
      segments: [],
      waveform: null,
      transcript: null,
      transcribeProgress: 0,
    });
  },
  clearProject() {
    set({
      projectId: null,
      videoPath: null,
      videoUrl: null,
      videoMeta: null,
      segments: [],
      waveform: null,
      transcript: null,
      transcribeProgress: 0,
    });
  },
  refreshSegments(segs) {
    set({ segments: [...segs].sort((a, b) => a.start - b.start) });
  },
  setAiMode(m) {
    set({ aiMode: m });
  },
  setUserOrientation(o) {
    set({ userOrientation: o });
  },
  setTranscript(t) {
    set({ transcript: t });
  },
  setWaveform(wf) {
    set({ waveform: wf });
  },
  setPreviewMode(v) {
    set({ previewMode: v });
  },
  applyEvent(e) {
    const s = get();
    if (!s.projectId) return;
    switch (e.type) {
      case 'segment.added':
      case 'segment.resized':
      case 'segment.approved':
      case 'segment.rejected':
      case 'segment.removed':
      case 'segment.merged':
        break;
      case 'mode.changed':
        set({ aiMode: e.mode });
        break;
      case 'transcription.started':
        set({ aiStatus: 'transcribing', transcribeProgress: 0 });
        break;
      case 'transcription.progress':
        set({ transcribeProgress: Math.max(0, Math.min(1, e.percent / 100)) });
        break;
      case 'transcription.completed':
        set({ aiStatus: 'idle', transcribeProgress: 1 });
        break;
      case 'transcription.failed':
        set({ aiStatus: 'error', transcribeProgress: 0 });
        break;
      case 'export.started':
        set({ export: { active: true, percent: 0, stage: '准备中' } });
        break;
      case 'export.progress':
        set({ export: { active: true, percent: e.percent, stage: e.stage } });
        break;
      case 'export.completed':
      case 'export.canceled':
      case 'export.failed':
        set({ export: { active: false, percent: 100, stage: '' } });
        break;
    }
  },
}));
