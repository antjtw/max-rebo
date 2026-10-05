import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyBusEvent, SoundRef } from '@cantina/shared';
import { EventBus } from '../../bus/bus.ts';
import { validateYaml } from '../../config/store.ts';
import { CONFIG_DIR } from '../../paths.ts';
import { ManualClock } from '../../util/time.ts';
import { classifyRoll, MtfbwyHooks, parseDyadRoll } from './mtfbwy.ts';

const hooksFile = (() => {
  const r = validateYaml(
    'hooks',
    fs.readFileSync(path.join(CONFIG_DIR, 'hooks.mtfbwy.yaml'), 'utf8'),
  );
  if (!r.ok) throw new Error('bad hooks');
  return r.value;
})();

function setup(scene = 'combat') {
  const clock = new ManualClock(0);
  const bus = new EventBus(clock);
  const events: AnyBusEvent[] = [];
  bus.onAny((e) => events.push(e));
  const stings: [SoundRef, string][] = [];
  const tension: number[] = [];
  const nudges: [string, number][] = [];
  let swells = 0;
  const hooks = new MtfbwyHooks(hooksFile, {
    bus,
    now: () => clock.now(),
    playSting: (r, why) => stings.push([r, why]),
    setTension: (s) => tension.push(s),
    nudgeScene: (s, p) => nudges.push([s, p]),
    currentScene: () => scene,
    swellAmbience: () => swells++,
  });
  return { hooks, clock, events, stings, tension, nudges, swells: () => swells };
}

describe('Dyad dice', () => {
  it('classifies rolls', () => {
    expect(classifyRoll(12, 12)).toBe('major_crit');
    expect(classifyRoll(1, 1)).toBe('major_crit_fail');
    expect(classifyRoll(7, 7)).toBe('minor_crit');
    expect(classifyRoll(7, 3)).toBe('normal');
  });

  it('plays the right stings, rate-limiting minor crits', () => {
    const { hooks, stings, clock } = setup();
    hooks.roll(12, 12);
    hooks.roll(1, 1);
    hooks.roll(5, 5);
    clock.advance(10_000);
    hooks.roll(6, 6);
    expect(stings.map((s) => s[1])).toEqual(['major crit', 'major crit fail', 'minor crit']);
  });

  it('parses dice bot messages', () => {
    expect(parseDyadRoll('**Balance:** 7 | **Despair:** 12')).toEqual({ balance: 7, despair: 12 });
    expect(parseDyadRoll('Rolled 2d12: [3, 9] = 12')).toEqual({ balance: 3, despair: 9 });
    expect(parseDyadRoll('hello there')).toBeNull();
    expect(parseDyadRoll('Balance 13 Despair 2')).toBeNull();
  });
});

describe('Despair and tension', () => {
  it('raises tension one step per 2 Despair spent in 5 minutes, capped', () => {
    const { hooks, tension, clock } = setup();
    hooks.despair(+6);
    hooks.despair(-1);
    expect(hooks.state().tensionStep).toBe(0);
    hooks.despair(-1);
    expect(hooks.state().tensionStep).toBe(1);
    hooks.despair(-2);
    hooks.despair(-2);
    expect(hooks.state().tensionStep).toBe(2); // capped at maxSteps
    clock.advance(6 * 60_000);
    hooks.tick();
    expect(hooks.state().tensionStep).toBe(0);
    expect(tension).toEqual([1, 2, 0]);
  });

  it('plays an ominous sting when the GM spends 3 to interrupt', () => {
    const { hooks, stings } = setup();
    hooks.despair(5);
    hooks.despair(-3);
    expect(stings[0]?.[1]).toBe('despair interrupt');
    expect(hooks.state().despairPool).toBe(2);
  });

  it('hears "I spend two Despair" from the GM only', () => {
    const { hooks } = setup();
    hooks.despair(5);
    hooks.onText('I spend two Despair', false);
    expect(hooks.state().despairPool).toBe(5);
    hooks.onText('I spend two Despair', true);
    expect(hooks.state().despairPool).toBe(3);
  });
});

describe('the Focus', () => {
  it('swells ambience when the GM takes the Focus in combat', () => {
    const { hooks, events, swells } = setup('combat');
    hooks.onText('The GM takes the Focus', true);
    expect(hooks.state().focus).toBe('gm');
    expect(swells()).toBe(1);
    expect(events.some((e) => e.type === 'game.focus' && e.payload.holder === 'gm')).toBe(true);
  });

  it('does not swell outside combat', () => {
    const { hooks, swells } = setup('calm');
    hooks.setFocus('gm');
    expect(swells()).toBe(0);
  });
});

describe('scene cues', () => {
  it('nudges combat on "combat begins" and calm on a full rest', () => {
    const { hooks, nudges } = setup('tension');
    hooks.onText('Okay, combat begins', true);
    hooks.onText('We take a full rest', false);
    expect(nudges).toContainEqual(['combat', 5]);
    expect(nudges).toContainEqual(['calm', 8]);
  });
});
