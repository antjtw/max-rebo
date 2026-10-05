import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnyBusEvent, Player } from '@cantina/shared';
import { EventBus } from '../../bus/bus.ts';
import { validateYaml } from '../../config/store.ts';
import { CONFIG_DIR } from '../../paths.ts';
import { ManualClock } from '../../util/time.ts';
import { buildSynonyms, normalise } from '../text/normalise.ts';
import { TriggerEngine, type FireRequest } from './engine.ts';
import { compilePattern, matchPattern, wordSimilarity } from './pattern.ts';

const triggersFile = (() => {
  const r = validateYaml(
    'triggers',
    fs.readFileSync(path.join(CONFIG_DIR, 'triggers.yaml'), 'utf8'),
  );
  if (!r.ok) throw new Error('bad triggers');
  return r.value;
})();
const triggerSettings = (() => {
  const r = validateYaml('settings', '');
  if (!r.ok) throw new Error('bad settings');
  return r.value.triggers;
})();

const players: Player[] = [
  { id: 'ant', discordUserId: '1', displayName: 'Ant', role: 'gm', aliases: [], sfx: {} },
  {
    id: 'james',
    discordUserId: '2',
    displayName: 'James',
    character: 'Kael Voss',
    aliases: ['Kael', 'Voss'],
    role: 'player',
    sfx: {
      'saber-ignite': 'SFX/Sabers/Kael - Crossguard Ignite.wav',
      'saber-retract': 'SFX/Sabers/Kael - Crossguard Retract.wav',
      'saber-ignite.loop': 'SFX/Sabers/Kael - Crossguard Hum.wav',
    },
  },
  {
    id: 'sam',
    discordUserId: '3',
    displayName: 'Sam',
    character: 'Rho',
    aliases: [],
    role: 'player',
    sfx: {},
  },
];

function setup() {
  const clock = new ManualClock(1_000_000);
  const bus = new EventBus(clock);
  const events: AnyBusEvent[] = [];
  bus.onAny((e) => events.push(e));
  const fired: FireRequest[] = [];
  const stopped: string[] = [];
  const nudges: [string, number][] = [];
  const engine = new TriggerEngine(
    {
      bus,
      now: () => clock.now(),
      fire: (r) => {
        fired.push(r);
        return true;
      },
      stopLoops: (k) => stopped.push(k),
      nudgeScene: (s, p) => nudges.push([s, p]),
      onEvent: () => {},
    },
    triggersFile,
    players,
    triggerSettings,
  );
  let n = 0;
  const say = async (
    userId: string,
    text: string,
    confidence = 0.95,
    kind: 'partial' | 'final' = 'final',
    utteranceId = `u${++n}`,
  ) => {
    clock.advance(10_000);
    return engine.process({ text, userId, utteranceId, confidence, kind, source: 'sim' });
  };
  return { engine, clock, events, fired, stopped, nudges, say };
}

describe('pattern matching', () => {
  const syn = buildSynonyms(triggersFile.synonyms);
  const vocab = { character: [{ tokens: ['kael'], id: 'james' }], player: [] };

  it('handles optionals, alternatives and slots', () => {
    const p = compilePattern('{character} (ignites|activates) (his|her|their) lightsaber', syn);
    const m = matchPattern(p, normalise('Kael ignites his saber and steps back', syn), vocab, 0.2);
    expect(m?.score).toBe(1);
    expect(m?.slots.character).toBe('james');
  });

  it('tolerates recognition errors (fuzzy and phonetic)', () => {
    const p = compilePattern('[i] (ignite|activate) my lightsaber', syn);
    expect(
      matchPattern(p, normalise('i ignight my lightsaber', syn), vocab, 0.2)?.score,
    ).toBeGreaterThan(0.8);
    expect(matchPattern(p, normalise('i ignite my lights abre', syn), vocab, 0.2)?.score).toBe(1);
    expect(matchPattern(p, normalise('i ignite my light saber', syn), vocab, 0.2)?.score).toBe(1);
    expect(
      matchPattern(p, normalise('i ignite my blue lightsaber', syn), vocab, 0.2)?.score,
    ).toBeGreaterThan(0.8);
  });

  it('rejects unrelated phrases', () => {
    const p = compilePattern('[i] (ignite|activate) my lightsaber', syn);
    expect(matchPattern(p, normalise('i eat my sandwich', syn), vocab, 0.2)).toBeNull();
  });

  it('keeps short words strict', () => {
    expect(wordSimilarity('mile', 'my', 0.2)).toBe(0);
    expect(wordSimilarity('ignight', 'ignite', 0.2)).toBeGreaterThan(0);
  });

  it('supports legacy (word )? optionals', () => {
    const p = compilePattern('engage (the )?hyperdrive');
    expect(p.elements[1]).toMatchObject({ optional: true });
  });
});

describe('TriggerEngine (SPEC §16.2 scenarios)', () => {
  it('James ignites: his personal saber, then the hum loop', async () => {
    const { fired, say } = setup();
    await say('2', 'Right, I ignite my lightsaber');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      subject: 'james',
      overridePath: 'SFX/Sabers/Kael - Crossguard Ignite.wav',
    });
    expect(fired[0]?.loop).toMatchObject({
      overridePath: 'SFX/Sabers/Kael - Crossguard Hum.wav',
      stateKey: 'james.saber',
    });
  });

  it('GM narrating "Kael deactivates his saber" retracts Kael\'s saber and stops the hum', async () => {
    const { fired, stopped, say } = setup();
    await say('2', 'I ignite my lightsaber');
    await say('1', 'Kael deactivates his saber and steps back');
    expect(fired[1]).toMatchObject({
      subject: 'james',
      overridePath: 'SFX/Sabers/Kael - Crossguard Retract.wav',
    });
    expect(stopped).toContain('james.saber');
  });

  it('GM narrating "Kael ignites his saber" fires Kael\'s saber', async () => {
    const { fired, say } = setup();
    await say('1', 'Kael ignites his saber');
    expect(fired[0]?.subject).toBe('james');
  });

  it('negation does not fire', async () => {
    const { fired, events, say } = setup();
    await say('2', "I don't ignite my lightsaber yet");
    expect(fired).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'trigger.suppressed' && e.payload.reason === 'negation'),
    ).toBe(true);
  });

  it('questions about the action do not fire', async () => {
    const { fired, say } = setup();
    await say('2', 'Should I ignite my lightsaber?');
    await say('2', 'should i ignite my lightsaber');
    expect(fired).toHaveLength(0);
  });

  it('retract requires the saber to be on', async () => {
    const { fired, events, say } = setup();
    await say('2', 'I deactivate my lightsaber');
    expect(fired).toHaveLength(0);
    expect(
      events.some((e) => e.type === 'trigger.suppressed' && e.payload.reason === 'state'),
    ).toBe(true);
  });

  it('a Vosk partial and the Whisper final of one utterance fire once', async () => {
    const { fired, engine, clock } = setup();
    clock.advance(10_000);
    await engine.process({
      text: 'i ignite my lightsaber',
      userId: '2',
      utteranceId: 'x',
      confidence: 0.8,
      kind: 'partial',
      source: 'voice',
    });
    await engine.process({
      text: 'I ignite my lightsaber.',
      userId: '2',
      utteranceId: 'x',
      confidence: 0.9,
      kind: 'final',
      source: 'voice',
    });
    expect(fired).toHaveLength(1);
  });

  it('respects cooldowns', async () => {
    const { fired, engine, clock } = setup();
    clock.advance(10_000);
    await engine.process({
      text: 'I fire my blaster',
      userId: '3',
      utteranceId: 'a',
      confidence: 1,
      kind: 'final',
      source: 'voice',
    });
    clock.advance(500);
    await engine.process({
      text: 'I fire my blaster',
      userId: '3',
      utteranceId: 'b',
      confidence: 1,
      kind: 'final',
      source: 'voice',
    });
    clock.advance(2000);
    await engine.process({
      text: 'I fire my blaster',
      userId: '3',
      utteranceId: 'c',
      confidence: 1,
      kind: 'final',
      source: 'voice',
    });
    expect(fired).toHaveLength(2);
  });

  it('suppresses low-confidence recognition', async () => {
    const { fired, say } = setup();
    await say('2', 'I ignite my lightsaber', 0.4);
    expect(fired).toHaveLength(0);
  });

  it('uses the generic sound for players without an override, and nudges scenes', async () => {
    const { fired, nudges, say } = setup();
    await say('3', 'I ignite my lightsaber');
    expect(fired[0]).toMatchObject({
      subject: 'sam',
      overridePath: null,
      sound: { category: 'saber', phase: 'ignite' },
    });
    expect(nudges).toContainEqual(['combat', 2]);
  });

  it('subject-less triggers fire for anyone', async () => {
    const { fired, say } = setup();
    await say('1', 'Punch it!');
    expect(fired[0]?.trigger.id).toBe('hyperspace-jump');
    expect(fired[0]?.subject).toBeNull();
  });

  it('the phrase tester reports matches without side effects', () => {
    const { engine, fired } = setup();
    const res = engine.test('I ignite my lightsaber', 'james');
    expect(res.find((r) => r.triggerId === 'saber-ignite')).toMatchObject({
      fired: true,
      subject: 'james',
    });
    expect(fired).toHaveLength(0);
  });

  it('applies the self-hear guard right after an SFX', async () => {
    const { engine, clock, fired } = setup();
    clock.advance(10_000);
    await engine.process({
      text: 'punch it',
      userId: '1',
      utteranceId: 'p',
      confidence: 1,
      kind: 'final',
      source: 'voice',
    });
    clock.advance(100);
    await engine.process({
      text: 'I fire my blaster',
      userId: '3',
      utteranceId: 'q',
      confidence: 1,
      kind: 'final',
      source: 'voice',
    });
    expect(fired).toHaveLength(1);
  });

  it('builds a recogniser vocabulary from phrases, names and synonyms', () => {
    const { engine } = setup();
    const v = engine.vocabulary();
    expect(v).toEqual(expect.arrayContaining(['ignite', 'lightsaber', 'kael', 'saber', 'punch']));
  });
});
