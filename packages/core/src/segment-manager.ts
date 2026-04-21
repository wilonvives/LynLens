import { v4 as uuid } from 'uuid';
import type { EventBus } from './event-bus';
import type { Range, Segment, SegmentStatus } from './types';

const MAX_HISTORY = 200;

type AddInput = Pick<Segment, 'start' | 'end' | 'source'> &
  Partial<Pick<Segment, 'reason' | 'confidence' | 'aiModel' | 'status'>>;

type Action =
  | { kind: 'add'; segment: Segment; mergedIds: string[]; displaced: Segment[] }
  | { kind: 'remove'; segment: Segment }
  | { kind: 'resize'; id: string; before: Segment; after: Segment }
  | { kind: 'status'; id: string; before: SegmentStatus; after: SegmentStatus; reviewer: string | null };

export class SegmentManager {
  private segments: Segment[] = [];
  private undoStack: Action[] = [];
  private redoStack: Action[] = [];

  constructor(
    private readonly projectId: string,
    private readonly eventBus: EventBus,
    initial: Segment[] = []
  ) {
    this.segments = [...initial].sort((a, b) => a.start - b.start);
  }

  list(): Segment[] {
    return [...this.segments];
  }

  find(id: string): Segment | undefined {
    return this.segments.find((s) => s.id === id);
  }

  add(input: AddInput): Segment {
    if (input.end <= input.start) {
      throw new Error(`Invalid segment: end (${input.end}) must be > start (${input.start})`);
    }
    const now = new Date().toISOString();
    const fresh: Segment = {
      id: uuid(),
      start: input.start,
      end: input.end,
      source: input.source,
      reason: input.reason ?? null,
      confidence: input.confidence,
      aiModel: input.aiModel,
      status: input.status ?? (input.source === 'ai' ? 'pending' : 'approved'),
      createdAt: now,
      reviewedBy: null,
      reviewedAt: null,
    };

    const { merged, displaced } = this.mergeOverlapping(fresh);
    this.segments = this.segments.filter((s) => !displaced.includes(s));
    this.segments.push(merged);
    this.segments.sort((a, b) => a.start - b.start);

    this.undoStack.push({
      kind: 'add',
      segment: merged,
      mergedIds: displaced.map((d) => d.id),
      displaced,
    });
    this.redoStack = [];
    this.trimHistory();

    this.eventBus.emit({ type: 'segment.added', projectId: this.projectId, segment: merged });
    if (displaced.length > 0) {
      this.eventBus.emit({
        type: 'segment.merged',
        projectId: this.projectId,
        mergedIds: displaced.map((d) => d.id),
        resultSegment: merged,
      });
    }
    return merged;
  }

  /**
   * Erase all segment coverage in [start, end]. A segment entirely inside the
   * range is removed; one that contains the range is split into two; one that
   * straddles an edge is shrunk. Rejected segments are ignored.
   */
  eraseRange(start: number, end: number): void {
    if (end <= start) return;
    const current = [...this.segments];
    for (const s of current) {
      if (s.status === 'rejected') continue;
      if (s.end <= start || s.start >= end) continue; // no overlap
      if (s.start >= start && s.end <= end) {
        this.remove(s.id);
      } else if (s.start < start && s.end > end) {
        // Split: shrink original to [s.start, start], add new [end, s.end]
        this.resize(s.id, s.start, start);
        this.add({
          start: end,
          end: s.end,
          source: s.source,
          reason: s.reason,
          confidence: s.confidence,
          aiModel: s.aiModel,
          status: s.status,
        });
      } else if (s.start < start) {
        this.resize(s.id, s.start, start);
      } else {
        this.resize(s.id, end, s.end);
      }
    }
  }

  remove(id: string): void {
    const seg = this.find(id);
    if (!seg) return;
    this.segments = this.segments.filter((s) => s.id !== id);
    this.undoStack.push({ kind: 'remove', segment: seg });
    this.redoStack = [];
    this.trimHistory();
    this.eventBus.emit({ type: 'segment.removed', projectId: this.projectId, segmentId: id });
  }

  resize(id: string, newStart: number, newEnd: number): Segment {
    if (newEnd <= newStart) {
      throw new Error(`Invalid resize: end (${newEnd}) must be > start (${newStart})`);
    }
    const seg = this.find(id);
    if (!seg) throw new Error(`Segment not found: ${id}`);
    const before = { ...seg };
    seg.start = newStart;
    seg.end = newEnd;
    this.segments.sort((a, b) => a.start - b.start);
    const after = { ...seg };
    this.undoStack.push({ kind: 'resize', id, before, after });
    this.redoStack = [];
    this.trimHistory();
    this.eventBus.emit({ type: 'segment.resized', projectId: this.projectId, segment: after });
    return after;
  }

  approve(id: string, reviewer: string | null = 'human'): void {
    this.setStatus(id, 'approved', reviewer);
    this.eventBus.emit({ type: 'segment.approved', projectId: this.projectId, segmentId: id });
  }

  reject(id: string, reviewer: string | null = 'human'): void {
    this.setStatus(id, 'rejected', reviewer);
    this.eventBus.emit({ type: 'segment.rejected', projectId: this.projectId, segmentId: id });
  }

  private setStatus(id: string, status: SegmentStatus, reviewer: string | null): void {
    const seg = this.find(id);
    if (!seg) throw new Error(`Segment not found: ${id}`);
    const before = seg.status;
    seg.status = status;
    seg.reviewedBy = reviewer;
    seg.reviewedAt = new Date().toISOString();
    this.undoStack.push({ kind: 'status', id, before, after: status, reviewer });
    this.redoStack = [];
    this.trimHistory();
  }

  undo(): boolean {
    const action = this.undoStack.pop();
    if (!action) return false;
    switch (action.kind) {
      case 'add':
        this.segments = this.segments.filter((s) => s.id !== action.segment.id);
        this.segments.push(...action.displaced);
        this.segments.sort((a, b) => a.start - b.start);
        this.eventBus.emit({
          type: 'segment.removed',
          projectId: this.projectId,
          segmentId: action.segment.id,
        });
        break;
      case 'remove':
        this.segments.push(action.segment);
        this.segments.sort((a, b) => a.start - b.start);
        this.eventBus.emit({
          type: 'segment.added',
          projectId: this.projectId,
          segment: action.segment,
        });
        break;
      case 'resize': {
        const seg = this.find(action.id);
        if (seg) {
          seg.start = action.before.start;
          seg.end = action.before.end;
          this.segments.sort((a, b) => a.start - b.start);
          this.eventBus.emit({ type: 'segment.resized', projectId: this.projectId, segment: { ...seg } });
        }
        break;
      }
      case 'status': {
        const seg = this.find(action.id);
        if (seg) {
          seg.status = action.before;
        }
        break;
      }
    }
    this.redoStack.push(action);
    return true;
  }

  redo(): boolean {
    const action = this.redoStack.pop();
    if (!action) return false;
    switch (action.kind) {
      case 'add':
        this.segments = this.segments.filter((s) => !action.displaced.some((d) => d.id === s.id));
        this.segments.push(action.segment);
        this.segments.sort((a, b) => a.start - b.start);
        this.eventBus.emit({
          type: 'segment.added',
          projectId: this.projectId,
          segment: action.segment,
        });
        break;
      case 'remove':
        this.segments = this.segments.filter((s) => s.id !== action.segment.id);
        this.eventBus.emit({
          type: 'segment.removed',
          projectId: this.projectId,
          segmentId: action.segment.id,
        });
        break;
      case 'resize': {
        const seg = this.find(action.id);
        if (seg) {
          seg.start = action.after.start;
          seg.end = action.after.end;
          this.segments.sort((a, b) => a.start - b.start);
          this.eventBus.emit({ type: 'segment.resized', projectId: this.projectId, segment: { ...seg } });
        }
        break;
      }
      case 'status': {
        const seg = this.find(action.id);
        if (seg) seg.status = action.after;
        break;
      }
    }
    this.undoStack.push(action);
    return true;
  }

  getApprovedSegments(): Segment[] {
    return this.segments.filter((s) => s.status === 'approved').sort((a, b) => a.start - b.start);
  }

  /**
   * Compute the intervals to KEEP when exporting, given the total duration.
   * Only approved delete-segments are considered.
   */
  getKeepSegments(totalDuration: number): Range[] {
    const deletes = this.getApprovedSegments();
    const keeps: Range[] = [];
    let cursor = 0;
    for (const seg of deletes) {
      const clampedStart = Math.max(0, seg.start);
      const clampedEnd = Math.min(totalDuration, seg.end);
      if (cursor < clampedStart) keeps.push({ start: cursor, end: clampedStart });
      cursor = Math.max(cursor, clampedEnd);
    }
    if (cursor < totalDuration) keeps.push({ start: cursor, end: totalDuration });
    return keeps;
  }

  /**
   * Merge a new segment with any overlapping existing segments.
   * Keeps the stronger status: approved > pending > rejected.
   * source becomes 'human' if any overlapping is human, else 'ai'.
   */
  private mergeOverlapping(newSeg: Segment): { merged: Segment; displaced: Segment[] } {
    const overlapping = this.segments.filter(
      (s) => !(s.end < newSeg.start || s.start > newSeg.end)
    );
    if (overlapping.length === 0) {
      return { merged: newSeg, displaced: [] };
    }
    const statusRank: Record<SegmentStatus, number> = { approved: 3, pending: 2, rejected: 1 };
    const all = [newSeg, ...overlapping];
    const best = all.reduce((a, b) => (statusRank[b.status] > statusRank[a.status] ? b : a));
    const merged: Segment = {
      ...newSeg,
      start: Math.min(...all.map((s) => s.start)),
      end: Math.max(...all.map((s) => s.end)),
      source: all.some((s) => s.source === 'human') ? 'human' : 'ai',
      status: best.status,
      reason: best.reason ?? newSeg.reason,
      confidence: 'confidence' in best ? best.confidence : newSeg.confidence,
    };
    return { merged, displaced: overlapping };
  }

  private trimHistory(): void {
    while (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
  }

  getTotalDeletedDuration(): number {
    return this.getApprovedSegments().reduce((sum, s) => sum + (s.end - s.start), 0);
  }
}
