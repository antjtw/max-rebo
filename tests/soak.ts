/**
 * Accelerated soak test (SPEC §18 P7): hours of simulated session time through the real mixer,
 * trigger engine and scene scorer, checking for heap growth and frame-count drift.
 *   npm run soak -- --hours 4
 * Run with --expose-gc (the npm script does) for meaningful heap numbers.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Player } from '@cantina/shared';
import { EventBus } from '../apps/core/src/bus/bus.ts';
import { validateYaml } from '../apps/core/src/config/store.ts';
import { SceneScorer } from '../apps/core/src/engine/scenes/scorer.ts';
import { TriggerEngine } from '../apps/core/src/engine/triggers/engine.ts';
import { FRAME_SAMPLES, SAMPLE_RATE } from '../apps/core/src/mixer/dsp.ts';
import { Mixer } from '../apps/core/src/mixer/mixer.ts';
import { BufferSource } from '../apps/core/src/mixer/sources.ts';
import { CONFIG_DIR } from '../apps/core/src/paths.ts';
import { seededRng } from '../apps/core/src/util/random.ts';
import { ManualClock } from '../apps/core/src/util/time.ts';

function load<T>(name: 'triggers' | 'scenes' | 'settings', file: string): T {
  const r = validateYaml(name, file ? fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8') : '');
  if (!r.ok) throw new Error(`${name} invalid`);
  return r.value as T;
}

export interface SoakResult {
  simulatedHours: number;
  frames: number;
  expectedFrames: number;
  heapStartMb: number;
  heapEndMb: number;
  heapPeakMb: number;
  utterances: number;
  triggersFired: number;
  voicesAtEnd: number;
}

export function soak(hours: number, report: (msg: string) => void = () => {}): SoakResult {
  const gc = (globalThis as { gc?: () => void }).gc;
  const clock = new ManualClock(0);
  const bus = new EventBus(clock, false);
  const rng = seededRng(42);
  const mixer = new Mixer({ master: 80, layers: { music: 70, ambience: 60, sfx: 80 } });
  const tone = (seconds: number, freq: number) => {
    const n = Math.round(seconds * SAMPLE_RATE);
    const d = new Float32Array(n * 2);
    for (let i = 0; i < n; i++)
      d[i * 2] = d[i * 2 + 1] = 0.3 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    return d;
  };
  const music = [tone(30, 220), tone(30, 330), tone(30, 440)];
  const sfx = tone(0.6, 900);
  const rain = tone(8, 120);
  let fired = 0;
  const players: Player[] = [
    { id: 'ant', discordUserId: '1', displayName: 'Ant', role: 'gm', aliases: [], sfx: {} },
    {
      id: 'james',
      discordUserId: '2',
      displayName: 'James',
      character: 'Kael',
      aliases: [],
      role: 'player',
      sfx: {},
    },
  ];
  const settings = load<{ triggers: never; scenes: never }>('settings', '');
  const triggers = new TriggerEngine(
    {
      bus,
      now: () => clock.now(),
      fire: (req) => {
        fired++;
        mixer.playSfx(new BufferSource(sfx, 'sfx'), {
          trackId: 'sfx',
          title: 'sfx',
          stateKey: req.loop ? undefined : undefined,
        });
        return true;
      },
      stopLoops: () => {},
      nudgeScene: (s, p, why) => scorer.add(s, p, why, clock.now()),
      onEvent: () => {},
    },
    load('triggers', 'triggers.yaml'),
    players,
    settings.triggers,
  );
  const scorer = new SceneScorer(
    load<{ scenes: never }>('scenes', 'scenes.yaml').scenes,
    settings.scenes,
  );
  mixer.onVoiceEnd = (v, reason) => {
    if (v.layer === 'music' && reason === 'ended')
      mixer.playMusic(
        new BufferSource(music[Math.floor(rng() * 3)]!, 'm'),
        { trackId: 'm', title: 'm' },
        { crossfadeS: 2 },
      );
  };
  mixer.playMusic(new BufferSource(music[0]!, 'm'), { trackId: 'm', title: 'm' }, { fadeInS: 0 });
  mixer.addAmbience(new BufferSource(rain, 'rain', { loop: true }), {
    trackId: 'rain',
    title: 'rain',
  });

  const lines = [
    'I ignite my lightsaber',
    'I deactivate my lightsaber',
    'I fire my blaster',
    'we hear footsteps',
    'nothing to see here',
    'punch it',
  ];
  const totalFrames = Math.round((hours * 3600 * SAMPLE_RATE) / FRAME_SAMPLES);
  gc?.();
  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  let utterances = 0;
  let frames = 0;
  const framesPerSecond = SAMPLE_RATE / FRAME_SAMPLES;
  for (let f = 0; f < totalFrames; f++) {
    mixer.renderFrame();
    frames++;
    clock.advance(20);
    // Every ~4 s someone says something; every 40 s someone speaks long enough to duck.
    if (f % (framesPerSecond * 4) === 0) {
      utterances++;
      void triggers.process({
        text: lines[Math.floor(rng() * lines.length)]!,
        userId: rng() > 0.5 ? '1' : '2',
        utteranceId: `u${utterances}`,
        confidence: 0.9,
        kind: 'final',
        source: 'sim',
      });
      scorer.scanText('we hear footsteps, something is wrong', { isGm: true, now: clock.now() });
      scorer.candidate('calm', 0, clock.now());
    }
    mixer.setSpeechActive(f % (framesPerSecond * 40) < framesPerSecond * 3);
    if (f % (framesPerSecond * 600) === 0 && f > 0) {
      gc?.();
      const h = process.memoryUsage().heapUsed;
      heapPeak = Math.max(heapPeak, h);
      report(
        `${(f / framesPerSecond / 3600).toFixed(2)} h simulated · heap ${(h / 1e6).toFixed(1)} MB · voices ${mixer.voices().length}`,
      );
    }
  }
  gc?.();
  const heapEnd = process.memoryUsage().heapUsed;
  return {
    simulatedHours: hours,
    frames,
    expectedFrames: totalFrames,
    heapStartMb: heapStart / 1e6,
    heapEndMb: heapEnd / 1e6,
    heapPeakMb: Math.max(heapPeak, heapEnd) / 1e6,
    utterances,
    triggersFired: fired,
    voicesAtEnd: mixer.voices().length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--hours');
  const hours = i >= 0 ? Number(process.argv[i + 1]) : 4;
  const t0 = Date.now();
  const r = soak(hours, (m) => process.stdout.write(`${m}\n`));
  const growth = r.heapEndMb - r.heapStartMb;
  process.stdout.write(
    `\n${JSON.stringify(r, null, 2)}\nHeap growth ${growth.toFixed(1)} MB over ${hours} h simulated in ${((Date.now() - t0) / 1000).toFixed(0)} s.\n`,
  );
  process.exitCode = growth > 20 || r.frames !== r.expectedFrames ? 1 : 0;
}
