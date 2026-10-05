/**
 * Boots Cantina with a generated demo library (tones made by FFmpeg in a temp dir), Discord and
 * ears off. Used by Playwright and for screenshots. Test artefacts only, never real audio.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../apps/core/src/api/server.ts';
import { Cantina } from '../../apps/core/src/app.ts';
import { loadEnv } from '../../apps/core/src/env.ts';
import { CONFIG_DIR } from '../../apps/core/src/paths.ts';
import { silentLogger } from '../../apps/core/src/util/logger.ts';
import { seededRng } from '../../apps/core/src/util/random.ts';

const port = Number(process.env.E2E_PORT ?? 4310);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-e2e-'));
const lib = path.join(tmp, 'lib');
const cfg = path.join(tmp, 'config');
fs.mkdirSync(cfg, { recursive: true });
for (const f of fs.readdirSync(CONFIG_DIR))
  if (f.endsWith('.yaml') && f !== 'players.yaml')
    fs.copyFileSync(path.join(CONFIG_DIR, f), path.join(cfg, f));
fs.writeFileSync(
  path.join(cfg, 'players.yaml'),
  `players:
  - { id: ant, discordUserId: '111', displayName: Ant, role: gm }
  - id: james
    discordUserId: '222'
    displayName: James
    character: Kael Voss
    aliases: [Kael, Voss]
    sfx:
      saber-ignite: 'SFX/Sabers/Kael - Crossguard Ignite.wav'
      saber-ignite.loop: 'SFX/Sabers/Kael - Crossguard Hum.wav'
  - { id: sam, discordUserId: '333', displayName: Sam, character: Rho Tarrik }
  - { id: priya, discordUserId: '444', displayName: Priya, character: Ixa }
`,
);
const s = fs
  .readFileSync(path.join(cfg, 'settings.yaml'), 'utf8')
  .replace('simulator: false', 'simulator: true');
fs.writeFileSync(path.join(cfg, 'settings.yaml'), s);

const files: [string, number, number][] = [
  ['Soundtracks/Outer Rim Suite/01 Battle over the Shipyards.mp3', 40, 220],
  ['Soundtracks/Outer Rim Suite/02 Desperate Chase.mp3', 40, 247],
  ['Soundtracks/Outer Rim Suite/03 Peaceful Dawn on the Moon.mp3', 40, 262],
  ['Soundtracks/Outer Rim Suite/04 Calm Rest.mp3', 40, 294],
  ['Soundtracks/Outer Rim Suite/05 A Sinister Mystery.mp3', 40, 196],
  ['Soundtracks/Outer Rim Suite/06 Cantina Band Number.mp3', 40, 330],
  ['Ambience/Rain on the Hull Loop.wav', 25, 120],
  ['Ambience/Cantina Crowd Ambience.wav', 25, 140],
  ['SFX/Sabers/Kael - Crossguard Ignite.wav', 1, 880],
  ['SFX/Sabers/Kael - Crossguard Hum.wav', 2, 110],
  ['SFX/Sabers/Saber Ignite.wav', 1, 700],
  ['SFX/Sabers/Saber Retract.wav', 1, 600],
  ['SFX/Blasters/Blaster Fire.wav', 0.5, 1500],
  ['SFX/Doors/Blast Door Open.wav', 1.5, 300],
  ['SFX/Ships/Hyperspace Jump Start.wav', 2, 500],
  ['Stings/Triumph Fanfare Sting.wav', 3, 523],
  ['Stings/Doom Sting.wav', 3, 98],
];
for (const [rel, secs, freq] of files) {
  const p = path.join(lib, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${secs}`,
    '-ac',
    '2',
    p,
  ]);
}

const env = loadEnv(
  {
    CANTINA_LIBRARY_PATHS: lib,
    CANTINA_DATA_DIR: path.join(tmp, 'data'),
    CANTINA_PORT: String(port),
  },
  false,
);
const app = new Cantina({
  env,
  configDir: cfg,
  log: silentLogger,
  discord: false,
  ears: false,
  watchLibrary: false,
  rng: seededRng(5),
});
await app.start();
await app.rescan();
const { url } = await createServer(app, { port, lan: false });
// eslint-disable-next-line no-console
console.log(`demo server on ${url}`);

const stop = async () => {
  await app.shutdown().catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
