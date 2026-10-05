import { describe, expect, it } from 'vitest';
import type { Candidate, TrackRow } from '../library/repo.ts';
import { seededRng } from '../util/random.ts';
import { selectTrack, shiftedRange, type SelectionContext } from './selection.ts';

function cand(
  id: string,
  tags: Record<string, Record<string, number | 'confirmed'>>,
  over: Partial<TrackRow> = {},
  weights: Record<string, number> = {},
): Candidate {
  const m: Candidate['tags'] = new Map();
  for (const [facet, vals] of Object.entries(tags)) {
    m.set(
      facet,
      new Map(
        Object.entries(vals).map(([v, c]) => [
          v,
          c === 'confirmed'
            ? { confidence: 1, status: 'confirmed' as const }
            : { confidence: c, status: 'inferred' as const },
        ]),
      ),
    );
  }
  return {
    track: {
      id,
      title: id,
      intensity: 3,
      vocals: 'none',
      missing: 0,
      bad: 0,
      rating: null,
      last_played_at: null,
      ...over,
    } as TrackRow,
    tags: m,
    sceneWeights: new Map(Object.entries(weights)),
  };
}

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    sceneId: 'combat',
    tensionStep: 0,
    lastPlayed: new Map(),
    previous: [],
    noRepeatCount: 5,
    recencyMinutes: 45,
    allowLyrics: false,
    now: 10_000_000,
    rng: seededRng(1),
    ...over,
  };
}

const combat = {
  scenes: ['combat'],
  intensity: [3, 5] as [number, number],
  vocals: ['none' as const],
};

describe('selectTrack', () => {
  it('filters by scene tag and intensity', () => {
    const cs = [
      cand('calm', { scenes: { calm: 0.9 } }),
      cand('low', { scenes: { combat: 0.9 } }, { intensity: 1 }),
      cand('ok', { scenes: { combat: 0.9 } }, { intensity: 4 }),
    ];
    expect(selectTrack(cs, combat, ctx())?.candidate.track.id).toBe('ok');
  });

  it('excludes lyrics in auto selection by default (Q11)', () => {
    const cs = [cand('song', { scenes: { combat: 1 } }, { vocals: 'lyrics' })];
    expect(selectTrack(cs, { scenes: ['combat'] }, ctx())).toBeNull();
    expect(selectTrack(cs, { scenes: ['combat'] }, ctx({ allowLyrics: true }))).not.toBeNull();
  });

  it('never repeats the previous five unless nothing else exists', () => {
    const cs = ['a', 'b', 'c'].map((id) => cand(id, { scenes: { combat: 0.9 } }));
    for (let i = 0; i < 20; i++) {
      expect(
        selectTrack(cs, combat, ctx({ previous: ['a', 'b'], rng: seededRng(i) }))?.candidate.track
          .id,
      ).toBe('c');
    }
    const p = selectTrack(cs, combat, ctx({ previous: ['a', 'b', 'c'] }));
    expect(p?.relaxed).toContain('repeat');
  });

  it('heavily down-weights tracks played in the last 45 minutes', () => {
    const now = 100 * 60_000;
    const cs = [
      cand('recent', { scenes: { combat: 1 } }),
      cand('fresh', { scenes: { combat: 1 } }),
    ];
    let fresh = 0;
    for (let i = 0; i < 200; i++) {
      const p = selectTrack(
        cs,
        combat,
        ctx({ now, lastPlayed: new Map([['recent', now - 5 * 60_000]]), rng: seededRng(i) }),
      );
      if (p?.candidate.track.id === 'fresh') fresh++;
    }
    expect(fresh).toBeGreaterThan(180);
  });

  it('applies feedback weights and ratings', () => {
    const cs = [
      cand('liked', { scenes: { combat: 0.8 } }, {}, { combat: 2 }),
      cand('disliked', { scenes: { combat: 0.8 } }, { rating: -1 }),
    ];
    let liked = 0;
    for (let i = 0; i < 200; i++)
      if (selectTrack(cs, combat, ctx({ rng: seededRng(i) }))?.candidate.track.id === 'liked')
        liked++;
    expect(liked).toBeGreaterThan(190);
  });

  it('relaxes intensity, then moods', () => {
    const cs = [cand('x', { scenes: { combat: 0.9 }, moods: { playful: 0.9 } }, { intensity: 1 })];
    const p1 = selectTrack(cs, { ...combat, moods: ['playful'] }, ctx());
    expect(p1?.relaxed).toEqual(['intensity']);
    const p2 = selectTrack(cs, { ...combat, moods: ['grim'] }, ctx());
    expect(p2?.relaxed).toEqual(['intensity', 'moods']);
  });

  it('shifts intensity up with tension', () => {
    expect(shiftedRange([1, 2], 1)).toEqual([2, 3]);
    expect(shiftedRange([4, 5], 2)).toEqual([5, 5]);
    const cs = [
      cand('i2', { scenes: { calm: 1 } }, { intensity: 2 }),
      cand('i3', { scenes: { calm: 1 } }, { intensity: 3 }),
    ];
    for (let i = 0; i < 20; i++) {
      expect(
        selectTrack(
          cs,
          { scenes: ['calm'], intensity: [1, 1] },
          ctx({ tensionStep: 2, rng: seededRng(i) }),
        )?.candidate.track.id,
      ).toBe('i3');
    }
  });

  it('ignores rejected-free explicit lists and missing files', () => {
    const cs = [cand('gone', {}, { missing: 1 }), cand('here', {})];
    expect(selectTrack(cs, { tracks: ['gone', 'here'] }, ctx())?.candidate.track.id).toBe('here');
  });
});
