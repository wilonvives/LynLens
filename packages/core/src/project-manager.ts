import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { EventBus } from './event-bus';
import { SegmentManager } from './segment-manager';
import {
  applySpeakersToTranscript,
  clearTranscriptSpeakers,
  type DiarizationResult,
} from './diarization';
import { getEffectiveDuration } from './ripple';
import type { HighlightVariant } from './highlight-parser';
import { fingerprintTranscript, hashCutRanges } from './variant-status';
import type {
  AiMode,
  ProjectHandle,
  QcpProject,
  Range,
  Segment,
  SocialCopySetData,
  SocialStylePresetData,
  Transcript,
  VideoMeta,
} from './types';

export class Project {
  readonly id: string;
  readonly eventBus: EventBus;
  /** SegmentManager is rebuilt when the project reloads from disk. */
  segments: SegmentManager;
  videoPath: string;
  videoMeta: VideoMeta;
  transcript: Transcript | null;
  aiMode: AiMode;
  userOrientation: 'landscape' | 'portrait' | null;
  /** Preview-only rotation; never affects export. See QcpProject.previewRotation. */
  previewRotation: 0 | 90 | 180 | 270;
  /**
   * Social copy sets — persisted, survives regenerate of highlights /
   * interviews because the source text is snapshotted inside each set.
   */
  socialCopies: SocialCopySetData[];
  /** User-editable global style note applied to all future generations. */
  socialStyleNote: string | null;
  /** Named style presets for quick swap in/out during the same project. */
  socialStylePresets: SocialStylePresetData[];
  /** Display names for diarization speaker IDs (S1 → "主持人" etc). */
  speakerNames: Record<string, string>;
  /** Which engine produced the current speaker labels (or null if unset). */
  diarizationEngine: 'mock' | 'sherpa-onnx' | null;
  createdAt: string;
  modifiedAt: string;
  projectPath: string | null;
  /**
   * Highlight variants. Persisted to .qcp (method C):
   *   - Default save-all. Re-opening a project restores them.
   *   - `pinned: true` protects a variant from "generate new batch" overwrites.
   *   - Each variant carries a `sourceSnapshot` (cut hash + transcript
   *     fingerprint) so the UI can mark stale / invalidated ones at render
   *     time without mutating the stored record. See variant-status.ts.
   *
   * When the user goes back to 粗剪 and changes cuts / regenerates the
   * transcript, variants are NOT deleted — they surface with a warning
   * banner, and if a segment falls fully inside a new cut, playback is
   * disabled for that specific variant.
   */
  highlightVariants: HighlightVariant[] = [];

  constructor(handle: ProjectHandle, eventBus: EventBus) {
    this.id = handle.projectId;
    this.projectPath = handle.projectPath;
    this.videoPath = handle.data.videoPath;
    this.videoMeta = handle.data.videoMeta;
    this.transcript = handle.data.transcript;
    this.aiMode = handle.data.aiMode;
    this.userOrientation = handle.data.userOrientation ?? null;
    this.previewRotation = normalizeRotation(handle.data.previewRotation);
    this.socialCopies = Array.isArray(handle.data.socialCopies)
      ? [...handle.data.socialCopies]
      : [];
    this.socialStyleNote = handle.data.socialStyleNote ?? null;
    this.socialStylePresets = Array.isArray(handle.data.socialStylePresets)
      ? [...handle.data.socialStylePresets]
      : [];
    this.speakerNames = { ...(handle.data.speakerNames ?? {}) };
    this.diarizationEngine = handle.data.diarizationEngine ?? null;
    // Restore persisted highlight variants, if any. Legacy .qcp files don't
    // have this field — treat as empty. sourceSnapshot may be absent on
    // variants generated before the persistence feature landed; the status
    // classifier treats them as 'unknown' (still playable, no warning).
    this.highlightVariants = Array.isArray(handle.data.highlightVariants)
      ? handle.data.highlightVariants.map((v) => ({
          id: v.id,
          title: v.title,
          style: v.style,
          segments: [...v.segments],
          durationSeconds: v.durationSeconds,
          createdAt: v.createdAt,
          model: v.model,
          pinned: v.pinned,
          sourceSnapshot: v.sourceSnapshot,
        }))
      : [];
    this.createdAt = handle.data.createdAt;
    this.modifiedAt = handle.data.modifiedAt;
    this.eventBus = eventBus;
    // Migrate legacy .qcp files: any cutRanges stored as a separate array get
    // upgraded to segments with `status: 'cut'`. We only add ranges that
    // don't already appear as a segment in this file (first-run dedupe).
    const initialSegments: Segment[] = [...handle.data.deleteSegments];
    const legacyCuts = handle.data.cutRanges ?? [];
    if (legacyCuts.length > 0) {
      const now = new Date().toISOString();
      for (const r of legacyCuts) {
        const alreadyPresent = initialSegments.some(
          (s) => Math.abs(s.start - r.start) < 1e-6 && Math.abs(s.end - r.end) < 1e-6
        );
        if (!alreadyPresent) {
          initialSegments.push({
            id: uuid(),
            start: r.start,
            end: r.end,
            source: 'human',
            reason: null,
            status: 'cut',
            createdAt: now,
            reviewedBy: 'migration',
            reviewedAt: now,
          });
        }
      }
    }
    this.segments = new SegmentManager(this.id, eventBus, initialSegments);
  }

  /**
   * Derived — the source-time ranges that are currently rippled out of the
   * effective timeline. Always read through this getter; never store a copy,
   * because the list changes any time a user clicks ↶ on a cut segment.
   */
  get cutRanges(): Range[] {
    return this.segments
      .getCutSegments()
      .map((s) => ({ start: s.start, end: s.end }));
  }

  /**
   * Replace this project's in-memory state with fresh data loaded from disk.
   * Used by the desktop UI when MCP/CLI has written changes externally.
   */
  reloadFrom(data: QcpProject): void {
    this.transcript = data.transcript;
    this.aiMode = data.aiMode;
    this.userOrientation = data.userOrientation ?? null;
    this.previewRotation = normalizeRotation(data.previewRotation);
    this.socialCopies = Array.isArray(data.socialCopies) ? [...data.socialCopies] : [];
    this.socialStyleNote = data.socialStyleNote ?? null;
    this.socialStylePresets = Array.isArray(data.socialStylePresets)
      ? [...data.socialStylePresets]
      : [];
    this.speakerNames = { ...(data.speakerNames ?? {}) };
    this.diarizationEngine = data.diarizationEngine ?? null;
    this.modifiedAt = data.modifiedAt;
    // Same legacy-cutRanges migration logic as the constructor — keep in sync.
    const initialSegments: Segment[] = [...data.deleteSegments];
    const legacyCuts = data.cutRanges ?? [];
    if (legacyCuts.length > 0) {
      const now = new Date().toISOString();
      for (const r of legacyCuts) {
        const alreadyPresent = initialSegments.some(
          (s) => Math.abs(s.start - r.start) < 1e-6 && Math.abs(s.end - r.end) < 1e-6
        );
        if (!alreadyPresent) {
          initialSegments.push({
            id: uuid(),
            start: r.start,
            end: r.end,
            source: 'human',
            reason: null,
            status: 'cut',
            createdAt: now,
            reviewedBy: 'migration',
            reviewedAt: now,
          });
        }
      }
    }
    this.segments = new SegmentManager(this.id, this.eventBus, initialSegments);
    this.eventBus.emit({
      type: 'project.reloaded',
      projectId: this.id,
      segmentCount: initialSegments.length,
    });
  }

  setMode(mode: AiMode): void {
    this.aiMode = mode;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'mode.changed', projectId: this.id, mode });
  }

  setUserOrientation(o: 'landscape' | 'portrait' | null): void {
    this.userOrientation = o;
    this.modifiedAt = new Date().toISOString();
  }

  setPreviewRotation(deg: 0 | 90 | 180 | 270): void {
    this.previewRotation = deg;
    this.modifiedAt = new Date().toISOString();
  }

  setTranscript(transcript: Transcript): void {
    this.transcript = transcript;
    this.modifiedAt = new Date().toISOString();
  }

  /**
   * Edit a single transcript segment's text (spelling corrections, fixing
   * homophones, etc). Preserves the segment's start/end timing and its word
   * array — only the displayed text changes.
   */
  updateTranscriptSegment(segmentId: string, newText: string): boolean {
    if (!this.transcript) return false;
    const seg = this.transcript.segments.find((s) => s.id === segmentId);
    if (!seg) return false;
    seg.text = newText;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId });
    return true;
  }

  /**
   * Edit a transcript segment's start / end (source time). Word-level
   * timings are NOT re-scaled — they become stale. We don't use them in
   * the current feature set so this is acceptable; document the trade.
   *
   * Cascade behavior: if the new range would overlap a chronological
   * neighbor, the neighbor's NEAR edge is shifted to keep a 10ms gap —
   * the neighbor's far edge is left untouched. Net effect: the neighbor
   * is "compressed" rather than bodily slid, which localizes the edit.
   *
   *   before: [A 0.00-4.23][B 4.24-7.04][C 7.05-9.0]
   *   nudge A.end +0.03 → A ends at 4.26
   *   after : [A 0.00-4.26][B 4.27-7.04][C 7.05-9.0]
   *          (B.start pushed, B.end kept, C untouched)
   *
   * If the forced shift would shrink the neighbor below MIN_DUR (50ms),
   * the edit is CAPPED at the boundary that still leaves MIN_DUR —
   * better to refuse a destructive nudge than silently delete a line.
   */
  updateTranscriptSegmentTime(
    segmentId: string,
    newStart: number,
    newEnd: number
  ): boolean {
    if (!this.transcript) return false;
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) return false;
    if (newEnd <= newStart) return false;
    if (newStart < 0) return false;

    const segs = this.transcript.segments;
    const target = segs.find((s) => s.id === segmentId);
    if (!target) return false;

    const MIN_GAP = 0.01; // 10ms — visually zero, keeps end < start enforced
    const MIN_DUR = 0.5; // 500ms — any shorter than this is unreadable, cap nudge

    const oldStart = target.start;
    const oldEnd = target.end;

    // Build a chronological view of the other segments (shared object
    // references, so mutating via this list mutates the transcript).
    const ordered = [...segs].sort((a, b) => a.start - b.start);
    const idx = ordered.findIndex((s) => s.id === segmentId);
    const prev = idx > 0 ? ordered[idx - 1] : null;
    const next = idx >= 0 && idx < ordered.length - 1 ? ordered[idx + 1] : null;

    // End moved right → may collide with next; push next.start (not next.end)
    if (next && newEnd > oldEnd && newEnd + MIN_GAP > next.start) {
      const wantedNextStart = newEnd + MIN_GAP;
      if (next.end - wantedNextStart < MIN_DUR) {
        // Cap our target.end so next keeps at least MIN_DUR of breathing room.
        const cappedEnd = next.end - MIN_DUR - MIN_GAP;
        if (cappedEnd <= newStart) return false;
        newEnd = cappedEnd;
        next.start = newEnd + MIN_GAP;
      } else {
        next.start = wantedNextStart;
      }
    }

    // Start moved left → may collide with prev; pull prev.end (not prev.start)
    if (prev && newStart < oldStart && newStart - MIN_GAP < prev.end) {
      const wantedPrevEnd = newStart - MIN_GAP;
      if (wantedPrevEnd - prev.start < MIN_DUR) {
        const cappedStart = prev.start + MIN_DUR + MIN_GAP;
        if (cappedStart >= newEnd) return false;
        newStart = cappedStart;
        prev.end = newStart - MIN_GAP;
      } else {
        prev.end = wantedPrevEnd;
      }
    }

    target.start = newStart;
    target.end = newEnd;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId });
    return true;
  }

  /**
   * Store (or clear) the warning fingerprint for a transcript segment.
   * Passing null clears the field — the ⚠ will reappear on next render.
   */
  setTranscriptWarningFingerprint(
    segmentId: string,
    fingerprint: string | null
  ): boolean {
    if (!this.transcript) return false;
    const seg = this.transcript.segments.find((s) => s.id === segmentId);
    if (!seg) return false;
    if (fingerprint === null || fingerprint === '') {
      delete seg.warningFingerprint;
    } else {
      seg.warningFingerprint = fingerprint;
    }
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId });
    return true;
  }

  /**
   * Auto-assign a speaker to every transcript segment that currently has
   * no speaker label. Uses a nearest-labeled-neighbor heuristic based on
   * segment midpoint distance: the closest labeled segment donates its
   * speaker. Returns the number of segments that got a new label.
   *
   * Intentional choices:
   *   - No AI call. Diarization gaps are usually short and local; the
   *     nearest labeled neighbor is right ~95% of the time, instantly
   *     and for free.
   *   - Skips if no segments are labeled — nothing to copy from. Caller
   *     should nudge the user to run diarization / label at least one
   *     segment first.
   *   - Manual trigger (not automatic post-transcription) because the
   *     user asked to preserve "deliberately cleared" labels. The sweep
   *     only runs when they click the button.
   */
  autoAssignUnlabeledSpeakers(): number {
    if (!this.transcript) return 0;
    const segs = this.transcript.segments;
    // Precompute the labeled set once — O(N) scan per call instead of
    // re-filtering per unlabeled segment.
    const labeled: Array<{ mid: number; speaker: string }> = [];
    for (const s of segs) {
      if (s.speaker) labeled.push({ mid: (s.start + s.end) / 2, speaker: s.speaker });
    }
    if (labeled.length === 0) return 0;

    let assigned = 0;
    let firstModifiedId: string | null = null;
    for (const seg of segs) {
      if (seg.speaker) continue;
      const mid = (seg.start + seg.end) / 2;
      let bestSpeaker = labeled[0].speaker;
      let bestDist = Math.abs(labeled[0].mid - mid);
      for (let i = 1; i < labeled.length; i++) {
        const d = Math.abs(labeled[i].mid - mid);
        if (d < bestDist) {
          bestDist = d;
          bestSpeaker = labeled[i].speaker;
        }
      }
      seg.speaker = bestSpeaker;
      assigned++;
      if (!firstModifiedId) firstModifiedId = seg.id;
    }

    if (assigned > 0 && firstModifiedId) {
      this.modifiedAt = new Date().toISOString();
      // Single emit is enough — App refetches the full transcript on
      // transcript.updated regardless of which segmentId is carried.
      this.eventBus.emit({
        type: 'transcript.updated',
        projectId: this.id,
        segmentId: firstModifiedId,
      });
    }
    return assigned;
  }

  /**
   * Stage a suggested replacement (AI-proposed) for a given transcript
   * segment. Does NOT change the actual text — the user must accept it first.
   */
  suggestTranscriptFix(segmentId: string, newText: string, reason?: string): boolean {
    if (!this.transcript) return false;
    const seg = this.transcript.segments.find((s) => s.id === segmentId);
    if (!seg) return false;
    seg.suggestion = { text: newText, reason };
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({
      type: 'transcript.suggestion',
      projectId: this.id,
      segmentId,
      hasSuggestion: true,
    });
    return true;
  }

  /** Apply a staged suggestion: replace the segment text with it, then clear. */
  acceptTranscriptSuggestion(segmentId: string): boolean {
    if (!this.transcript) return false;
    const seg = this.transcript.segments.find((s) => s.id === segmentId);
    if (!seg || !seg.suggestion) return false;
    seg.text = seg.suggestion.text;
    seg.suggestion = null;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId });
    this.eventBus.emit({
      type: 'transcript.suggestion',
      projectId: this.id,
      segmentId,
      hasSuggestion: false,
    });
    return true;
  }

  /** Discard a staged suggestion without applying it. */
  clearTranscriptSuggestion(segmentId: string): boolean {
    if (!this.transcript) return false;
    const seg = this.transcript.segments.find((s) => s.id === segmentId);
    if (!seg || !seg.suggestion) return false;
    seg.suggestion = null;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({
      type: 'transcript.suggestion',
      projectId: this.id,
      segmentId,
      hasSuggestion: false,
    });
    return true;
  }

  /**
   * Find / replace across all transcript segments. Returns the number of
   * segments that actually changed.
   */
  replaceInTranscript(find: string, replace: string, flags = 'g'): number {
    if (!this.transcript || !find) return 0;
    const re = new RegExp(escapeRegExp(find), flags);
    let changed = 0;
    for (const seg of this.transcript.segments) {
      const next = seg.text.replace(re, replace);
      if (next !== seg.text) {
        seg.text = next;
        this.eventBus.emit({ type: 'transcript.updated', projectId: this.id, segmentId: seg.id });
        changed += 1;
      }
    }
    if (changed > 0) this.modifiedAt = new Date().toISOString();
    return changed;
  }

  toQcp(): QcpProject {
    return {
      version: '2.0',
      videoPath: this.videoPath,
      videoMeta: this.videoMeta,
      transcript: this.transcript,
      // Cut segments now live inside deleteSegments (with status='cut'), so
      // there's no separate cutRanges field to write. We deliberately omit
      // it — old files with cutRanges are migrated on load.
      deleteSegments: this.segments.list(),
      aiMode: this.aiMode,
      userOrientation: this.userOrientation,
      previewRotation: this.previewRotation,
      socialCopies: this.socialCopies,
      socialStyleNote: this.socialStyleNote,
      socialStylePresets: this.socialStylePresets,
      speakerNames: this.speakerNames,
      diarizationEngine: this.diarizationEngine ?? undefined,
      // Persist highlight variants. Serialized shape (HighlightVariantData)
      // is a direct mirror of the runtime HighlightVariant, so a shallow
      // copy is enough. If the list is empty we omit the key so old .qcp
      // files don't sprout a noisy `"highlightVariants": []` on re-save.
      highlightVariants:
        this.highlightVariants.length > 0
          ? this.highlightVariants.map((v) => ({
              id: v.id,
              title: v.title,
              style: v.style,
              segments: v.segments.map((s) => ({
                start: s.start,
                end: s.end,
                reason: s.reason,
              })),
              durationSeconds: v.durationSeconds,
              createdAt: v.createdAt,
              model: v.model,
              pinned: v.pinned,
              sourceSnapshot: v.sourceSnapshot,
            }))
          : undefined,
      createdAt: this.createdAt,
      modifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Commit ripple: every approved delete segment transitions to `cut` status.
   * The segment records stay in the list (sidebar shows them with a ↶ button)
   * so the user can undo any single cut without leaving the workflow. The
   * effective timeline is derived from cut-status segments via the cutRanges
   * getter — no separate state to keep in sync.
   */
  commitRipple(): {
    totalCutSeconds: number;
    effectiveDuration: number;
    cutSegmentIds: string[];
  } {
    const approved = this.segments.getApprovedSegments();
    if (approved.length === 0) {
      return {
        totalCutSeconds: 0,
        effectiveDuration: getEffectiveDuration(this.videoMeta.duration, this.cutRanges),
        cutSegmentIds: [],
      };
    }

    const cutSegmentIds = approved.map((s) => s.id);
    for (const id of cutSegmentIds) this.segments.markCut(id, 'user');
    this.modifiedAt = new Date().toISOString();

    const totalCutSeconds = this.segments.getTotalCutDuration();
    const effectiveDuration = getEffectiveDuration(this.videoMeta.duration, this.cutRanges);
    this.eventBus.emit({
      type: 'ripple.committed',
      projectId: this.id,
      addedCutRange: {
        start: Math.min(...approved.map((s) => s.start)),
        end: Math.max(...approved.map((s) => s.end)),
      },
      totalCutSeconds,
      effectiveDuration,
    });

    return { totalCutSeconds, effectiveDuration, cutSegmentIds };
  }

  /**
   * Undo a single cut by segment id. The segment flips from `cut` back to
   * `approved`, its source range re-enters the effective timeline, and
   * everything after it shifts right to restore the lost duration.
   */
  revertRipple(segmentId: string): boolean {
    const seg = this.segments.find(segmentId);
    if (!seg || seg.status !== 'cut') return false;
    this.segments.restoreFromCut(segmentId, 'user');
    this.modifiedAt = new Date().toISOString();
    const effectiveDuration = getEffectiveDuration(this.videoMeta.duration, this.cutRanges);
    this.eventBus.emit({
      type: 'ripple.reverted',
      projectId: this.id,
      removedCutRange: { start: seg.start, end: seg.end },
      effectiveDuration,
    });
    return true;
  }

  /** Convenience for callers that need to reason about the compacted timeline. */
  getEffectiveDuration(): number {
    return getEffectiveDuration(this.videoMeta.duration, this.cutRanges);
  }

  /**
   * Replace the working-set of highlight variants with a fresh batch.
   *
   * Preserves pinned variants: any existing variant with `pinned: true`
   * stays in the list regardless of this call. The new (unpinned) batch
   * is appended afterwards — so the UI shows "📌 your kept ones" first,
   * then the latest generation below.
   *
   * Also stamps each new variant with a sourceSnapshot if one isn't
   * already provided by the caller, so post-save staleness detection has
   * something to compare against.
   */
  setHighlightVariants(variants: HighlightVariant[]): void {
    const pinned = this.highlightVariants.filter((v) => v.pinned);
    const cutHash = hashCutRanges(this.cutRanges);
    const transcriptFp = fingerprintTranscript(this.transcript);
    const freshlyStamped = variants.map((v) => ({
      ...v,
      sourceSnapshot: v.sourceSnapshot ?? {
        cutRangesHash: cutHash,
        transcriptFingerprint: transcriptFp,
      },
    }));
    this.highlightVariants = [...pinned, ...freshlyStamped];
    this.modifiedAt = new Date().toISOString();
  }

  /**
   * Drop all variants EXCEPT pinned ones. Called when the user switches
   * back to 粗剪 tab — we don't want the stale batch lingering in memory,
   * but anything they explicitly saved with 📌 should survive.
   */
  clearHighlightVariants(): void {
    this.highlightVariants = this.highlightVariants.filter((v) => v.pinned);
    this.modifiedAt = new Date().toISOString();
  }

  /** Flip a variant's pinned state. Returns false if the id wasn't found. */
  setHighlightVariantPinned(variantId: string, pinned: boolean): boolean {
    const idx = this.highlightVariants.findIndex((v) => v.id === variantId);
    if (idx < 0) return false;
    const next = [...this.highlightVariants];
    next[idx] = { ...next[idx], pinned };
    this.highlightVariants = next;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Adjust the (start, end) of a single segment inside a variant. Source
   * time. Validates:
   *   - newEnd > newStart + MIN_DUR (0.2s) — prevents collapsed blips
   *   - stays inside [0, videoDuration]
   *   - doesn't overlap adjacent segments in the same variant
   *
   * Returns false if validation fails or the ids are unknown; caller
   * should surface the error. Clears `sourceSnapshot` on success — once
   * the user hand-tunes a variant, the AI-snapshot-based staleness
   * check no longer applies (user takes ownership).
   */
  updateHighlightVariantSegment(
    variantId: string,
    segmentIdx: number,
    newStart: number,
    newEnd: number,
    /**
     * Optional: also update the segment's reason text. When undefined,
     * the existing reason is preserved. Empty string is allowed (clears).
     */
    newReason?: string
  ): boolean {
    const MIN_DUR = 0.2;
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) return false;
    if (newEnd - newStart < MIN_DUR) return false;
    if (newStart < 0 || newEnd > this.videoMeta.duration) return false;

    const vIdx = this.highlightVariants.findIndex((v) => v.id === variantId);
    if (vIdx < 0) return false;
    const variant = this.highlightVariants[vIdx];
    if (segmentIdx < 0 || segmentIdx >= variant.segments.length) return false;

    // Overlap check against siblings — but only the ones that currently
    // touch the same region. We don't enforce chronological ordering
    // (users may re-order intentionally); we just refuse to let two
    // segments overlap in source time, which would confuse playback.
    for (let i = 0; i < variant.segments.length; i++) {
      if (i === segmentIdx) continue;
      const other = variant.segments[i];
      const overlaps = newStart < other.end && newEnd > other.start;
      if (overlaps) return false;
    }

    const nextSegs = variant.segments.map((s, i) =>
      i === segmentIdx
        ? {
            ...s,
            start: newStart,
            end: newEnd,
            reason: newReason !== undefined ? newReason : s.reason,
          }
        : s
    );
    const nextVariant = {
      ...variant,
      segments: nextSegs,
      durationSeconds: nextSegs.reduce((sum, s) => sum + (s.end - s.start), 0),
      // Clearing the snapshot means getVariantStatus returns 'unknown'
      // (no banner) — user edits aren't retroactively flagged as stale.
      sourceSnapshot: undefined,
    };
    const nextVariants = [...this.highlightVariants];
    nextVariants[vIdx] = nextVariant;
    this.highlightVariants = nextVariants;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Append a new segment to a variant. Source time. Same validation as
   * updateHighlightVariantSegment (MIN_DUR, in-bounds, no overlap). Does
   * NOT sort — the segment lands at the end of the array, matching the
   * call-order user intent. Returns false on validation failure.
   *
   * Caller supplies (start, end). If you want "just give me a reasonable
   * new segment", use findInsertSlot() below and pass its result.
   */
  addHighlightVariantSegment(
    variantId: string,
    newStart: number,
    newEnd: number,
    reason: string = '手动添加'
  ): boolean {
    const MIN_DUR = 0.2;
    if (!Number.isFinite(newStart) || !Number.isFinite(newEnd)) return false;
    if (newEnd - newStart < MIN_DUR) return false;
    if (newStart < 0 || newEnd > this.videoMeta.duration) return false;

    const vIdx = this.highlightVariants.findIndex((v) => v.id === variantId);
    if (vIdx < 0) return false;
    const variant = this.highlightVariants[vIdx];

    for (const other of variant.segments) {
      if (newStart < other.end && newEnd > other.start) return false;
    }

    const nextSegs = [...variant.segments, { start: newStart, end: newEnd, reason }];
    const nextVariant = {
      ...variant,
      segments: nextSegs,
      durationSeconds: nextSegs.reduce((sum, s) => sum + (s.end - s.start), 0),
      sourceSnapshot: undefined,
    };
    const nextVariants = [...this.highlightVariants];
    nextVariants[vIdx] = nextVariant;
    this.highlightVariants = nextVariants;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Remove one segment from a variant. Returns false if the indices are
   * out of range OR if the variant would be left empty (we keep at least
   * one segment so there's always something to play — if the user really
   * wants the variant gone, they can delete the whole variant).
   */
  deleteHighlightVariantSegment(variantId: string, segmentIdx: number): boolean {
    const vIdx = this.highlightVariants.findIndex((v) => v.id === variantId);
    if (vIdx < 0) return false;
    const variant = this.highlightVariants[vIdx];
    if (segmentIdx < 0 || segmentIdx >= variant.segments.length) return false;
    if (variant.segments.length <= 1) return false;

    const nextSegs = variant.segments.filter((_, i) => i !== segmentIdx);
    const nextVariant = {
      ...variant,
      segments: nextSegs,
      durationSeconds: nextSegs.reduce((sum, s) => sum + (s.end - s.start), 0),
      sourceSnapshot: undefined,
    };
    const nextVariants = [...this.highlightVariants];
    nextVariants[vIdx] = nextVariant;
    this.highlightVariants = nextVariants;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Move a segment to a new position within the variant's ordered list.
   * Playback follows this order, so moving #3 to index 0 makes it play
   * first. Times (start, end) unchanged — this only affects the array
   * sequence. Returns false on bad indices.
   */
  reorderHighlightVariantSegment(
    variantId: string,
    fromIdx: number,
    toIdx: number
  ): boolean {
    const vIdx = this.highlightVariants.findIndex((v) => v.id === variantId);
    if (vIdx < 0) return false;
    const variant = this.highlightVariants[vIdx];
    const n = variant.segments.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n) return false;
    if (fromIdx === toIdx) return true;

    const nextSegs = [...variant.segments];
    const [moved] = nextSegs.splice(fromIdx, 1);
    nextSegs.splice(toIdx, 0, moved);
    const nextVariants = [...this.highlightVariants];
    nextVariants[vIdx] = { ...variant, segments: nextSegs, sourceSnapshot: undefined };
    this.highlightVariants = nextVariants;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Compute a reasonable (start, end) slot to use for "add new segment"
   * when the caller doesn't have an explicit time in mind. Strategy:
   *   1. Hint: if provided, try placing a 3-second window starting at
   *      the hint (e.g. current video cursor). Accept if it doesn't
   *      overlap.
   *   2. Otherwise, try right after the last segment's end + 0.5s gap.
   *   3. Otherwise, try just before the first segment's start - 3.5s.
   *   4. Otherwise, scan the spaces between existing segments for any
   *      hole ≥ 3s.
   *   5. Give up — return null; UI should tell the user there's no room.
   */
  findHighlightInsertSlot(
    variantId: string,
    hintSec?: number
  ): { start: number; end: number } | null {
    const variant = this.highlightVariants.find((v) => v.id === variantId);
    if (!variant) return null;
    const DEFAULT_LEN = 3.0;
    const GAP = 0.5;
    const maxT = this.videoMeta.duration;

    const sorted = [...variant.segments].sort((a, b) => a.start - b.start);
    const overlaps = (s: number, e: number): boolean =>
      sorted.some((o) => s < o.end && e > o.start);
    const inBounds = (s: number, e: number): boolean =>
      s >= 0 && e <= maxT && e - s >= DEFAULT_LEN;

    // 1. Hint
    if (hintSec !== undefined && Number.isFinite(hintSec)) {
      const s = hintSec;
      const e = hintSec + DEFAULT_LEN;
      if (inBounds(s, e) && !overlaps(s, e)) return { start: s, end: e };
    }
    // 2. After last
    if (sorted.length > 0) {
      const last = sorted[sorted.length - 1];
      const s = last.end + GAP;
      const e = s + DEFAULT_LEN;
      if (inBounds(s, e)) return { start: s, end: e };
    }
    // 3. Before first
    if (sorted.length > 0) {
      const first = sorted[0];
      const e = first.start - GAP;
      const s = e - DEFAULT_LEN;
      if (inBounds(s, e)) return { start: s, end: e };
    }
    // 4. Gaps in between
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i].end + GAP;
      const e = sorted[i + 1].start - GAP;
      if (inBounds(s, s + DEFAULT_LEN) && e - s >= DEFAULT_LEN) {
        return { start: s, end: s + DEFAULT_LEN };
      }
    }
    // 5. Last resort: empty variant + enough room at origin
    if (sorted.length === 0 && maxT >= DEFAULT_LEN) {
      return { start: 0, end: DEFAULT_LEN };
    }
    return null;
  }

  /** Permanently remove a single variant (bypasses pinned protection). */
  deleteHighlightVariant(variantId: string): boolean {
    const before = this.highlightVariants.length;
    this.highlightVariants = this.highlightVariants.filter((v) => v.id !== variantId);
    const changed = this.highlightVariants.length !== before;
    if (changed) this.modifiedAt = new Date().toISOString();
    return changed;
  }

  findHighlightVariant(id: string): HighlightVariant | undefined {
    return this.highlightVariants.find((v) => v.id === id);
  }

  // --- Social copy CRUD -----------------------------------------------------

  addSocialCopySet(set: SocialCopySetData): void {
    this.socialCopies = [set, ...this.socialCopies];
    this.modifiedAt = new Date().toISOString();
  }

  updateSocialCopy(
    setId: string,
    copyId: string,
    patch: { title?: string; body?: string; hashtags?: string[] }
  ): boolean {
    const setIdx = this.socialCopies.findIndex((s) => s.id === setId);
    if (setIdx < 0) return false;
    const oldSet = this.socialCopies[setIdx];
    const copyIdx = oldSet.copies.findIndex((c) => c.id === copyId);
    if (copyIdx < 0) return false;
    const nextCopies = [...oldSet.copies];
    nextCopies[copyIdx] = {
      ...nextCopies[copyIdx],
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.hashtags !== undefined ? { hashtags: [...patch.hashtags] } : {}),
    };
    const nextSocial = [...this.socialCopies];
    nextSocial[setIdx] = { ...oldSet, copies: nextCopies };
    this.socialCopies = nextSocial;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  deleteSocialCopy(setId: string, copyId: string): boolean {
    const setIdx = this.socialCopies.findIndex((s) => s.id === setId);
    if (setIdx < 0) return false;
    const oldSet = this.socialCopies[setIdx];
    const nextCopies = oldSet.copies.filter((c) => c.id !== copyId);
    if (nextCopies.length === oldSet.copies.length) return false;
    const nextSocial = [...this.socialCopies];
    if (nextCopies.length === 0) {
      // If the user deleted the last copy in a set, drop the whole set too —
      // an empty set has no useful meaning to retain.
      nextSocial.splice(setIdx, 1);
    } else {
      nextSocial[setIdx] = { ...oldSet, copies: nextCopies };
    }
    this.socialCopies = nextSocial;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  deleteSocialCopySet(setId: string): boolean {
    const next = this.socialCopies.filter((s) => s.id !== setId);
    if (next.length === this.socialCopies.length) return false;
    this.socialCopies = next;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  setSocialStyleNote(note: string | null): void {
    this.socialStyleNote = note && note.trim() ? note : null;
    this.modifiedAt = new Date().toISOString();
  }

  addSocialStylePreset(name: string, content: string): SocialStylePresetData {
    const preset: SocialStylePresetData = {
      id: `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim() || '未命名',
      content,
      createdAt: new Date().toISOString(),
    };
    this.socialStylePresets = [preset, ...this.socialStylePresets];
    this.modifiedAt = new Date().toISOString();
    return preset;
  }

  updateSocialStylePreset(
    presetId: string,
    patch: { name?: string; content?: string }
  ): boolean {
    const idx = this.socialStylePresets.findIndex((p) => p.id === presetId);
    if (idx < 0) return false;
    const old = this.socialStylePresets[idx];
    const next = [...this.socialStylePresets];
    next[idx] = {
      ...old,
      ...(patch.name !== undefined ? { name: patch.name.trim() || '未命名' } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
    };
    this.socialStylePresets = next;
    this.modifiedAt = new Date().toISOString();
    return true;
  }

  /**
   * Apply a diarization result: labels every transcript segment with a
   * speaker ID and records which engine produced the labels. Does NOT
   * alter segment text or timings — purely additive annotation.
   *
   * Fails gracefully: if there's no transcript, this is a no-op and
   * returns false. Callers should check before trying.
   */
  applyDiarization(result: DiarizationResult): boolean {
    if (!this.transcript) return false;
    this.transcript = applySpeakersToTranscript(this.transcript, result);
    this.diarizationEngine = result.engine;
    // Fill every segment the diarizer's VAD couldn't reach. Without this
    // the user ends up with orphan unlabeled rows after every run because
    // whisper boundaries and sherpa boundaries never line up perfectly.
    // The nearest-labeled-neighbor heuristic matches what the user would
    // manually fix one-by-one, so we just do it for them.
    this.autoAssignUnlabeledSpeakers();
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'diarization.completed', projectId: this.id });
    return true;
  }

  /**
   * Drop every speaker label and the engine marker. Leaves the transcript
   * text otherwise intact — the user can re-diarize from a clean slate.
   */
  clearSpeakers(): void {
    if (this.transcript) {
      this.transcript = clearTranscriptSpeakers(this.transcript);
    }
    this.speakerNames = {};
    this.diarizationEngine = null;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'diarization.cleared', projectId: this.id });
  }

  /** Rename (or clear) the display name for a speaker ID. */
  renameSpeaker(speakerId: string, name: string | null): void {
    if (!name || !name.trim()) {
      const { [speakerId]: _drop, ...rest } = this.speakerNames;
      this.speakerNames = rest;
    } else {
      this.speakerNames = { ...this.speakerNames, [speakerId]: name.trim() };
    }
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({
      type: 'diarization.renamed',
      projectId: this.id,
      speakerId,
    });
  }

  /**
   * Merge all transcript segments labelled `from` into speaker `to`. Used
   * when diarization over-splits the same speaker into multiple IDs.
   * Also drops `from` from speakerNames — nobody references it anymore.
   */
  mergeSpeakers(from: string, to: string): number {
    if (!this.transcript || from === to) return 0;
    let changed = 0;
    const nextSegs = this.transcript.segments.map((s) => {
      if (s.speaker === from) {
        changed += 1;
        return { ...s, speaker: to };
      }
      return s;
    });
    if (changed === 0) return 0;
    this.transcript = { ...this.transcript, segments: nextSegs };
    const { [from]: _drop, ...rest } = this.speakerNames;
    this.speakerNames = rest;
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({ type: 'diarization.renamed', projectId: this.id, speakerId: from });
    return changed;
  }

  /**
   * Retag a single transcript segment's speaker without touching any
   * other segment. Used when diarization mislabels ONE line (the AI
   * heard the wrong person) and the user wants to fix just that line.
   * Pass null to clear the speaker field entirely.
   */
  setSegmentSpeaker(transcriptSegmentId: string, speaker: string | null): boolean {
    if (!this.transcript) return false;
    let found = false;
    const nextSegs = this.transcript.segments.map((s) => {
      if (s.id !== transcriptSegmentId) return s;
      found = true;
      if (!speaker) {
        const { speaker: _drop, ...rest } = s;
        return rest;
      }
      return { ...s, speaker };
    });
    if (!found) return false;
    this.transcript = { ...this.transcript, segments: nextSegs };
    this.modifiedAt = new Date().toISOString();
    this.eventBus.emit({
      type: 'transcript.updated',
      projectId: this.id,
      segmentId: transcriptSegmentId,
    });
    return true;
  }

  deleteSocialStylePreset(presetId: string): boolean {
    const next = this.socialStylePresets.filter((p) => p.id !== presetId);
    if (next.length === this.socialStylePresets.length) return false;
    this.socialStylePresets = next;
    this.modifiedAt = new Date().toISOString();
    return true;
  }
}

export class ProjectManager {
  private projects = new Map<string, Project>();

  constructor(private readonly eventBus: EventBus) {}

  /**
   * Open a project from a video path. If projectPath is provided and file exists, load it.
   * Otherwise create a new project with the given videoMeta.
   */
  async openProject(params: {
    videoPath: string;
    videoMeta: VideoMeta;
    projectPath?: string;
  }): Promise<Project> {
    const { videoPath, videoMeta, projectPath } = params;
    let project: Project;

    if (projectPath && (await exists(projectPath))) {
      const raw = await fs.readFile(projectPath, 'utf-8');
      const data = JSON.parse(raw) as QcpProject;
      project = new Project(
        { projectId: uuid(), projectPath, data },
        this.eventBus
      );
    } else {
      const now = new Date().toISOString();
      const data: QcpProject = {
        version: '2.0',
        videoPath,
        videoMeta,
        transcript: null,
        deleteSegments: [],
        aiMode: 'L2',
        cutRanges: [],
        createdAt: now,
        modifiedAt: now,
      };
      project = new Project(
        { projectId: uuid(), projectPath: projectPath ?? null, data },
        this.eventBus
      );
    }

    this.projects.set(project.id, project);
    this.eventBus.emit({
      type: 'project.opened',
      projectId: project.id,
      meta: project.videoMeta,
    });
    return project;
  }

  get(projectId: string): Project {
    const p = this.projects.get(projectId);
    if (!p) throw new Error(`Project not found: ${projectId}`);
    return p;
  }

  has(projectId: string): boolean {
    return this.projects.has(projectId);
  }

  async saveProject(projectId: string, outputPath?: string): Promise<string> {
    const project = this.get(projectId);
    const target = outputPath ?? project.projectPath;
    if (!target) {
      throw new Error('No project path set; provide outputPath');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const qcp = project.toQcp();
    await fs.writeFile(target, JSON.stringify(qcp, null, 2), 'utf-8');
    project.projectPath = target;
    project.modifiedAt = qcp.modifiedAt;
    this.eventBus.emit({ type: 'project.saved', projectId, path: target });
    return target;
  }

  /**
   * Re-read a project's .qcp file from disk and replace its in-memory state.
   * No-op if no projectPath is set.
   */
  async reloadFromDisk(projectId: string): Promise<void> {
    const project = this.get(projectId);
    if (!project.projectPath) return;
    const raw = await fs.readFile(project.projectPath, 'utf-8');
    const data = JSON.parse(raw) as QcpProject;
    project.reloadFrom(data);
  }

  closeProject(projectId: string): void {
    if (!this.projects.has(projectId)) return;
    this.projects.delete(projectId);
    this.eventBus.emit({ type: 'project.closed', projectId });
  }

  listProjectIds(): string[] {
    return [...this.projects.keys()];
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Clamp a persisted rotation value to the 4 legal options. */
function normalizeRotation(v: unknown): 0 | 90 | 180 | 270 {
  if (v === 90 || v === 180 || v === 270) return v;
  return 0;
}
