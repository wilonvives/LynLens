import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { EventBus } from './event-bus';
import { SegmentManager } from './segment-manager';
import { getEffectiveDuration } from './ripple';
import type { HighlightVariant } from './highlight-parser';
import type { AiMode, ProjectHandle, QcpProject, Range, Segment, Transcript, VideoMeta } from './types';

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
  createdAt: string;
  modifiedAt: string;
  projectPath: string | null;
  /**
   * Highlight variants produced by Claude in the current session. Intentionally
   * ephemeral: never written to the .qcp file. The highlight tab shows them;
   * switching back to the precision (粗剪) tab clears them. Re-opening a
   * project does NOT restore previous variants — the user re-generates.
   *
   * Rationale: variants reference source-time ranges, and source times are
   * only meaningful relative to the CURRENT cutRanges. If the user edits the
   * ripple after generating variants, those variants become misaligned. Making
   * them ephemeral sidesteps that class of bug entirely.
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

  /** Replace the in-memory highlight variants with a fresh batch. */
  setHighlightVariants(variants: HighlightVariant[]): void {
    this.highlightVariants = [...variants];
  }

  /** Drop all highlight variants — called when the user switches back to 粗剪. */
  clearHighlightVariants(): void {
    this.highlightVariants = [];
  }

  findHighlightVariant(id: string): HighlightVariant | undefined {
    return this.highlightVariants.find((v) => v.id === id);
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
