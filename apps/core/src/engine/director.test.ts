import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyBusEvent } from '@cantina/shared';
import { EventBus } from '../bus/bus.ts';
import { validateYaml } from '../config/store.ts';
import { openDatabase } from '../library/db.ts';
import { LibraryRepo } from '../library/repo.ts';
import { CONFIG_DIR } from '../paths.ts';
import { silentLogger } from '../util/logger.ts';
import { seededRng } from '../util/random.ts';
import { ManualClock } from '../util/time.ts';
import { Director } from './director.ts';
import type { Playback, PlayableTrack, PlaybackHooks } from './playback.ts';

const scenes = (() => {
  const r = validateYaml('scenes', fs.readFileSync(path.join(CONFIG_DIR, 'scenes.yaml'), 'utf8'));
  if (!r.ok) throw new Error('bad scenes');
  return r.value.scenes;
})();
const settings = (() => {
  const r = validateYaml('settings', '');
  if (!r.ok) throw new Error('bad settings');
  return r.value;
})();

class FakePlayback {
  hooks: PlaybackHooks = {};
  played: PlayableTrack[] = [];
  ambience: string[] = [];
  current: PlayableTrack | null = null;
  async playMusic(t: PlayableTrack): Promise<boolean> {
    this.played.push(t);
    this.current = t;
    this.hooks.onMusicStarted?.(t);
    return true;
  }
  get currentMusic() {
    return this.current ? { track: this.current, positionS: 0 } : null;
  }
  ambienceTrackIds() {
    return this.ambience;
  }
  async addAmbience(t: PlayableTrack) {
    this.ambience.push(t.id);
    return true;
  }
  stopAmbience(id: string) {
    this.ambience = this.ambience.filter((x) => x !== id);
  }
}

function setup(mode: 'manual' | 'suggest' | 'auto' = 'suggest') {
  const clock = new ManualClock(1_000_000);
  const bus = new EventBus(clock);
  const events: AnyBusEvent[] = [];
  bus.onAny((e) => events.push(e));
  const repo = new LibraryRepo(openDatabase(':memory:'));
  const add = (
    name: string,
    scene: string,
    intensity: number,
    kind: 'music' | 'ambience' = 'music',
  ) => {
    const { id } = repo.upsertScanned(
      {
        path: `/lib/${name}`,
        root: '/lib',
        relPath: name,
        hash: name,
        size: 1,
        mtime: 1,
        title: name,
        durationS: 100,
      },
      kind,
    );
    repo.proposeTag(id, 'scenes', scene, 'claude', 0.8);
    repo.proposeField(id, 'intensity', intensity, 'claude', 0.8);
    return id;
  };
  const ids = {
    calm1: add('calm1.mp3', 'calm', 1),
    calm2: add('calm2.mp3', 'calm', 2),
    combat1: add('combat1.mp3', 'combat', 4),
    combat2: add('combat2.mp3', 'combat', 5),
    tension1: add('tension1.mp3', 'tension', 2),
    rain: add('rain.wav', 'calm', 1, 'ambience'),
  };
  const playback = new FakePlayback();
  const s = structuredClone(settings);
  s.automation.mode = mode;
  const director = new Director({
    repo,
    playback: playback as unknown as Playback,
    bus,
    log: silentLogger,
    scenes: () => scenes,
    settings: () => s,
    roots: () => ['/lib'],
    rng: seededRng(7),
    now: () => clock.now(),
  });
  return { director, playback, clock, events, repo, ids };
}

describe('Director', () => {
  it('starts scene music by tags and auto ambience', async () => {
    const { director, playback, ids } = setup();
    await director.setScene('calm', 'manual');
    expect([ids.calm1, ids.calm2]).toContain(playback.played[0]?.id);
    expect(playback.ambience).toEqual([ids.rain]);
    await director.setScene('combat', 'manual');
    expect([ids.combat1, ids.combat2]).toContain(playback.played[1]?.id);
    expect(playback.ambience).toEqual([ids.rain]); // auto keeps beds when nothing matches combat
  });

  it('suggests in Suggest mode, and accept changes the scene', async () => {
    const { director, events, clock } = setup('suggest');
    await director.setScene('calm', 'manual');
    clock.advance(1000);
    director.onText("It's an ambush, weapons out!", true);
    director.tick();
    expect(director.current).toBe('calm');
    expect(director.suggestion?.sceneId).toBe('combat');
    expect(director.suggestion?.reasons[0]).toContain('ambush');
    await director.accept();
    expect(director.current).toBe('combat');
    expect(
      events.some((e) => e.type === 'scene.changed' && e.payload.cause === 'accepted_suggestion'),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'scene.suggestion_resolved' && e.payload.outcome === 'accepted',
      ),
    ).toBe(true);
  });

  it('expires suggestions after 20 s', async () => {
    const { director, clock, events } = setup('suggest');
    await director.setScene('calm', 'manual');
    director.onText('ambush', true);
    director.onText('ambush', true);
    director.tick();
    expect(director.suggestion).not.toBeNull();
    clock.advance(21_000); // score has decayed below the break-in level
    director.tick();
    expect(director.suggestion).toBeNull();
    expect(
      events.some((e) => e.type === 'scene.suggestion_resolved' && e.payload.outcome === 'expired'),
    ).toBe(true);
  });

  it('dismissing suppresses the same suggestion for a while', async () => {
    const { director } = setup('suggest');
    await director.setScene('calm', 'manual');
    director.onText('ambush', true);
    director.onText('ambush', true);
    director.tick();
    expect(director.dismiss()).toBe(true);
    director.onText('ambush! open fire!', true);
    director.tick();
    expect(director.suggestion).toBeNull();
  });

  it('applies changes in Auto mode and can revert within 10 s', async () => {
    const { director, clock } = setup('auto');
    await director.setScene('calm', 'manual');
    director.onText('ambush! open fire!', true);
    director.tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(director.current).toBe('combat');
    expect(director.undoUntil).not.toBeNull();
    clock.advance(5000);
    expect(await director.revert()).toBe(true);
    expect(director.current).toBe('calm');
  });

  it('lock turns auto changes into suggestions', async () => {
    const { director } = setup('auto');
    await director.setScene('calm', 'manual');
    director.setLocked(true);
    director.onText('ambush! open fire!', true);
    director.tick();
    expect(director.current).toBe('calm');
    expect(director.suggestion?.sceneId).toBe('combat');
  });

  it('manual mode never changes or suggests', async () => {
    const { director } = setup('manual');
    await director.setScene('calm', 'manual');
    director.onText('ambush! open fire!', true);
    director.tick();
    expect(director.current).toBe('calm');
    expect(director.suggestion).toBeNull();
  });

  it('penalises quick skips and rewards manual plays', async () => {
    const { director, playback, repo, clock } = setup();
    await director.setScene('combat', 'manual');
    const first = playback.played[0]!.id;
    clock.advance(5000);
    await director.skip();
    expect(
      repo
        .candidates({ scenes: ['combat'] })
        .find((c) => c.track.id === first)
        ?.sceneWeights.get('combat'),
    ).toBeCloseTo(-0.15);
    await director.playTrack(first);
    expect(
      repo
        .candidates({ scenes: ['combat'] })
        .find((c) => c.track.id === first)
        ?.sceneWeights.get('combat'),
    ).toBeCloseTo(-0.05);
  });

  it('honours a queued track, then picks fresh ones without repeats', async () => {
    const { director, playback, ids } = setup();
    await director.setScene('combat', 'manual');
    director.queue(ids.calm1);
    await director.playNext('ended');
    expect(playback.played.at(-1)?.id).toBe(ids.calm1);
    await director.playNext('ended');
    expect(playback.played.at(-1)?.id).not.toBe(ids.calm1);
  });

  it('falls back through the chain and reports library gaps', async () => {
    const { director, playback, events, ids } = setup();
    await director.setScene('chase', 'manual'); // no chase music → fallback tension
    expect(playback.played[0]?.id).toBe(ids.tension1);
    expect(events.some((e) => e.type === 'library.gap' && e.payload.sceneId === 'chase')).toBe(
      true,
    );
  });

  it('raises intensity with tension', async () => {
    const { director, playback, ids } = setup();
    director.setTension(2);
    for (let i = 0; i < 5; i++) await director.setScene('combat', 'manual');
    expect(playback.played.every((t) => t.id === ids.combat2 || t.id === ids.combat1)).toBe(true);
    expect(playback.played.filter((t) => t.id === ids.combat2).length).toBeGreaterThan(0);
  });
});
