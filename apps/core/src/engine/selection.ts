import type { TrackQuery } from '@cantina/shared';
import type { Candidate } from '../library/repo.ts';
import { weightedPick, type Rng } from '../util/random.ts';

/**
 * Track selection (SPEC §10.4): filter by tags, score by confidence × feedback × rating × recency,
 * weighted random pick, relaxing intensity then moods when nothing matches.
 */

export interface SelectionContext {
  sceneId: string;
  /** Intensity shift from game tension (Despair), 0–2. */
  tensionStep: number;
  /** trackId → last played (ms). */
  lastPlayed: Map<string, number>;
  /** Most recent first; never repeat these. */
  previous: string[];
  noRepeatCount: number;
  recencyMinutes: number;
  allowLyrics: boolean;
  now: number;
  rng: Rng;
}

export interface Pick {
  candidate: Candidate;
  score: number;
  relaxed: ('intensity' | 'moods' | 'repeat')[];
}

const FACETS = ['scenes', 'moods', 'settings', 'factions'] as const;

function tagConfidence(c: Candidate, facet: string, wanted: string[]): number | null {
  const tags = c.tags.get(facet);
  if (!tags) return null;
  let best: number | null = null;
  for (const w of wanted) {
    const t = tags.get(w.toLowerCase());
    if (t) {
      const conf = t.status === 'confirmed' ? 1 : t.confidence;
      best = best == null ? conf : Math.max(best, conf);
    }
  }
  return best;
}

export function shiftedRange(
  range: [number, number] | undefined,
  step: number,
): [number, number] | null {
  if (!range) return null;
  const s = Math.max(0, Math.round(step));
  return [Math.min(5, range[0] + s), Math.min(5, range[1] + s)];
}

export function matches(
  c: Candidate,
  q: TrackQuery,
  opts: {
    ignoreIntensity?: boolean;
    ignoreMoods?: boolean;
    allowLyrics: boolean;
    tensionStep: number;
  },
): number | null {
  const explicit = !!q.tracks?.length;
  const vocals = c.track.vocals ?? 'none';
  if (vocals === 'lyrics' && !opts.allowLyrics && !explicit) return null;
  if (q.vocals?.length && !q.vocals.includes(vocals) && !explicit) return null;
  if (explicit) return 1;
  const confs: number[] = [];
  for (const facet of FACETS) {
    const wanted = q[facet];
    if (!wanted?.length) continue;
    if (facet === 'moods' && opts.ignoreMoods) continue;
    const conf = tagConfidence(c, facet, wanted);
    if (conf == null) return null;
    confs.push(conf);
  }
  let factor = 1;
  if (!opts.ignoreIntensity) {
    const r = shiftedRange(q.intensity, opts.tensionStep);
    if (r) {
      const i = c.track.intensity;
      if (i == null)
        factor = 0.6; // unknown intensity: allowed, but less likely
      else if (i < r[0] || i > r[1]) return null;
    }
  }
  const base = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0.5;
  return base * factor;
}

export function scoreCandidate(c: Candidate, conf: number, ctx: SelectionContext): number {
  const weight = c.sceneWeights.get(ctx.sceneId) ?? 0;
  const r = c.track.rating;
  const ratingFactor = r == null ? 1 : r < 0 ? 0.1 : 1 + (r - 3) * 0.15;
  let recency = 1;
  const last = ctx.lastPlayed.get(c.track.id) ?? c.track.last_played_at ?? null;
  if (last != null) {
    const ageMin = (ctx.now - last) / 60_000;
    if (ageMin < ctx.recencyMinutes) recency = 0.02 + 0.3 * (ageMin / ctx.recencyMinutes);
  }
  return Math.max(0, conf * (1 + weight) * ratingFactor * recency);
}

/** Pick a track for a query, or null if nothing fits even after relaxing. */
export function selectTrack(
  candidates: Candidate[],
  q: TrackQuery,
  ctx: SelectionContext,
): Pick | null {
  const recent = new Set(ctx.previous.slice(0, ctx.noRepeatCount));
  const attempts: { ignoreIntensity: boolean; ignoreMoods: boolean; relaxed: Pick['relaxed'] }[] = [
    { ignoreIntensity: false, ignoreMoods: false, relaxed: [] },
    { ignoreIntensity: true, ignoreMoods: false, relaxed: ['intensity'] },
    { ignoreIntensity: true, ignoreMoods: true, relaxed: ['intensity', 'moods'] },
  ];
  for (const allowRepeat of [false, true]) {
    for (const a of attempts) {
      const pool: { c: Candidate; score: number }[] = [];
      for (const c of candidates) {
        if (c.track.missing || c.track.bad) continue;
        if (!allowRepeat && recent.has(c.track.id)) continue;
        const conf = matches(c, q, {
          ...a,
          allowLyrics: ctx.allowLyrics,
          tensionStep: ctx.tensionStep,
        });
        if (conf == null) continue;
        pool.push({ c, score: scoreCandidate(c, conf, ctx) });
      }
      const picked = weightedPick(
        pool,
        pool.map((p) => p.score),
        ctx.rng,
      );
      if (picked) {
        return {
          candidate: picked.c,
          score: picked.score,
          relaxed: allowRepeat ? [...a.relaxed, 'repeat'] : a.relaxed,
        };
      }
    }
    // Only allow a repeat when the pool is genuinely tiny (an explicit list or a sparse library).
  }
  return null;
}

export function describeGap(sceneId: string, q: TrackQuery, confirmedCount: number): string {
  const i = q.intensity ? ` at intensity ${q.intensity[0]}–${q.intensity[1]}` : '';
  const what = q.scenes?.join('/') ?? sceneId;
  return confirmedCount === 0
    ? `No ${what} tracks${i}`
    : `Only ${confirmedCount} ${what} track(s)${i}`;
}
