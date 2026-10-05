import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateYaml } from '../../config/store.ts';
import { CONFIG_DIR } from '../../paths.ts';
import { SceneScorer } from './scorer.ts';

const scenesRes = validateYaml(
  'scenes',
  fs.readFileSync(path.join(CONFIG_DIR, 'scenes.yaml'), 'utf8'),
);
if (!scenesRes.ok) throw new Error('scenes.yaml invalid');
const scenes = scenesRes.value.scenes;
const settingsRes = validateYaml('settings', '');
if (!settingsRes.ok) throw new Error('settings invalid');
const cfg = settingsRes.value.scenes;

describe('SceneScorer', () => {
  it('decays with a 30 s half-life', () => {
    const s = new SceneScorer(scenes, cfg);
    s.add('tension', 8, 'test', 0);
    expect(s.score('tension', 30_000)).toBeCloseTo(4, 5);
    expect(s.score('tension', 60_000)).toBeCloseTo(2, 5);
  });

  it('scores keywords, weighting the GM higher', () => {
    const s = new SceneScorer(scenes, cfg);
    s.scanText("It's an ambush!", { isGm: false, now: 0 });
    expect(s.score('combat', 0)).toBe(5);
    s.scanText('Ambush', { isGm: true, now: 0 });
    expect(s.score('combat', 0)).toBe(12.5);
  });

  it('respects threshold, hysteresis and dwell time', () => {
    const s = new SceneScorer(scenes, cfg);
    const since = 0;
    s.add('tension', 5, 'x', 10_000);
    expect(s.candidate('calm', since, 10_000)).toBeNull(); // below threshold 6
    s.add('tension', 3, 'x', 10_000);
    expect(s.candidate('calm', since, 10_000)).toBeNull(); // calm dwell is 120 s
    s.add('tension', 8, 'x', 125_000);
    expect(s.candidate('calm', since, 125_000)?.sceneId).toBe('tension');
    // Hysteresis: the current scene's own score raises the bar.
    s.add('calm', 8, 'x', 125_000);
    expect(s.candidate('calm', since, 125_000)).toBeNull();
  });

  it('lets high-priority scenes break in before dwell with 2× threshold', () => {
    const s = new SceneScorer(scenes, cfg);
    s.add('combat', 7, 'x', 1000);
    expect(s.candidate('calm', 0, 1000)).toBeNull();
    s.add('combat', 6, 'x', 1000);
    expect(s.candidate('calm', 0, 1000)?.sceneId).toBe('combat');
  });

  it('never auto-selects manual-only scenes', () => {
    const s = new SceneScorer(scenes, cfg);
    s.add('boss', 100, 'x', 0);
    expect(s.candidate('calm', -1e9, 0)).toBeNull();
  });

  it('routes exit keywords to the fallback scene', () => {
    const s = new SceneScorer(scenes, cfg);
    s.scanText("They're all down", { isGm: true, now: 0 });
    expect(s.score('tension', 0)).toBe(7.5);
  });

  it('scores entry events and explains reasons', () => {
    const s = new SceneScorer(scenes, cfg);
    s.onEvent('trigger.blaster-fire', 0, 3);
    s.scanText('open fire', { isGm: false, now: 0 });
    expect(s.reasonsFor('combat', 0)).toEqual(['"open fire" +4', 'trigger.blaster-fire +3']);
  });

  it('suppresses a dismissed scene briefly', () => {
    const s = new SceneScorer(scenes, cfg);
    s.add('combat', 20, 'x', 0);
    s.reset('combat', 60_000, 0);
    s.add('combat', 40, 'x', 1000); // decays to 10 by 61 s
    expect(s.candidate('calm', -1e9, 1000)).toBeNull();
    expect(s.candidate('calm', -1e9, 61_000)?.sceneId).toBe('combat');
  });
});
