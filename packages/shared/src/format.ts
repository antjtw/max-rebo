/** Formatting helpers shared by core and dashboard. */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** UI gain 0–100 → dB. 0 is silence; 100 is 0 dB; roughly −6 dB at 70. */
export function gainToDb(gain: number): number {
  if (gain <= 0) return -Infinity;
  const g = Math.min(100, gain) / 100;
  return 40 * Math.log10(g);
}

export function dbToLinear(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.pow(10, db / 20);
}

export function linearToDb(lin: number): number {
  return lin <= 0 ? -Infinity : 20 * Math.log10(lin);
}

/** UI gain 0–100 → linear amplitude. */
export function gainToLinear(gain: number): number {
  return dbToLinear(gainToDb(gain));
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
