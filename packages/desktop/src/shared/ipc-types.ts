import type {
  ExportMode,
  ExportQuality,
  HighlightStyle,
  HighlightVariant,
  LynLensEvent,
  PackagingPlan,
  PackagingVibe,
  PreviewPlaylistEntry,
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
  /**
   * Pick a destination directory (folder). Used by batch export to
   * select the target folder for N variant files. Returns the abs
   * path on success, null when user cancels.
   */
  openDirectoryDialog(defaultPath?: string): Promise<string | null>;

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
  /**
   * Toggle the pinned flag on a highlight variant. Pinned variants survive
   * "generate new batch" and persist to .qcp so re-opening the project
   * restores them. Returns false if the variant id is unknown.
   */
  setHighlightPinned(projectId: string, variantId: string, pinned: boolean): Promise<boolean>;
  /**
   * Permanently remove one variant (pinned or not). The UI exposes this
   * via an explicit 🗑 button — unpinning just undoes the pin but keeps
   * the variant in the working set.
   */
  deleteHighlightVariant(projectId: string, variantId: string): Promise<boolean>;
  /**
   * Inline-rename a variant. Empty / whitespace-only title is rejected
   * (returns false). Caller does optimistic UI; on false revert.
   */
  renameHighlightVariant(
    projectId: string,
    variantId: string,
    newTitle: string
  ): Promise<boolean>;
  /**
   * 🪄 enrich — call the AI to fill in (or overwrite) the variant's
   * title + each segment's reason based on transcript content. Throws
   * when no transcript is available. Returns the AI proposal so the
   * UI can optionally show "what changed" feedback.
   */
  enrichHighlightVariant(
    projectId: string,
    variantId: string
  ): Promise<{
    title: string | null;
    reasons: Array<string | null>;
  }>;
  /**
   * Copy one segment from an existing variant into a new pinned
   * variant. Source variant is untouched. Throws on bad ids.
   * Returns the new variant so the renderer can scroll to / select it.
   */
  extractHighlightSegment(
    projectId: string,
    sourceVariantId: string,
    segmentIdx: number
  ): Promise<HighlightVariant>;
  /**
   * Fine-tune the (start, end) of a segment inside a variant. Source
   * time. Returns false on validation failure (overlap / too short /
   * out of bounds). The variant's sourceSnapshot is cleared on success
   * so the user-edited version isn't later flagged as stale.
   */
  updateHighlightVariantSegment(
    projectId: string,
    variantId: string,
    segmentIdx: number,
    newStart: number,
    newEnd: number,
    /** Optional: also overwrite the segment's reason text. */
    newReason?: string
  ): Promise<boolean>;
  /**
   * Move a segment to a new position in the variant's play order.
   * Times unchanged — this only shuffles the array. Returns false on
   * bad indices.
   */
  reorderHighlightVariantSegment(
    projectId: string,
    variantId: string,
    fromIdx: number,
    toIdx: number
  ): Promise<boolean>;
  /**
   * Append a fresh segment to a variant. Validates overlap / bounds /
   * MIN_DUR just like update. Hint = optional "try this source time first"
   * — typically the player's current position. If null or occupied, main
   * searches for an unused slot (see findHighlightInsertSlot). Returns
   * the newly-inserted (start, end) on success, or null if no room.
   */
  addHighlightVariantSegment(
    projectId: string,
    variantId: string,
    hintSec: number | null
  ): Promise<{ start: number; end: number } | null>;
  /**
   * Add a segment with EXPLICIT (start, end) source-time range. Used
   * by the highlight timeline's shift+drag gesture. Returns the
   * (start, end) on success, null on validation failure.
   */
  addHighlightVariantSegmentRange(
    projectId: string,
    variantId: string,
    startSec: number,
    endSec: number,
    reason?: string
  ): Promise<{ start: number; end: number } | null>;

  // ---- Timeline markers (Premiere-style bookmarks) ----
  listMarkers(projectId: string): Promise<
    Array<{ id: string; srcSec: number; label?: string; color?: string }>
  >;
  addMarker(
    projectId: string,
    srcSec: number,
    label?: string,
    color?: string
  ): Promise<{ id: string; srcSec: number; label?: string; color?: string }>;
  moveMarker(
    projectId: string,
    id: string,
    newSrcSec: number
  ): Promise<boolean>;
  removeMarker(projectId: string, id: string): Promise<boolean>;
  updateMarker(
    projectId: string,
    id: string,
    patch: { label?: string | null; color?: string | null }
  ): Promise<boolean>;
  /**
   * Create a fresh empty highlight variant the user fills in themselves.
   * Seeded with one 3-second segment centred at `hintSec` (or 0 if null),
   * auto-pinned so it survives later "重新生成" batches. Title defaults
   * to "自定义 #N" when omitted. Returns the new variant.
   */
  addBlankHighlightVariant(
    projectId: string,
    hintSec: number | null,
    title?: string
  ): Promise<HighlightVariant>;

  /**
   * AI-driven 一键包装 — Claude reads the variant (or whole transcript
   * when variantId is null), outputs a PackagingPlan describing per-
   * segment subtitle styling + camera moves. Persisted to .qcp; the
   * renderer uses it to drive the Remotion preview + export.
   * `vibe` steers the style (default / energetic / calm).
   */
  generatePackagingPlan(
    projectId: string,
    variantId: string | null,
    vibe?: PackagingVibe
  ): Promise<PackagingPlan>;
  /**
   * AI-author a BusinessExplainerSpec for the 商务讲解 (Remotion) template
   * and store it on the variant's plan (templateSpec). The model decides
   * style / keywords / hero-splits / camera + sound editorial lines per
   * RULES.md; timing + text are fixed from the transcript. Returns the
   * updated plan. Used by 一键包装 when the 商务讲解 template is selected.
   */
  generatePackagingSpec(
    projectId: string,
    variantId: string | null
  ): Promise<PackagingPlan>;
  /**
   * 通用 template: build a plain-subtitle spec (every line a `simple` cue,
   * no AI). The user edits text + marks keywords in the 字幕 tab; keywords
   * render yellow Heavy, normal lines white + black outline. Returns the
   * updated plan (templateSpec set).
   */
  generatePackagingSpecSimple(
    projectId: string,
    variantId: string | null
  ): Promise<PackagingPlan>;
  /** Read the saved packaging plan for a variant (or root). */
  getPackagingPlan(
    projectId: string,
    variantId: string | null
  ): Promise<PackagingPlan | null>;
  /** Replace the plan — used by micro-edit panel. */
  setPackagingPlan(projectId: string, plan: PackagingPlan): Promise<void>;
  /** Drop the plan; export reverts to ffmpeg fast path. */
  clearPackagingPlan(
    projectId: string,
    variantId: string | null
  ): Promise<boolean>;
  /**
   * Render (or fetch cached) preview mp4 for a variant (or pass null for
   * 整片, which returns the source mp4 path with a 1:1 playlist). Returns
   * the absolute mp4 path + the variant↔source time mapping used by the
   * subtitle overlay. First call for a fresh variant: a few seconds of
   * hardware-encoded transcode. Subsequent calls: instant cache hit.
   */
  preparePackagingPreview(
    projectId: string,
    variantId: string | null
  ): Promise<{
    outputPath: string;
    playlist: PreviewPlaylistEntry[];
    durationSeconds: number;
    cached: boolean;
    /**
     * Absolute paths of thumbnail JPGs (~24) evenly spaced across the
     * preview clip. Empty for 整片 mode or when extraction failed —
     * UI should gracefully render the timeline without thumbnails.
     */
    thumbnails: string[];
  }>;
  /**
   * Render the variant WITH subtitles burned in by libass. Used by the
   * 包装 tab's "✓ 预览真实导出" button to give pixel-accurate preview.
   * Requires an existing PackagingPlan + transcript + variant (throws
   * if any is missing). 整片 not supported (full-video render with
   * burn-in is too slow for interactive preview).
   */
  preparePackagingVerifyPreview(
    projectId: string,
    variantId: string
  ): Promise<{
    outputPath: string;
    playlist: PreviewPlaylistEntry[];
    durationSeconds: number;
    cached: boolean;
    thumbnails: string[];
  }>;
  /**
   * "✓ 预览真实导出" for the 商务讲解 (Remotion) template: renders the first
   * ~20s of the variant through the REAL Remotion export pipeline to a temp
   * mp4 and returns its path. Pixel-identical to 导出成品 (same renderer),
   * so the packaging tab can show a true-to-export preview without the cost
   * of a full render. variantId null = 整片.
   */
  preparePackagingVerifyRemotion(
    projectId: string,
    variantId: string | null
  ): Promise<{ outputPath: string; durationSeconds: number }>;
  /**
   * Remove one segment from a variant. Refuses to delete the last remaining
   * segment (variant would be empty). Returns false on refusal / failure.
   */
  deleteHighlightVariantSegment(
    projectId: string,
    variantId: string,
    segmentIdx: number
  ): Promise<boolean>;
  /**
   * Export one variant to a file. Same encoder pipeline as the precision
   * tab's `export` IPC (frame-accurate cuts + source color tags); mode +
   * quality are optional with the same defaults the export dialog picks
   * (precise + original) so legacy callers keep working.
   */
  exportHighlight(
    projectId: string,
    variantId: string,
    outputPath: string,
    mode?: 'precise',
    quality?: 'original' | 'high' | 'medium' | 'low'
  ): Promise<ExportResultDto>;
  /**
   * Export a variant (or 整片 when variantId is null) with the current
   * PackagingPlan's花字 burned into the frames via libass. Throws when
   * no plan exists for the target — UI should prompt to "✨ 一键包装"
   * first. Slower than exportHighlight (precise transcode + subtitles
   * filter) but produces the WYSIWYG final video.
   */
  exportPackaged(
    projectId: string,
    variantId: string | null,
    outputPath: string,
    quality?: 'original' | 'high' | 'medium' | 'low'
  ): Promise<ExportResultDto>;
  /**
   * Packaging-tab export via the Remotion `business-explainer` template
   * (vertical CJK / per-char gradient / spring camera punch — effects the
   * libass path can't render). Maps the PackagingPlan → BusinessExplainerSpec,
   * renders the trimmed variant clip through headless Chromium + ffmpeg,
   * and stamps BT.709 color. Progress arrives on the same `export.progress`
   * event channel as the other exports. Scope: packaging tab only.
   */
  exportPackagedRemotion(
    projectId: string,
    variantId: string | null,
    outputPath: string
  ): Promise<{ outputPath: string; sizeBytes: number }>;
  /**
   * Base URL of the localhost media server, e.g. http://127.0.0.1:PORT/TOKEN.
   * The live Remotion player builds video URLs as `${base}/media?p=<encoded
   * abs path>` — the player can't load the lynlens-media:// scheme. Null if
   * the server failed to start.
   */
  getMediaHttpBase(): Promise<string | null>;
  /**
   * Absolute path to the OS Downloads dir. Renderer uses this so the
   * ExportDialog can pre-fill a full path instead of a bare filename
   * (which would silently land in process.cwd() — invisible to the user).
   */
  getDownloadsDir(): Promise<string>;

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
    projectId: string,
    opts?: { speakerCount?: number }
  ): Promise<{ engine: 'mock' | 'sherpa-onnx'; speakers: string[]; segmentCount: number }>;
  /** Rename (or clear) the display name for a speaker ID. */
  renameSpeaker(projectId: string, speakerId: string, name: string | null): Promise<void>;
  /** Drop all speaker labels from the transcript + clear engine marker. */
  clearSpeakers(projectId: string): Promise<void>;
  /** Move every segment tagged `from` to speaker `to` (fixes over-split). */
  mergeSpeakers(projectId: string, from: string, to: string): Promise<number>;
  /** Retag one transcript segment's speaker (fixes an isolated mislabel). */
  setSegmentSpeaker(
    projectId: string,
    transcriptSegmentId: string,
    speaker: string | null
  ): Promise<boolean>;
  /**
   * Sweep every currently-unlabeled transcript segment and assign it the
   * speaker of its nearest labeled neighbor. Returns the count of newly
   * labeled segments. Returns 0 (and does nothing) if the transcript has
   * no labeled segments to copy from.
   */
  autoAssignUnlabeledSpeakers(projectId: string): Promise<number>;

  transcribe(
    projectId: string,
    opts: { engine?: 'whisper-local' | 'openai-api'; language?: string }
  ): Promise<{ segmentCount: number; language: string; engine: string }>;
  updateTranscriptSegment(projectId: string, segmentId: string, newText: string): Promise<boolean>;
  /**
   * Nudge / overwrite a transcript segment's (start,end). Times are source
   * time (not effective) — the caller is responsible for converting from
   * effective to source before invoking. Returns false on validation or
   * lookup failure.
   */
  updateTranscriptSegmentTime(
    projectId: string,
    segmentId: string,
    newStart: number,
    newEnd: number
  ): Promise<boolean>;
  /**
   * Persist (or clear) the dismissal fingerprint for the "straddles a cut"
   * warning on one transcript segment. Passing null / '' clears it so the
   * ⚠ will re-appear next render. See `Transcript.warningFingerprint`.
   */
  setTranscriptWarningFingerprint(
    projectId: string,
    segmentId: string,
    fingerprint: string | null
  ): Promise<boolean>;
  replaceInTranscript(projectId: string, find: string, replace: string): Promise<number>;
  /**
   * Remove a transcript segment entirely. Used after the user has consolidated
   * its text into a neighbour and wants the now-empty card gone. Returns true
   * if the segment existed.
   */
  removeTranscriptSegment(projectId: string, segmentId: string): Promise<boolean>;
  /** Bulk: remove every transcript segment whose text trims to empty. Returns count removed. */
  removeEmptyTranscriptSegments(projectId: string): Promise<number>;
  /**
   * Insert a new empty transcript segment right after `afterSegmentId`. Used
   * by the "+" button on each card. Returns the new segment, or null if
   * there's no room (anchor is at video end) or the anchor doesn't exist.
   */
  insertTranscriptSegmentAfter(
    projectId: string,
    afterSegmentId: string
  ): Promise<{
    id: string;
    start: number;
    end: number;
    text: string;
    words: Array<{ w: string; start: number; end: number }>;
  } | null>;
  acceptTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  clearTranscriptSuggestion(projectId: string, segmentId: string): Promise<boolean>;
  /**
   * Save SRT content to disk via the native save-dialog. Defaults the
   * destination to the source video's folder + basename + .srt. Returns
   * the chosen absolute path on success, null when the user cancels.
   */
  saveSrt(projectId: string, content: string): Promise<string | null>;

  /**
   * Import an external .srt file as the project's transcript. When
   * `srtPath` is omitted a native file picker opens (defaults to the
   * source video's folder). Returns null when the user cancels the
   * picker; on success returns the segment count + detected language
   * + the absolute path that was read.
   *
   * Post-processing matches `transcribe`: cut filter, learned auto-
   * corrections, proper-noun case normalisation, English fragment
   * merge. Replaces any existing transcript without confirmation —
   * caller should warn if needed.
   */
  importSrtIntoProject(
    projectId: string,
    srtPath?: string
  ): Promise<{ segmentCount: number; language: string; sourcePath: string } | null>;

  // ---- Learning memory ----
  /**
   * Compact summary of what LynLens has learned so far (counts + most-recent
   * corrections + pending-promotion entries). Used by the subtitle panel's
   * status banner and the learning manage dialog.
   */
  learningGetSnapshot(): Promise<{
    autoCorrectionCount: number;
    properNounCount: number;
    keepOriginalCount: number;
    recentCorrections: Array<{
      from: string;
      to: string;
      count: number;
      firstSeenAt: string;
      lastSeenAt: string;
      seenInProjects: string[];
    }>;
    pendingPromotions: Array<{
      from: string;
      to: string;
      count: number;
      firstSeenAt: string;
      lastSeenAt: string;
      seenInProjects: string[];
    }>;
  }>;
  /** Full dump of learning memory state — used by the manage dialog. */
  learningGetAll(): Promise<{
    autoCorrections: Record<string, string>;
    properNouns: Record<string, string>;
    keepOriginal: string[];
    correctionLog: Array<{
      from: string;
      to: string;
      count: number;
      firstSeenAt: string;
      lastSeenAt: string;
      seenInProjects: string[];
    }>;
  }>;
  /** Remove a learned rule. Returns true if something was actually forgotten. */
  learningForget(kind: 'correction' | 'noun' | 'keep', key: string): Promise<boolean>;
  /** Wipe all learned state. Caller is expected to confirm with the user first. */
  learningReset(): Promise<void>;
  /**
   * Force-promote a correction to auto-correction (bypasses the count-3
   * threshold). Backs the "应用" button on pending entries.
   */
  learningPromote(from: string, to: string): Promise<void>;
  /**
   * One-time import from the `wilon@subtitle-craft` skill's learning-memory
   * JSON. If `jsonPath` is omitted the main process tries the default skill
   * path; if missing, prompts the user with a file picker. Returns count of
   * NEW entries added, or null if the user cancelled.
   */
  learningImportSkill(jsonPath?: string): Promise<{
    autoCorrections: number;
    properNouns: number;
    keepOriginal: number;
  } | null>;

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
  /** Which AI backend is currently active. Persists across app restarts. */
  agentGetProvider(): Promise<'claude' | 'codex'>;
  /** Switch AI backend. Clears in-memory chat session so the next message starts fresh. */
  agentSetProvider(provider: 'claude' | 'codex'): Promise<void>;
  /**
   * Open (or focus if already open) the detached Agent chat window. Main
   * creates a second BrowserWindow loading the same bundle with
   * `?panel=chat`. Returns once the window has been created / focused.
   */
  openAgentWindow(): Promise<void>;
  /**
   * The detached window asks for the currently-active project — main
   * tracks it via `agentSetActiveProjectId` below. Returns null if no
   * project is open in the editor window.
   */
  agentGetActiveProjectId(): Promise<string | null>;
  /**
   * Editor window tells main which project it has active. Main then
   * broadcasts `active-project-changed` to every other window so the
   * Agent popup can re-target automatically.
   */
  agentSetActiveProjectId(projectId: string | null): Promise<void>;
  /** Detached window subscription to active-project changes. */
  onActiveProjectChanged(callback: (projectId: string | null) => void): () => void;
  /** Toggle the detached Agent window's always-on-top flag. */
  setAgentWindowPinned(pinned: boolean): Promise<void>;
  /** Read the current always-on-top state (for restoring toggle UI). */
  getAgentWindowPinned(): Promise<boolean>;
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
