export type SegmentSource = 'human' | 'ai';
/**
 * Segment lifecycle:
 *   pending  → AI-proposed, awaiting human review
 *   approved → user confirmed "this will be deleted", still visible as red box
 *   rejected → user dismissed; stays in list but contributes nothing to export
 *   cut      → approved segment that has been ripple-cut: collapsed out of the
 *              effective timeline. Segment record stays so the sidebar can
 *              offer a ↶ undo button that flips it back to 'approved'.
 */
export type SegmentStatus = 'pending' | 'approved' | 'rejected' | 'cut';
export type AiMode = 'L2' | 'L3';

export interface Segment {
  id: string;
  start: number;
  end: number;
  source: SegmentSource;
  reason: string | null;
  confidence?: number;
  aiModel?: string;
  status: SegmentStatus;
  createdAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

export interface Range {
  start: number;
  end: number;
}

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  /**
   * Rotation encoded in the container side-data (typical for phone videos).
   * 0 / 90 / 180 / -90 / 270. Exported video must re-apply this rotation when
   * the frames are re-encoded through a filter graph.
   */
  rotation?: number;
}

export interface TranscriptWord {
  w: string;
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
  /**
   * A pending replacement text proposed by the AI assistant. When present,
   * the UI shows a "✓ 接受 / ✗ 忽略" card under this segment. Accepting
   * replaces `text` with this value; ignoring just clears the field.
   */
  suggestion?: {
    text: string;
    reason?: string;
  } | null;
  /**
   * Speaker label assigned by diarization — e.g. 'S1', 'S2'. Optional so
   * pre-diarization transcripts, and projects that never run diarization,
   * continue to work untouched. UI resolves the display name via
   * QcpProject.speakerNames[speaker] before rendering; falls back to the
   * raw ID when no custom name is set.
   */
  speaker?: string;
}

export interface Transcript {
  language: string;
  engine: string;
  model: string;
  segments: TranscriptSegment[];
}

export interface QcpProject {
  version: '2.0';
  videoPath: string;
  videoMeta: VideoMeta;
  transcript: Transcript | null;
  deleteSegments: Segment[];
  aiMode: AiMode;
  /**
   * User-confirmed orientation for subtitle line splitting. When null we
   * fall back to auto-detection from videoMeta.width/height/rotation.
   */
  userOrientation?: 'landscape' | 'portrait' | null;
  /**
   * User-chosen preview rotation in degrees (0 / 90 / 180 / 270). Purely a
   * display preference for the in-app player — never affects the source
   * file or export output. Persisted so re-opening a project remembers the
   * angle the user last viewed it at.
   */
  previewRotation?: 0 | 90 | 180 | 270;
  /**
   * DEPRECATED. Older .qcp files saved during earlier ripple development
   * stored cut ranges here. Current versions put every cut on the segment
   * itself via `status: 'cut'`, so this field is read on load (for migration)
   * but never written. Kept optional so old files still open cleanly.
   */
  cutRanges?: Range[];
  /**
   * Social copy generation results, persisted across sessions. Each set
   * bundles a single "generate" action: the source snapshot at that time,
   * the user's style note, and one SocialCopy per platform that was asked
   * for. Kept independent of highlights/interviews so editing those
   * upstream sources doesn't invalidate previously-generated copy.
   */
  socialCopies?: SocialCopySetData[];
  /** Free-form note the user keeps around to flavour all copy generations. */
  socialStyleNote?: string | null;
  /**
   * Named style presets saved per-project. User can write one style,
   * save it, switch to another, and swap back. The "active" preset is
   * whichever socialStyleNote currently equals — we compare by content
   * rather than by id so editing the note text doesn't orphan the
   * reference.
   */
  socialStylePresets?: SocialStylePresetData[];
  /**
   * User-editable display names for speaker IDs produced by diarization.
   * E.g. { "S1": "主持人", "S2": "嘉宾A" }. Untouched keys are shown as
   * the raw ID. All three diarization fields (this + speaker per segment
   * + diarizationEngine) are optional — never-diarized projects don't
   * even serialize them.
   */
  speakerNames?: Record<string, string>;
  /**
   * Which engine produced the current speaker labels. 'mock' means
   * placeholder data (used until the real sherpa-onnx binary is bundled);
   * the UI shows a banner so the user knows labels aren't real voiceprint
   * output yet.
   */
  diarizationEngine?: 'mock' | 'sherpa-onnx';
  /**
   * Future: persisted voiceprint embeddings for cross-project speaker
   * identification ("this is 张三"). Not implemented in the MVP — field
   * left unreserved so when we add it no migration is needed.
   *   voiceprintLibrary?: Array<{ name: string; embedding: number[] }>
   */
  createdAt: string;
  modifiedAt: string;
}

export interface ProjectHandle {
  projectId: string;
  projectPath: string | null;
  data: QcpProject;
}

/**
 * Persisted shape for social copy. Mirrors SocialCopySet in the renderer
 * layer — we intentionally don't import from copywriter-parser here to
 * keep types.ts as a leaf module (no circular deps).
 */
export interface SocialCopyData {
  id: string;
  platform: string;
  title: string;
  body: string;
  hashtags: string[];
}

/**
 * Saved style preset. Just a named blob of text — the preset's content
 * gets copied into socialStyleNote when selected.
 */
export interface SocialStylePresetData {
  id: string;
  name: string;
  content: string;
  createdAt: string;
}

export interface SocialCopySetData {
  id: string;
  sourceType: 'rippled' | 'variant' | 'interview';
  sourceVariantId?: string;
  sourceTitle: string;
  /** Full text snapshot at generation time — makes this set independent. */
  sourceText: string;
  userStyleNote?: string | null;
  copies: SocialCopyData[];
  createdAt: string;
  model?: string;
}

export type LynLensEvent =
  | { type: 'project.opened'; projectId: string; meta: VideoMeta }
  | { type: 'project.saved'; projectId: string; path: string }
  | { type: 'project.closed'; projectId: string }
  | { type: 'project.reloaded'; projectId: string; segmentCount: number }
  | { type: 'transcript.updated'; projectId: string; segmentId: string }
  | { type: 'transcript.suggestion'; projectId: string; segmentId: string; hasSuggestion: boolean }
  | { type: 'segment.added'; projectId: string; segment: Segment }
  | { type: 'segment.removed'; projectId: string; segmentId: string }
  | { type: 'segment.resized'; projectId: string; segment: Segment }
  | { type: 'segment.approved'; projectId: string; segmentId: string }
  | { type: 'segment.rejected'; projectId: string; segmentId: string }
  | { type: 'segment.merged'; projectId: string; mergedIds: string[]; resultSegment: Segment }
  | { type: 'segment.cut'; projectId: string; segmentId: string }
  | { type: 'segment.uncut'; projectId: string; segmentId: string }
  | { type: 'mode.changed'; projectId: string; mode: AiMode }
  | { type: 'transcription.started'; projectId: string; engine: string }
  | { type: 'transcription.progress'; projectId: string; percent: number }
  | { type: 'transcription.completed'; projectId: string; segmentCount: number }
  | { type: 'transcription.failed'; projectId: string; error: string }
  | { type: 'export.started'; projectId: string; mode: 'fast' | 'precise'; outputPath: string }
  | { type: 'export.progress'; projectId: string; percent: number; stage: string }
  | { type: 'export.completed'; projectId: string; outputPath: string; sizeBytes: number }
  | { type: 'export.failed'; projectId: string; error: string }
  | { type: 'export.canceled'; projectId: string }
  | {
      type: 'ripple.committed';
      projectId: string;
      addedCutRange: Range;
      totalCutSeconds: number;
      effectiveDuration: number;
    }
  | {
      type: 'ripple.reverted';
      projectId: string;
      removedCutRange: Range;
      effectiveDuration: number;
    }
  | { type: 'diarization.completed'; projectId: string }
  | { type: 'diarization.cleared'; projectId: string }
  | { type: 'diarization.renamed'; projectId: string; speakerId: string };

export type EventType = LynLensEvent['type'];
