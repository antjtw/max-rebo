/**
 * `npm run doctor`: checks everything Cantina needs and prints a checklist with fixes (SPEC §15.2).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_FILES, ConfigStore, ConfigValidationError } from './config/store.ts';
import { loadEnv, type Env } from './env.ts';
import { CONFIG_DIR, dataDir, EARS_DIR, REPO_ROOT } from './paths.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

function which(cmd: string): string | null {
  try {
    return execFileSync('/usr/bin/env', ['which', cmd], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function canImport(spec: string): Promise<boolean> {
  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(
  opts: { env?: Env; online?: boolean } = {},
): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const add = (r: CheckResult) => out.push(r);
  const env = opts.env ?? loadEnv();
  const online = opts.online ?? true;

  // Node
  const nodeOk = compareVersions(process.version, '22.12.0') >= 0;
  add({
    name: 'Node.js ≥ 22.12',
    status: nodeOk ? 'ok' : 'fail',
    detail: process.version,
    fix: nodeOk
      ? undefined
      : 'brew install node@22 (or fnm install 22) — @discordjs/voice requires 22.12+',
  });

  // Dependencies
  const depsOk = await canImport('discord.js');
  add({
    name: 'Node dependencies',
    status: depsOk ? 'ok' : 'fail',
    detail: depsOk ? 'installed' : 'missing',
    fix: depsOk ? undefined : 'npm run setup',
  });

  // DAVE + Opus
  const daveOk = await canImport('@snazzah/davey');
  add({
    name: 'DAVE library (@snazzah/davey)',
    status: daveOk ? 'ok' : 'fail',
    detail: daveOk ? 'loads' : 'failed to load',
    fix: daveOk
      ? undefined
      : 'npm install; npm update @discordjs/voice @snazzah/davey (voice closes with 4017 without it)',
  });
  const nativeOpus = await canImport('@discordjs/opus');
  const jsOpus = await canImport('opusscript');
  add({
    name: 'Opus encoder',
    status: nativeOpus ? 'ok' : jsOpus ? 'warn' : 'fail',
    detail: nativeOpus
      ? '@discordjs/opus (native)'
      : jsOpus
        ? 'opusscript (slower, works)'
        : 'none',
    fix: nativeOpus
      ? undefined
      : 'Optional: @discordjs/opus is faster, but its installer pulls a vulnerable tar (DECISIONS D-009)',
  });

  // FFmpeg
  const ffmpeg = which('ffmpeg');
  const ffprobe = which('ffprobe');
  add({
    name: 'FFmpeg + ffprobe',
    status: ffmpeg && ffprobe ? 'ok' : 'fail',
    detail: ffmpeg ? (run('ffmpeg', ['-version'])?.split('\n')[0] ?? ffmpeg) : 'not found',
    fix: ffmpeg && ffprobe ? undefined : 'brew install ffmpeg',
  });

  // Python / ears
  const uv = which('uv');
  add({
    name: 'uv (Python manager)',
    status: uv ? 'ok' : 'fail',
    detail: uv ?? 'not found',
    fix: uv ? undefined : 'brew install uv',
  });
  const venv = fs.existsSync(path.join(EARS_DIR, '.venv'));
  add({
    name: 'Ears Python environment',
    status: venv ? 'ok' : 'fail',
    detail: venv ? 'ears/.venv present' : 'missing',
    fix: venv ? undefined : 'npm run setup',
  });
  if (venv && uv) {
    const engines = run(
      'uv',
      [
        'run',
        '--quiet',
        'python',
        '-c',
        'import importlib.util as u;print(",".join(n for n in ["vosk","silero_vad","mlx_whisper","pywhispercpp"] if u.find_spec(n)))',
      ],
      EARS_DIR,
    );
    const have = new Set((engines ?? '').split(',').filter(Boolean));
    const whisper = have.has('mlx_whisper') || have.has('pywhispercpp');
    add({
      name: 'Speech engines',
      status: have.has('vosk') && whisper ? 'ok' : 'warn',
      detail: have.size ? [...have].join(', ') : 'none installed',
      fix: have.has('vosk') && whisper ? undefined : 'npm run setup (installs the speech extra)',
    });
  }

  // Models
  const models = path.join(dataDir(env), 'models');
  const vosk = fs.existsSync(path.join(models, 'vosk-model-small-en-us-0.15'));
  add({
    name: 'Speech models',
    status: vosk ? 'ok' : 'warn',
    detail: vosk ? `in ${path.relative(REPO_ROOT, models)}` : 'Vosk model not downloaded',
    fix: vosk ? undefined : 'npm run setup',
  });

  // Config
  try {
    const store = new ConfigStore(CONFIG_DIR);
    const cfg = store.loadAll();
    add({ name: 'Config files', status: 'ok', detail: Object.values(CONFIG_FILES).join(', ') });
    const hasPlayers = fs.existsSync(store.filePath('players'));
    add({
      name: 'config/players.yaml',
      status: hasPlayers ? (cfg.players.players.length ? 'ok' : 'pending') : 'pending',
      detail: hasPlayers ? `${cfg.players.players.length} players` : 'not created',
      fix: hasPlayers
        ? undefined
        : 'cp config/players.example.yaml config/players.yaml and fill in IDs',
    });
    add({
      name: 'GM user ID',
      status: cfg.settings.discord.gmUserId ? 'ok' : 'pending',
      detail: cfg.settings.discord.gmUserId || 'not set',
      fix: cfg.settings.discord.gmUserId
        ? undefined
        : 'config/settings.yaml discord.gmUserId (docs/SETUP-DISCORD.md §4)',
    });
    if (cfg.settings.enrichment.acoustid) {
      const fpcalc = which('fpcalc');
      add({
        name: 'Chromaprint (fpcalc)',
        status: fpcalc ? 'ok' : 'fail',
        detail: fpcalc ?? 'not found',
        fix: fpcalc ? undefined : 'brew install chromaprint',
      });
    }
  } catch (err) {
    add({
      name: 'Config files',
      status: 'fail',
      detail: err instanceof ConfigValidationError ? err.message : String(err),
      fix: 'Fix the YAML error above',
    });
  }

  // .env
  const envFile = fs.existsSync(path.join(REPO_ROOT, '.env'));
  add({
    name: '.env',
    status: envFile ? 'ok' : 'fail',
    detail: envFile ? 'present' : 'missing',
    fix: envFile ? undefined : 'npm run setup (copies .env.example)',
  });
  const missing = (
    ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'CANTINA_LIBRARY_PATHS'] as const
  ).filter((k) => !env[k]);
  add({
    name: '.env values',
    status: missing.length ? 'pending' : 'ok',
    detail: missing.length ? `missing ${missing.join(', ')}` : 'complete',
    fix: missing.length ? 'Fill these in (docs/SETUP-DISCORD.md)' : undefined,
  });

  // Discord online checks
  if (online && env.DISCORD_TOKEN) {
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      add({
        name: 'Discord token',
        status: res.ok ? 'ok' : 'fail',
        detail: res.ok
          ? `valid (${((await res.json()) as { username: string }).username})`
          : `HTTP ${res.status}`,
        fix: res.ok
          ? undefined
          : 'Reset the token in the Developer Portal (docs/SETUP-DISCORD.md §2)',
      });
      if (res.ok && env.DISCORD_GUILD_ID) {
        const g = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}`, {
          headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
          signal: AbortSignal.timeout(8000),
        });
        add({
          name: 'Guild reachable',
          status: g.ok ? 'ok' : 'fail',
          detail: g.ok ? ((await g.json()) as { name: string }).name : `HTTP ${g.status}`,
          fix: g.ok
            ? undefined
            : 'Invite the bot (docs/SETUP-DISCORD.md §3) and check DISCORD_GUILD_ID',
        });
      }
    } catch (err) {
      add({
        name: 'Discord token',
        status: 'warn',
        detail: `could not reach Discord: ${(err as Error).message}`,
      });
    }
  } else if (!env.DISCORD_TOKEN) {
    add({
      name: 'Discord token',
      status: 'pending',
      detail: 'not set',
      fix: 'docs/SETUP-DISCORD.md',
    });
  }

  // Library roots
  if (env.libraryRoots.length === 0) {
    add({
      name: 'Library roots',
      status: 'pending',
      detail: 'CANTINA_LIBRARY_PATHS not set',
      fix: 'Set it in .env',
    });
  }
  for (const root of env.libraryRoots) {
    let ok: boolean;
    try {
      fs.accessSync(root, fs.constants.R_OK);
      ok = fs.statSync(root).isDirectory();
    } catch {
      ok = false;
    }
    add({
      name: `Library root ${root}`,
      status: ok ? 'ok' : 'warn',
      detail: ok ? 'readable' : 'missing or unreadable (external drive?)',
      fix: ok ? undefined : 'Connect the drive or fix CANTINA_LIBRARY_PATHS',
    });
  }

  // Data dir
  const dd = dataDir(env);
  try {
    fs.mkdirSync(dd, { recursive: true });
    fs.accessSync(dd, fs.constants.W_OK);
    add({ name: 'Data directory', status: 'ok', detail: path.relative(REPO_ROOT, dd) || dd });
  } catch {
    add({ name: 'Data directory', status: 'fail', detail: `${dd} not writable` });
  }

  // macOS specifics
  if (process.platform === 'darwin') {
    add({
      name: 'caffeinate',
      status: which('caffeinate') ? 'ok' : 'warn',
      detail: which('caffeinate') ? 'available (keeps the Mac awake during sessions)' : 'not found',
    });
    add({
      name: 'Apple Silicon',
      status: process.arch === 'arm64' ? 'ok' : 'warn',
      detail:
        process.arch === 'arm64' ? 'arm64' : `${process.arch}: Whisper falls back to CPU base.en`,
    });
  }
  return out;
}

const ICON: Record<CheckStatus, string> = { ok: '✔', warn: '!', fail: '✘', pending: '…' };
const COLOUR: Record<CheckStatus, string> = { ok: '32', warn: '33', fail: '31', pending: '36' };

export function formatResults(results: CheckResult[], colour = process.stdout.isTTY): string {
  const c = (s: CheckStatus, t: string) => (colour ? `\x1b[${COLOUR[s]}m${t}\x1b[0m` : t);
  const lines = results.map((r) => {
    const head = `${c(r.status, ICON[r.status])} ${r.name}: ${r.detail}`;
    return r.fix ? `${head}\n    → ${r.fix}` : head;
  });
  const fails = results.filter((r) => r.status === 'fail').length;
  const pending = results.filter((r) => r.status === 'pending').length;
  lines.push('');
  lines.push(
    fails
      ? c('fail', `${fails} problem(s) to fix.`)
      : pending
        ? c(
            'pending',
            `Ready, with ${pending} item(s) pending your input (see docs/HUMAN-TASKS.md).`,
          )
        : c('ok', 'All good.'),
  );
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const offline = process.argv.includes('--offline');
  const results = await runDoctor({ online: !offline });
  console.log('\nCANTINA · DOCTOR\n');
  console.log(formatResults(results));
  process.exitCode = results.some((r) => r.status === 'fail') ? 1 : 0;
}
