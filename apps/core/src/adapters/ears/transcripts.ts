/**
 * Rolling in-memory transcript buffer (SPEC §7.4): default 5 minutes, configurable down to 0
 * ("process and drop"). Never persisted, never logged, only sent to the local dashboard.
 */
export interface TranscriptLine {
  utteranceId: string;
  userId: string;
  text: string;
  final: boolean;
  ts: number;
}

export class TranscriptBuffer {
  private lines: TranscriptLine[] = [];

  constructor(
    private retentionMinutes: number,
    private readonly now: () => number = Date.now,
  ) {}

  setRetention(minutes: number): void {
    this.retentionMinutes = minutes;
    this.prune();
  }

  add(line: Omit<TranscriptLine, 'ts'>): void {
    if (this.retentionMinutes <= 0) return;
    const existing = this.lines.findIndex((l) => l.utteranceId === line.utteranceId);
    const entry = { ...line, ts: this.now() };
    if (existing >= 0) {
      // A final replaces its partials; a late partial never overwrites a final.
      if (this.lines[existing]!.final && !line.final) return;
      this.lines[existing] = entry;
    } else this.lines.push(entry);
    this.prune();
  }

  list(): TranscriptLine[] {
    this.prune();
    return [...this.lines];
  }

  clear(): void {
    this.lines = [];
  }

  private prune(): void {
    const cutoff = this.now() - this.retentionMinutes * 60_000;
    if (this.retentionMinutes <= 0) this.lines = [];
    else this.lines = this.lines.filter((l) => l.ts >= cutoff).slice(-500);
  }
}
