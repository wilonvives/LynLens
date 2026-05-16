import type { EventBus } from './event-bus';
import { minimalDiff, type LearningMemory } from './learning-memory';
import type { LynLensEvent } from './types';

/**
 * Wires engine events into LearningMemory updates. One instance per app
 * lifetime, created at boot, never destroyed.
 *
 * The intent is to keep this layer SLIM: each event handler does the minimal
 * translation from "engine fired event" to "memory.record*(...)". All
 * promotion logic, threshold handling, and persistence lives in
 * LearningMemory — this class just routes.
 *
 * Why route through engine events instead of intercepting at the UI / MCP
 * layer? Because then UI clicks and MCP calls go through the SAME learning
 * pipeline. The user gets a learning system regardless of how they drive
 * LynLens. See `docs/PLAN-learning-memory.md` §1.1.
 */
export class LearningService {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly memory: LearningMemory,
    private readonly eventBus: EventBus
  ) {}

  /** Begin listening to engine events. Idempotent. */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.eventBus.onAny((event) => {
      // Fire-and-forget — handler errors should not propagate to other
      // subscribers (event bus already wraps each handler in try/catch).
      void this.handle(event).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[learning-service] handler failed:', err);
      });
    });
  }

  /** Stop listening. Useful for tests / shutdown. */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  private async handle(event: LynLensEvent): Promise<void> {
    switch (event.type) {
      case 'transcript.segment.text-changed': {
        // The fine-grained edit event carries before/after text. We extract
        // the MINIMAL diff before recording — so editing "昨天我去参你一个讲座"
        // → "昨天我去参与一个讲座" stores `参你 → 参与` (which fires on any
        // future sentence containing "参你"), not the whole sentence (which
        // would only ever match this exact sentence). See learning-memory.ts
        // → minimalDiff() for the exact algorithm.
        const e = event as Extract<LynLensEvent, { type: 'transcript.segment.text-changed' }>;
        if (e.oldText && e.newText && e.oldText !== e.newText) {
          const { from, to } = minimalDiff(e.oldText, e.newText);
          if (from && to && from !== to) {
            await this.memory.recordCorrection(from, to, { projectId: e.projectId });
          }
        }
        return;
      }
      case 'transcript.find-replace': {
        // The find/replace tool fires this once per call. We treat it as a
        // high-confidence direct mapping and promote it immediately (the user
        // explicitly typed "always replace X with Y", which is stronger
        // signal than a one-off segment edit).
        const e = event as Extract<LynLensEvent, { type: 'transcript.find-replace' }>;
        if (e.find && e.replace && e.find !== e.replace && e.replacedCount > 0) {
          await this.memory.addAutoCorrection(e.find, e.replace);
        }
        return;
      }
      // -------------------------------------------------------------------
      // M3+ slots — not implemented yet:
      //   case 'segment.added': // user marked a delete = possible filler
      //   case 'highlight.pinned': // user liked this variant's style
      //   case 'social-copy.updated': // user edited AI-written copy
      // -------------------------------------------------------------------
      default:
        return;
    }
  }
}
