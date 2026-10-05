import { FRAME_MS } from './dsp.ts';

export interface OutputSink {
  readonly name: string;
  write(frame: Float32Array): void;
  close(): void;
}

/**
 * Steady 20 ms mixer clock with drift correction (SPEC §6.1). Renders frames on schedule and fans
 * them out to every sink. After a stall (e.g. the Mac waking), it renders at most a few catch-up
 * frames rather than bursting.
 */
export class MixClock {
  private timer: NodeJS.Timeout | null = null;
  private t0 = 0;
  private n = 0;
  private sinks = new Set<OutputSink>();
  late = 0;
  onTick: (() => void) | null = null;

  constructor(
    private readonly render: () => Float32Array,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  addSink(sink: OutputSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  removeSink(sink: OutputSink): void {
    this.sinks.delete(sink);
  }

  start(): void {
    if (this.timer) return;
    this.t0 = this.now();
    this.n = 0;
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Render frames due by `now`. Exposed for tests. */
  tick(): number {
    const due = Math.floor((this.now() - this.t0) / FRAME_MS) + 1;
    let behind = due - this.n;
    if (behind > 5) {
      // Skip ahead: we were stalled; don't burst seconds of audio.
      this.late += behind - 5;
      this.n = due - 5;
      behind = 5;
    }
    for (let i = 0; i < behind; i++) {
      const frame = this.render();
      for (const s of this.sinks) {
        try {
          s.write(frame);
        } catch (err) {
          console.error(`[mixer] sink ${s.name} failed`, err);
        }
      }
      this.n++;
    }
    this.onTick?.();
    return behind;
  }

  private schedule(): void {
    const next = this.t0 + this.n * FRAME_MS;
    const delay = Math.max(0, next - this.now());
    this.timer = setTimeout(() => {
      if (!this.timer) return;
      this.tick();
      this.schedule();
    }, delay);
  }
}
