import type { EventType, LynLensEvent } from './types';

type Handler<T extends EventType> = (event: Extract<LynLensEvent, { type: T }>) => void;
type AnyHandler = (event: LynLensEvent) => void;

export class EventBus {
  private byType = new Map<EventType, Set<AnyHandler>>();
  private wildcard = new Set<AnyHandler>();

  on<T extends EventType>(type: T, handler: Handler<T>): () => void {
    const set = this.byType.get(type) ?? new Set();
    const wrapped = handler as unknown as AnyHandler;
    set.add(wrapped);
    this.byType.set(type, set);
    return () => set.delete(wrapped);
  }

  onAny(handler: AnyHandler): () => void {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  emit(event: LynLensEvent): void {
    const set = this.byType.get(event.type);
    if (set) {
      for (const h of set) {
        try {
          h(event);
        } catch (err) {
           
          console.error(`[EventBus] handler for "${event.type}" threw:`, err);
        }
      }
    }
    for (const h of this.wildcard) {
      try {
        h(event);
      } catch (err) {
         
        console.error('[EventBus] wildcard handler threw:', err);
      }
    }
  }

  clear(): void {
    this.byType.clear();
    this.wildcard.clear();
  }
}
