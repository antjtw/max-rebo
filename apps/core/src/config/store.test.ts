import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DIR } from '../paths.ts';
import { ConfigStore, ConfigValidationError, validateYaml } from './store.ts';

describe('validateYaml', () => {
  it('accepts the committed config files', () => {
    for (const [name, file] of [
      ['settings', 'settings.yaml'],
      ['scenes', 'scenes.yaml'],
      ['triggers', 'triggers.yaml'],
      ['hooks', 'hooks.mtfbwy.yaml'],
      ['vocabulary', 'vocabulary.yaml'],
      ['taxonomy', 'taxonomy.yaml'],
      ['players', 'players.example.yaml'],
    ] as const) {
      const res = validateYaml(name, fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8'));
      if (!res.ok) throw new Error(`${file}: ${JSON.stringify(res.issues)}`);
      expect(res.ok).toBe(true);
    }
  });

  it('fills defaults for an empty settings file', () => {
    const res = validateYaml('settings', '');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.automation.mode).toBe('suggest');
      expect(res.value.mixer.ducking.depthDb).toBe(-6);
      expect(res.value.ears.retentionMinutes).toBe(5);
    }
  });

  it('reports schema errors with line numbers', () => {
    const text = [
      'scenes:',
      '  - id: calm',
      '    label: Calm',
      '  - id: Bad Id',
      '    label: X',
      '',
    ].join('\n');
    const res = validateYaml('scenes', text);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.line).toBe(4);
      expect(res.issues[0]?.path).toBe('scenes.1.id');
    }
  });

  it('reports YAML syntax errors with line numbers', () => {
    const res = validateYaml('scenes', 'scenes:\n  - id: calm\n   label: [unclosed\n');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.issues[0]?.line).not.toBeNull();
  });

  it('rejects unknown scene fallbacks and duplicate ids', () => {
    const res = validateYaml(
      'scenes',
      'scenes:\n  - { id: a, label: A, fallback: nope }\n  - { id: a, label: B }\n',
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const msgs = res.issues.map((i) => i.message).join(' ');
      expect(msgs).toContain('duplicate scene id');
      expect(msgs).toContain('not a known scene');
    }
  });
});

describe('ConfigStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-config-'));
    for (const f of ['settings.yaml', 'scenes.yaml', 'triggers.yaml', 'hooks.mtfbwy.yaml']) {
      fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(dir, f));
    }
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('loads all files, treating players.yaml as optional', () => {
    const store = new ConfigStore(dir);
    const cfg = store.loadAll();
    expect(cfg.players.players).toEqual([]);
    expect(cfg.scenes.scenes.length).toBeGreaterThan(3);
  });

  it('preserves comments when writing a structured value', () => {
    const store = new ConfigStore(dir);
    store.loadAll();
    const settings = structuredClone(store.get('settings'));
    settings.mixer.ducking.depthDb = -9;
    store.writeValue('settings', settings);
    const text = fs.readFileSync(path.join(dir, 'settings.yaml'), 'utf8');
    expect(text).toContain('depthDb: -9');
    expect(text).toContain('# Q13');
    expect(text).toContain('# Cantina non-secret settings');
    expect(store.get('settings').mixer.ducking.depthDb).toBe(-9);
  });

  it('preserves comments when reordering and editing triggers by id', () => {
    const store = new ConfigStore(dir);
    store.loadAll();
    const triggers = structuredClone(store.get('triggers'));
    const first = triggers.triggers[0]!;
    first.cooldownS = 7;
    store.writeValue('triggers', triggers);
    const text = fs.readFileSync(path.join(dir, 'triggers.yaml'), 'utf8');
    expect(text).toContain('# Synonyms are applied before matching');
    expect(store.get('triggers').triggers[0]?.cooldownS).toBe(7);
  });

  it('refuses invalid text and keeps the previous config', () => {
    const store = new ConfigStore(dir);
    store.loadAll();
    const before = store.get('scenes');
    expect(() => store.writeText('scenes', 'scenes: []\n')).toThrow(ConfigValidationError);
    expect(store.get('scenes')).toBe(before);
  });

  it('notifies listeners on change', () => {
    const store = new ConfigStore(dir);
    store.loadAll();
    const seen: string[] = [];
    store.onChange((name) => seen.push(name));
    store.writeText('vocabulary', 'terms: [lightsaber]\n');
    expect(seen).toEqual(['vocabulary']);
    expect(store.get('vocabulary').terms).toEqual(['lightsaber']);
  });
});
