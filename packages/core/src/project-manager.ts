import { promises as fs } from 'node:fs';
import path from 'node:path';
import { v4 as uuid } from 'uuid';
import { EventBus } from './event-bus';
import { SegmentManager } from './segment-manager';
import {
  addCutRange,
  getEffectiveDuration,
  normalizeCuts,
} from './ripple';
import type { AiMode, ProjectHandle, QcpProject, Range, Transcript, VideoMeta } from './types';

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
  /**
   * Committed ripple cuts (source-time ranges). Normalised: sorted, merged,
   * non-overlapping. Never mutate in place — reassign to keep state transitions
   * explicit.
   */
  cutRanges: Range[];
  createdAt: string;
  modifiedAt: string;
  projectPath: string | null;

  constructor(handle: ProjectHandle, eventBus: EventBus) {
    this.id = handle.projectId;
    this.projectPath = handle.projectPath;
    this.videoPath = handle.data.videoPath;
    this.videoMeta = handle.data.videoMeta;
    this.transcript = handle.data.transcript;
    this.aiMode = handle.data.aiMode;
    this.userOrientation = handle.data.userOrientation ?? null;
    this.cutRanges = normalizeCuts(
      handle.data.cutRanges ?? [],
      handle.data.videoMeta.duration
    );
    this.createdAt = handle.data.createdAt;
    this.modifiedAt = handle.data.modifiedAt;
    this.eventBus = eventBus;
    this.segments = new SegmentManager(this.id, eventBus, handle.data.deleteSegments);
  }

  /**
   * Replace this project's in-memory state with fresh data loaded from disk.
   * Used by the desktop UI when MCP/CLI has written changes externally.
   */
  reloadFrom(data: QcpProject): void {
    this.transcript = data.transcript;
    this.aiMode = data.aiMode;
    this.userOrientation = data.userOrientation ?? null;
    this.cutRanges = normalizeCuts(data.cutRanges ?? [], this.videoMeta.duration);
    this.modifiedAt = data.modifiedAt;
    this.segments = new SegmentManager(this.id, this.eventBus, data.deleteSegments);
    this.eventBus.emit({
      type: 'project.reloaded',
      projectId: this.id,
      segmentCount: data.deleteSegments.length,
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
      deleteSegments: this.segments.list(),
      aiMode: this.aiMode,
      userOrientation: this.userOrientation,
      cutRanges: this.cutRanges,
      createdAt: this.createdAt,
      modifiedAt: new Date().toISOString(),
    };
  }

  /**
   * Commit ripple: take every approved delete segment, append it to cutRanges
   * (merging with any existing cuts), and remove those segments from the
   * segment list. Pending and rejected segments are untouched.
   *
   * Returns a summary that the UI / caller can show: the merged cut range
   * that was appended, total cut seconds, and the new effective duration.
   *
   * The approved segments are removed via `segments.remove()` which records
   * each removal in the SegmentManager's undo stack — undoing that stack
   * restores them, but the cutRange itself is NOT on that stack. Use
   * `revertRipple` to remove a cut range explicitly.
   */
  commitRipple(): {
    addedCutRange: Range | null;
    totalCutSeconds: number;
    effectiveDuration: number;
    cutSegmentIds: string[];
  } {
    const approved = this.segments.getApprovedSegments();
    if (approved.length === 0) {
      return {
        addedCutRange: null,
        totalCutSeconds: 0,
        effectiveDuration: getEffectiveDuration(this.videoMeta.duration, this.cutRanges),
        cutSegmentIds: [],
      };
    }

    // Each approved segment becomes a new cut. They may overlap / touch
    // neighbours, so we merge via normalizeCuts. We record the union as ONE
    // merged range for the event payload — that's the visible "this is what
    // got removed this round" boundary on the compacted timeline.
    const newCuts: Range[] = approved.map((s) => ({ start: s.start, end: s.end }));
    const mergedBefore = this.cutRanges;
    const mergedAfter = normalizeCuts(
      [...mergedBefore, ...newCuts],
      this.videoMeta.duration
    );

    const cutSegmentIds = approved.map((s) => s.id);
    for (const id of cutSegmentIds) this.segments.remove(id);

    this.cutRanges = mergedAfter;
    this.modifiedAt = new Date().toISOString();

    const totalCutSeconds = mergedAfter.reduce((sum, c) => sum + (c.end - c.start), 0);
    const effectiveDuration = getEffectiveDuration(this.videoMeta.duration, mergedAfter);

    // For the event payload we surface the BOUNDING range of what was added
    // this round — the caller can use it to animate / highlight the collapse.
    const addedCutRange: Range = {
      start: Math.min(...newCuts.map((c) => c.start)),
      end: Math.max(...newCuts.map((c) => c.end)),
    };
    this.eventBus.emit({
      type: 'ripple.committed',
      projectId: this.id,
      addedCutRange,
      totalCutSeconds,
      effectiveDuration,
    });

    return { addedCutRange, totalCutSeconds, effectiveDuration, cutSegmentIds };
  }

  /**
   * Remove a previously-committed cut range by its source-time start/end.
   * The previously-cut source time is restored to the effective timeline.
   * Returns true if a matching cut was found and removed.
   */
  revertRipple(cutStart: number, cutEnd: number): boolean {
    const before = this.cutRanges;
    const next = before.filter(
      (c) => !(Math.abs(c.start - cutStart) < 1e-6 && Math.abs(c.end - cutEnd) < 1e-6)
    );
    if (next.length === before.length) return false;
    this.cutRanges = next;
    this.modifiedAt = new Date().toISOString();
    const effectiveDuration = getEffectiveDuration(this.videoMeta.duration, next);
    this.eventBus.emit({
      type: 'ripple.reverted',
      projectId: this.id,
      removedCutRange: { start: cutStart, end: cutEnd },
      effectiveDuration,
    });
    return true;
  }

  /** Convenience for callers that need to reason about the compacted timeline. */
  getEffectiveDuration(): number {
    return getEffectiveDuration(this.videoMeta.duration, this.cutRanges);
  }

  /** Add a cut without needing any approved segments — used by MCP tools / CLI. */
  addCut(cut: Range): Range[] {
    if (cut.end <= cut.start) return this.cutRanges;
    this.cutRanges = addCutRange(this.cutRanges, cut);
    this.modifiedAt = new Date().toISOString();
    return this.cutRanges;
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
