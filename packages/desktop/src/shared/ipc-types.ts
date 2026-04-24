import type {
  ExportMode,
  ExportQuality,
  HighlightStyle,
  HighlightVariant,
  LynLensEvent,
  QcpProject,
  Segment,
  SocialCopySetData,
  SocialPlatform,
  SocialStylePresetData,
  Transcript,
  VideoMeta,
} from '@lynlens/core';

export interface GenerateSocialCopiesResult {
  setId: string;
  copies: Array<{
    id: string;
    platform: string;
    title: string;
    body: string;
    hashtags: string[];
  }>;
  failures: Array<{ platform: SocialPlatform; error: string }>;
}

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
  /** Open a .qcp project from a known file path (drag-and-drop entry point). */
  openProjectByPath(qcpPath: string): Promise<OpenVideoResult>;
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

  /**
   * Generate per-platform copy in parallel. The returned setId is the
   * handle for subsequent edits / deletes; getSocialCopies() returns the
   * full persisted list (including this new set).
   */
  generateSocialCopies(
    projectId: string,
    opts: {
      sourceType: 'rippled' | 'variant';
      sourceVariantId?: string;
      platforms: SocialPlatform[];
      userStyleNote?: string;
    }
  ): Promise<GenerateSocialCopiesResult>;
  getSocialCopies(projectId: string): Promise<SocialCopySetData[]>;
  updateSocialCopy(
    projectId: string,
    setId: string,
    copyId: string,
    patch: { title?: string; body?: string; hashtags?: string[] }
  ): Promise<boolean>;
  deleteSocialCopy(projectId: string, setId: string, copyId: string): Promise<boolean>;
  deleteSocialCopySet(projectId: string, setId: string): Promise<boolean>;
  setSocialStyleNote(projectId: string, note: string | null): Promise<void>;
  getSocialStylePresets(projectId: string): Promise<SocialStylePresetData[]>;
  addSocialStylePreset(
    projectId: string,
    name: string,
    content: string
  ): Promise<SocialStylePresetData>;
  updateSocialStylePreset(
    projectId: string,
    presetId: string,
    patch: { name?: string; content?: string }
  ): Promise<boolean>;
  deleteSocialStylePreset(projectId: string, presetId: string): Promise<boolean>;

  /**
   * Run speaker diarization on the current transcript. Requires a
   * transcript to exist. Backed by a mock engine today — the real
   * sherpa-onnx engine will swap in at the main-process level without
   * any renderer change. Never throws for "no speech"; throws only for
   * missing transcript / unrecoverable engine failures.
   */
  diarize(
    projectId: string
  ): Promise<{ engine: 'mock' | 'sherpa-onnx'; speakers: string[]; segmentCount: number }>;
  /** Rename (or clear) the display name for a speaker ID. */
  renameSpeaker(projectId: string, speakerId: string, name: string | null): Promise<void>;
  /** Drop all speaker labels from the transcript + clear engine marker. */
  clearSpeakers(projectId: string): Promise<void>;

  transcribe(
    projectId: string,
    opts: { engine?: 'whisper-local' | 'openai-api'; language?: string }
  ): Promise<{ segmentCount: number; language: string; engine: string }>;
  updateTranscriptSegment(projectId: string, segmentId: string, newText: string): Promise<boolean>;
  replaceInTranscript(projectId: string, find: string, replace: string): Promise<number>;
  acceptTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  clearTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  setUserOrientation(projectId: string, o: 'landscape' | 'portrait' | null): Promise<void>;
  /** Persist the preview rotation in the .qcp so it survives restart. */
  setPreviewRotation(projectId: string, rotation: 0 | 90 | 180 | 270): Promise<void>;

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
