import type {
  ExportMode,
  ExportQuality,
  HighlightStyle,
  HighlightVariant,
  LynLensEvent,
  QcpProject,
  Segment,
  Transcript,
  VideoMeta,
} from '@lynlens/core';

export interface CommitRippleResult {
  /** Ids of segments that transitioned to cut status in this call. */
  cutSegmentIds: string[];
  /** Total duration of every currently-cut segment (seconds). */
  totalCutSeconds: number;
  /** Video duration after all cuts (seconds). */
  effectiveDuration: number;
}

export interface OpenVideoResult {
  projectId: string;
  videoMeta: VideoMeta;
  videoPath: string;
  videoUrl: string;
}

export interface ExportRequest {
  projectId: string;
  outputPath: string;
  mode: ExportMode;
  quality: ExportQuality;
}

export interface ExportResultDto {
  outputPath: string;
  durationSeconds: number;
  sizeBytes: number;
  mode: ExportMode;
}

export interface AddSegmentRequest {
  projectId: string;
  start: number;
  end: number;
  source: 'human' | 'ai';
  reason?: string | null;
  confidence?: number;
  aiModel?: string;
}

export interface IpcApi {
  getPathForFile(file: File): string;
  openVideoDialog(): Promise<OpenVideoResult | null>;
  openVideoByPath(videoPath: string): Promise<OpenVideoResult>;
  openProjectDialog(): Promise<OpenVideoResult | null>;
  saveDialog(defaultName: string): Promise<string | null>;

  addSegment(req: AddSegmentRequest): Promise<Segment>;
  removeSegment(projectId: string, segmentId: string): Promise<void>;
  eraseRange(projectId: string, start: number, end: number): Promise<void>;
  resizeSegment(projectId: string, segmentId: string, start: number, end: number): Promise<Segment>;
  approveSegment(projectId: string, segmentId: string): Promise<void>;
  rejectSegment(projectId: string, segmentId: string): Promise<void>;
  undo(projectId: string): Promise<boolean>;
  redo(projectId: string): Promise<boolean>;

  getState(projectId: string): Promise<QcpProject>;
  saveProject(projectId: string, outputPath?: string): Promise<string>;
  /** Return the conventional .qcp path (sidecar of the video). */
  getQcpPath(projectId: string): Promise<string>;
  /** Force an immediate save to the sidecar path and return it. */
  flushProject(projectId: string): Promise<string>;

  getWaveform(projectId: string, buckets: number): Promise<{ peak: number[]; rms: number[] }>;
  export(req: ExportRequest): Promise<ExportResultDto>;
  cancelExport(projectId: string): Promise<void>;

  aiMarkSilence(
    projectId: string,
    opts: { minPauseSec: number; silenceThreshold: number }
  ): Promise<{
    added: number;
    segmentIds: string[];
    breakdown: { silences: number; fillers: number; retakes: number };
  }>;
  approveAllPending(projectId: string): Promise<number>;
  rejectAllPending(projectId: string): Promise<number>;

  /**
   * Apply a ripple-cut: approved delete segments become permanent cuts that
   * compact the effective timeline. The returned result describes what was
   * cut and the new effective duration. Pending / rejected segments are
   * untouched.
   */
  commitRipple(projectId: string): Promise<CommitRippleResult>;
  /** Flip one cut segment back to approved, restoring its range to the timeline. */
  revertRipple(projectId: string, segmentId: string): Promise<boolean>;

  /**
   * Ask Claude to generate N highlight variants from the already-rippled
   * timeline's transcript. Variants are session-only — not written to disk.
   * Returns the generated variants immediately (same shape main stores).
   */
  generateHighlights(
    projectId: string,
    opts: { style: HighlightStyle; count: number; targetSeconds: number }
  ): Promise<HighlightVariant[]>;
  /** Read the currently-stored (ephemeral) highlight variants. */
  getHighlights(projectId: string): Promise<HighlightVariant[]>;
  /** Drop all highlight variants — called when user switches back to 粗剪. */
  clearHighlights(projectId: string): Promise<void>;
  /** Export one variant to a file; same stream-copy pipeline as regular export. */
  exportHighlight(
    projectId: string,
    variantId: string,
    outputPath: string
  ): Promise<ExportResultDto>;

  transcribe(
    projectId: string,
    opts: { engine?: 'whisper-local' | 'openai-api'; language?: string }
  ): Promise<{ segmentCount: number; language: string; engine: string }>;
  updateTranscriptSegment(projectId: string, segmentId: string, newText: string): Promise<boolean>;
  replaceInTranscript(projectId: string, find: string, replace: string): Promise<number>;
  acceptTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  clearTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  setUserOrientation(projectId: string, o: 'landscape' | 'portrait' | null): Promise<void>;

  onEngineEvent(callback: (event: LynLensEvent) => void): () => void;

  agentSend(projectId: string, message: string): Promise<void>;
  agentCancel(projectId: string): Promise<void>;
  agentReset(projectId: string): Promise<void>;
  agentIdentity(): Promise<{
    email: string;
    displayName: string | null;
    organization: string | null;
    plan: string | null;
  } | null>;
  onAgentEvent(callback: (event: AgentEvent) => void): () => void;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'text_complete' }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'thinking'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

declare global {
  interface Window {
    lynlens: IpcApi;
  }
}
