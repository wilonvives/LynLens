import type {
  ExportMode,
  ExportQuality,
  LynLensEvent,
  QcpProject,
  Range,
  Segment,
  Transcript,
  VideoMeta,
} from '@lynlens/core';

export interface CommitRippleResult {
  /** Ids of segments that were moved into cutRanges this call. */
  cutSegmentIds: string[];
  /** Total duration of every committed cut range (seconds). */
  totalCutSeconds: number;
  /** Video duration after all cuts (seconds). */
  effectiveDuration: number;
  /** Bounding range of what was added this call; null if nothing changed. */
  addedCutRange: Range | null;
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
  /** Remove a previously-committed cut range, restoring its source time. */
  revertRipple(projectId: string, cutStart: number, cutEnd: number): Promise<boolean>;

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
