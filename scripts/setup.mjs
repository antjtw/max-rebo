#!/usr/bin/env node
// `npm run setup`: installs Node and Python deps, downloads models, creates .env and data/ (SPEC §15.2).
// Flags: --skip-models (no downloads), --ci (no speech extras, no models).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const ci = args.has('--ci');
const skipModels = ci || args.has('--skip-models');
const isMac = process.platform === 'darwin';
const appleSilicon = isMac && process.arch === 'arm64';

const step = (msg) => console.log(`\n▸ ${msg}`);
const run = (cmd, argv, opts = {}) => {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', cwd: root, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed (${r.status})`);
};
const has = (cmd) => spawnSync('/usr/bin/env', ['which', cmd], { stdio: 'ignore' }).status === 0;

const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 12)) {
  console.error(
    `Node ${process.version} is too old: Cantina needs 22.12+. Run scripts/setup-mac.sh.`,
  );
  process.exit(1);
}

step('Installing Node dependencies');
run('npm', ['install', '--no-audit', '--no-fund']);

step('Creating data directories');
for (const d of ['models', 'logs', 'backups', 'tagging', 'debug']) {
  fs.mkdirSync(path.join(root, 'data', d), { recursive: true });
}

step('Creating .env and players.yaml if missing');
if (!fs.existsSync(path.join(root, '.env'))) {
  fs.copyFileSync(path.join(root, '.env.example'), path.join(root, '.env'));
  console.log('  created .env from .env.example (fill in the [HUMAN] values)');
}
const players = path.join(root, 'config/players.yaml');
if (!fs.existsSync(players)) {
  fs.copyFileSync(path.join(root, 'config/players.example.yaml'), players);
  console.log('  created config/players.yaml from the example (gitignored)');
}

step('Installing the ears Python environment (uv)');
if (!has('uv')) {
  console.error('  uv not found. Run scripts/setup-mac.sh first (or brew install uv).');
  process.exit(1);
}
const extras = ci ? [] : ['--extra', 'speech', '--extra', 'analysis'];
run('uv', ['sync', ...extras], { cwd: path.join(root, 'ears') });

if (!skipModels) {
  const models = path.join(root, 'data/models');
  const vosk = 'vosk-model-small-en-us-0.15';
  if (!fs.existsSync(path.join(models, vosk))) {
    step(`Downloading Vosk model ${vosk} (~40 MB)`);
    const zip = path.join(models, `${vosk}.zip`);
    run('curl', [
      '-fL',
      '--retry',
      '3',
      '-o',
      zip,
      `https://alphacephei.com/vosk/models/${vosk}.zip`,
    ]);
    run('unzip', ['-q', '-o', zip, '-d', models]);
    fs.rmSync(zip);
  }
  const whisper = appleSilicon ? 'whisper-small.en-mlx' : 'whisper-base.en';
  if (appleSilicon && !fs.existsSync(path.join(models, whisper))) {
    step('Downloading Whisper small.en (MLX, ~480 MB)');
    run(
      'uv',
      [
        'run',
        'python',
        '-c',
        `from huggingface_hub import snapshot_download; snapshot_download("mlx-community/${whisper}", local_dir=${JSON.stringify(path.join(models, whisper))})`,
      ],
      { cwd: path.join(root, 'ears') },
    );
  }
  step('Warming Silero VAD (bundled with the silero-vad package)');
  run('uv', ['run', 'python', '-c', 'from silero_vad import load_silero_vad; load_silero_vad()'], {
    cwd: path.join(root, 'ears'),
  });
}

step('Done. Next: npm run doctor');
