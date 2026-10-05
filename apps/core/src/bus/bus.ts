import {
  EventPayloads,
  type AnyBusEvent,
  type EventPayload,
  type EventType,
} from '@cantina/shared';
import type { Clock } from '../util/time.ts';
import { systemClock } from '../util/time.ts';

type Handler<T extends EventType> = (payload: EventPayload<T>, ts: number) => void;
type AnyHandler = (event: AnyBusEvent) => void;

/**
 * Typed in-process event bus (SPEC §4.2). Payloads are validated against the shared zod schemas
 * so a malformed event fails loudly at its source rather than in the dashboard.
 */
export class EventBus {
  private handlers = new Map<EventType, Set<Handler<EventType>>>();
  private anyHandlers = new Set<AnyHandler>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly validate = true,
  ) {}

  emit<T extends EventType>(type: T, payload: EventPayload<T>): void {
    const data = this.validate ? (EventPayloads[type].parse(payload) as EventPayload<T>) : payload;
    const ts = this.clock.now();
    const set = this.handlers.get(type);
    if (set) {
      for (const h of [...set]) this.safe(() => (h as Handler<T>)(data, ts));
    }
    if (this.anyHandlers.size) {
      const ev = { type, ts, payload: data } as AnyBusEvent;
      for (const h of [...this.anyHandlers]) this.safe(() => h(ev));
    }
  }

  on<T extends EventType>(type: T, handler: Handler<T>): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as Handler<EventType>);
    return () => set.delete(handler as Handler<EventType>);
  }

  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      // A faulty subscriber must never take down the emitter (e.g. the mixer clock).
      console.error('[bus] handler error', err);
    }
  }
}
