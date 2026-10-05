import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnyBusEvent } from '@cantina/shared';
import { createServer } from './api/server.ts';
import { Cantina } from './app.ts';
import { loadEnv } from './env.ts';
import { analyseLibrary } from './library/analyse.ts';
import { CONFIG_DIR, REPO_ROOT } from './paths.ts';
import { silentLogger } from './util/logger.ts';
import { seededRng } from './util/random.ts';

let tmp: string;
let lib: string;
let app: Cantina;
let base: string;
let close: () => Promise<void>;
const events: AnyBusEvent[] = [];

function tone(rel: string, seconds: number, freq: number) {
  const p = path.join(lib, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${seconds}`,
    '-ac',
    '2',
    p,
  ]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const getJson = async (url: string): Promise<Json> => (await fetch(base + url)).json();
const post = (url: string, body: unknown = {}) =>
  fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function render(seconds: number): number {
  let peak = 0;
  for (let i = 0; i < seconds * 50; i++) {
    const f = app.mixer.renderFrame();
    for (const v of f) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-app-'));
  lib = path.join(tmp, 'lib');
  const cfg = path.join(tmp, 'config');
  fs.mkdirSync(cfg);
  for (const f of fs.readdirSync(CONFIG_DIR))
    if (f.endsWith('.yaml') && f !== 'players.yaml')
      fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(cfg, f));
  fs.copyFileSync(path.join(CONFIG_DIR, 'players.example.yaml'), path.join(cfg, 'players.yaml'));
  fs.writeFileSync(
    path.join(cfg, 'players.yaml'),
    fs
      .readFileSync(path.join(cfg, 'players.yaml'), 'utf8')
      .replace(
        /'000000000000000000' # \[HUMAN\]\n {4}displayName: Ant/,
        "'111' # test\n    displayName: Ant",
      )
      .replace(
        /'000000000000000000' # \[HUMAN\]\n {4}displayName: James/,
        "'222' # test\n    displayName: James",
      ),
  );
  tone('Soundtracks/OST/01 Battle in the Clouds.mp3', 30, 220);
  tone('Soundtracks/OST/02 Desperate Battle.mp3', 30, 247);
  tone('Soundtracks/OST/03 Peaceful Dawn.mp3', 30, 262);
  tone('Soundtracks/OST/04 Calm Rest.mp3', 30, 294);
  tone('SFX/Sabers/Kael - Crossguard Ignite.wav', 1, 880);
  tone('SFX/Sabers/Kael - Crossguard Retract.wav', 1, 660);
  tone('SFX/Sabers/Kael - Crossguard Hum.wav', 2, 110);
  tone('SFX/Sabers/Generic Saber Ignite.wav', 1, 700);
  tone('SFX/Blasters/Blaster Fire 1.wav', 0.5, 1500);
  tone('SFX/Blasters/Blaster Fire 2.wav', 0.5, 1600);
  const env = loadEnv(
    { CANTINA_LIBRARY_PATHS: lib, CANTINA_DATA_DIR: path.join(tmp, 'data') },
    false,
  );
  app = new Cantina({
    env,
    configDir: cfg,
    log: silentLogger,
    discord: false,
    ears: false,
    clock: false,
    watchLibrary: false,
    rng: seededRng(3),
  });
  app.bus.onAny((e) => events.push(e));
  await app.start();
  await app.rescan();
  const s = await createServer(app, { port: 0, lan: false, serveDashboard: false });
  base = s.url;
  close = async () => {
    await s.server.close();
    await app.shutdown();
  };
});

afterAll(async () => {
  await close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Cantina end to end (no Discord)', () => {
  it('serves a valid state snapshot', async () => {
    const r = await fetch(`${base}/api/state`);
    const s: Json = await r.json();
    expect(s.scene.scenes.length).toBeGreaterThan(5);
    expect(s.health.discord.status).toBe('down');
    expect(s.players.map((p: { id: string }) => p.id)).toEqual(['ant', 'james']);
  });

  it('scanned and tagged the library', async () => {
    const r = await getJson(`/api/library?kind=sfx`);
    expect(r.total).toBe(6);
    const music = await getJson(`/api/library?facet=scenes&value=combat`);
    expect(music.total).toBe(2);
  });

  it('switches scenes and plays tagged music with SFX over the top', async () => {
    expect((await post('/api/scene', { sceneId: 'combat' })).status).toBe(200);
    const s = await getJson(`/api/state`);
    expect(s.scene.current).toBe('combat');
    expect(s.nowPlaying.music.title).toMatch(/Battle/);
    expect(render(0.5)).toBeGreaterThan(0.01);
    expect((await post('/api/sfx/fire', { triggerId: 'blaster-fire' })).status).toBe(200);
    expect(app.mixer.voices('sfx')).toHaveLength(1);
    expect(app.mixer.voices('music').length).toBeGreaterThanOrEqual(1);
  });

  it('fires personal SFX from the simulator and stops the hum on retract', async () => {
    events.length = 0;
    await new Promise((r) => setTimeout(r, 350)); // self-hear guard after the previous test's SFX
    await post('/api/sim/say', { playerId: 'james', text: 'I ignite my lightsaber' });
    const titles = app.mixer.voices('sfx').map((v) => v.meta.title);
    expect(titles).toContain('Kael - Crossguard Ignite');
    expect(titles).toContain('Kael - Crossguard Hum');
    await new Promise((r) => setTimeout(r, 2100)); // retract cooldown is separate; saber state is on
    await post('/api/sim/say', { playerId: 'ant', text: 'Kael deactivates his saber' });
    render(1);
    const after = app.mixer.voices('sfx').map((v) => v.meta.title);
    expect(after).not.toContain('Kael - Crossguard Hum');
    expect(
      events
        .filter((e) => e.type === 'trigger.matched')
        .map((e) => (e.payload as { triggerId: string }).triggerId),
    ).toEqual(['saber-ignite', 'saber-retract']);
  });

  it('serves media with range requests', async () => {
    const list = await getJson(`/api/library?kind=sfx`);
    const r = await fetch(`${base}/api/media/${list.rows[0].id}`, {
      headers: { range: 'bytes=0-99' },
    });
    expect(r.status).toBe(206);
    expect((await r.arrayBuffer()).byteLength).toBe(100);
  });

  it('refuses invalid config with line numbers and keeps running', async () => {
    const r = await fetch(`${base}/api/config/scenes`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'scenes:\n  - id: Bad Id\n    label: x\n' }),
    });
    expect(r.status).toBe(422);
    const body: Json = await r.json();
    expect(body.details[0]).toMatch(/^line 2:/);
    expect(app.config.get('scenes').scenes.length).toBeGreaterThan(5);
  });

  it('pushes a snapshot then events over the WebSocket', async () => {
    const ws = new WebSocket(base.replace('http', 'ws') + '/ws');
    const msgs: { kind: string; type?: string }[] = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (d) => {
        msgs.push(JSON.parse(d.toString()));
        if (msgs.some((m) => m.kind === 'event' && m.type === 'game.roll')) resolve();
      });
      ws.on('open', () => void post('/api/game/roll', { balance: 12, despair: 12 }));
    });
    ws.close();
    expect(msgs[0]?.kind).toBe('snapshot');
  });

  it('runs the phrase tester', async () => {
    const r: Json = await (
      await post('/api/triggers/test', { text: 'Kael ignites his saber', playerId: 'ant' })
    ).json();
    expect(r.find((d: { triggerId: string }) => d.triggerId === 'saber-ignite')?.subject).toBe(
      'james',
    );
  });

  it('analyses loudness and sets gain offsets', async () => {
    const res = await analyseLibrary(app.repo, { limit: 3 });
    expect(res.analysed).toBe(3);
    const analysed = app.repo.all().filter((t) => t.analysed_at != null);
    for (const t of analysed) {
      expect(t.lufs).not.toBeNull();
      expect(t.gain_db).not.toBeNull();
    }
  });
});

/* ----------------------- scenario runner (SPEC §16.2) ----------------------- */

interface Scenario {
  name: string;
  mode?: 'manual' | 'suggest' | 'auto';
  start_scene?: string;
  steps: Record<string, unknown>[];
}

describe('scenarios', () => {
  const dir = path.join(REPO_ROOT, 'tests/scenarios');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    const sc = parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Scenario;
    it(sc.name, async () => {
      app.panic();
      render(1.2);
      app.triggers.resetState();
      app.director.setMode(sc.mode ?? 'manual');
      if (sc.start_scene) await app.director.setScene(sc.start_scene, 'manual');
      let fired: AnyBusEvent[] = [];
      const off = app.bus.on('sfx.fired', (p, ts) =>
        fired.push({ type: 'sfx.fired', ts, payload: p } as AnyBusEvent),
      );
      let lastSay = Date.now();
      try {
        for (const step of sc.steps) {
          if (typeof step.as === 'string' && typeof step.say === 'string') {
            await new Promise((r) => setTimeout(r, 350)); // clear the self-hear guard between lines
            fired = [];
            lastSay = Date.now();
            await app.simulate(step.as, step.say);
            app.director.tick();
          } else if (step.accept) {
            expect(await app.director.accept()).toBe(true);
          } else if (step.expect) {
            const e = step.expect as Record<string, unknown>;
            const titles = fired.map((f) => (f.payload as { sfxId: string }).sfxId);
            if (typeof e.sfx === 'string') {
              const row = app.repo.getByRelPath(e.sfx);
              expect(row, `library has ${e.sfx}`).not.toBeNull();
              expect(titles).toContain(row!.id);
              if (typeof e.within_ms === 'number')
                expect(fired[0]!.ts - lastSay).toBeLessThanOrEqual(e.within_ms);
            }
            if (e.no_sfx) expect(titles).toEqual([]);
            if (typeof e.sfx_trigger === 'string') {
              expect(
                fired.map((f) => (f.payload as { triggerId: string | null }).triggerId),
              ).toContain(e.sfx_trigger);
            }
            if (typeof e.suggestion === 'string')
              expect(app.director.suggestion?.sceneId).toBe(e.suggestion);
            if (typeof e.scene === 'string') expect(app.director.current).toBe(e.scene);
          }
        }
      } finally {
        off();
      }
    });
  }
});
