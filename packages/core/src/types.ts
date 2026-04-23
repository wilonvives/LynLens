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
   * DEPRECATED. Older .qcp files saved during earlier ripple development
   * stored cut ranges here. Current versions put every cut on the segment
   * itself via `status: 'cut'`, so this field is read on load (for migration)
   * but never written. Kept optional so old files still open cleanly.
   */
  cutRanges?: Range[];
  createdAt: string;
  modifiedAt: string;
}

export interface ProjectHandle {
  projectId: string;
  projectPath: string | null;
  data: QcpProject;
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
    };

export type EventType = LynLensEvent['type'];
