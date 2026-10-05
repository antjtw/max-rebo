export type Rng = () => number;

/** Deterministic PRNG (mulberry32) for tests and reproducible selection. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function weightedPick<T>(
  items: readonly T[],
  weights: readonly number[],
  rng: Rng,
): T | undefined {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (items.length === 0 || total <= 0) return undefined;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, weights[i] ?? 0);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function shortId(prefix = ''): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}
