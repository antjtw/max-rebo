import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { EarsInbound, encodeEarsFrame, type EarsOutbound, type EarsResult } from '@cantina/shared';
import type { EventBus } from '../../bus/bus.ts';
import { EARS_DIR } from '../../paths.ts';
import type { Logger } from '../../util/logger.ts';
import { backoffMs } from '../discord/presence.ts';

export interface EarsOptions {
  port: number;
  bus: EventBus;
  log: Logger;
  silenceMs: number;
  whisperModel: string;
  voskModel: string;
  heartbeatTimeoutS: number;
  modelsDir: string;
  onResult: (r: EarsResult) => void;
  /** Called on (re)connect: returns the grammar and Whisper prompt. */
  configure: () => { grammar: string[]; initialPrompt: string };
  /** Spawn the Python process (false in tests, which run their own server). */
  spawnProcess?: boolean;
  command?: string[];
}

/**
 * Runs the Python ears sidecar and talks to it over ws://127.0.0.1 (SPEC §4.1, §7). Restarts it
 * with backoff on crash or a missed heartbeat (5 s); meanwhile the system degrades to manual and
 * text triggers, and the health lamp reads DEGRADED (SPEC §14).
 */
export class EarsSupervisor {
  private proc: ChildProcess | null = null;
  private ws: WebSocket | null = null;
  private attempt = 0;
  private lastBeat = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private seq = new Map<string, number>();
  private stopped = true;
  engines = { vosk: false, whisper: false, vad: false };
  connected = false;

  constructor(private readonly o: EarsOptions) {}

  start(): void {
    this.stopped = false;
    this.launch();
    this.watchdog = setInterval(() => this.checkHeartbeat(), 1000);
  }

  private health(status: 'ok' | 'degraded' | 'down', message: string): void {
    this.o.bus.emit('system.health', { component: 'ears', status, message });
  }

  private launch(): void {
    if (this.stopped) return;
    if (this.o.spawnProcess !== false) {
      const cmd = this.o.command ?? [
        'uv',
        'run',
        '--quiet',
        'python',
        '-m',
        'ears',
        '--port',
        String(this.o.port),
        '--silence-ms',
        String(this.o.silenceMs),
        '--whisper-model',
        this.o.whisperModel,
        '--vosk-model',
        this.o.voskModel,
      ];
      const [bin, ...args] = cmd as [string, ...string[]];
      const proc = spawn(bin, args, {
        cwd: EARS_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, CANTINA_MODELS_DIR: this.o.modelsDir, HF_HOME: `${this.o.modelsDir}/hf` },
      });
      this.proc = proc;
      proc.stderr?.on('data', (b: Buffer) => {
        // ears logs decisions and engine status only, never speech.
        for (const line of b.toString().split('\n')) if (line.trim()) this.o.log.debug({ ears: line.trim() }, 'ears');
      });
      proc.on('error', (err) => {
        this.health('down', `Couldn't start ears: ${err.message}. Run npm run setup.`);
      });
      proc.on('exit', (code) => {
        if (this.proc !== proc) return;
        this.proc = null;
        this.o.log.warn({ code }, 'ears exited');
        this.scheduleRestart(`Ears stopped (code ${code}); restarting`);
      });
    }
    this.connectSoon(500);
  }

  private connectSoon(delay: number): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), delay);
  }

  private connect(): void {
    if (this.stopped || this.ws) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.o.port}`);
    let opened = false;
    ws.on('open', () => {
      opened = true;
      this.ws = ws;
      this.connected = true;
      this.attempt = 0;
      this.lastBeat = Date.now();
      this.seq.clear();
      const cfg = this.o.configure();
      this.send({ type: 'configure', grammar: cfg.grammar, initialPrompt: cfg.initialPrompt, whisperModel: this.o.whisperModel, voskModel: this.o.voskModel });
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg: EarsInbound;
      try {
        msg = EarsInbound.parse(JSON.parse(data.toString()));
      } catch {
        return;
      }
      if (msg.type === 'heartbeat') {
        this.lastBeat = Date.now();
        this.engines = msg.engines;
        const ok = msg.engines.vosk || msg.engines.whisper;
        this.health(
          ok ? (msg.engines.vosk && msg.engines.whisper ? 'ok' : 'degraded') : 'degraded',
          ok
            ? `Listening locally (${[msg.engines.vosk && 'keywords', msg.engines.whisper && 'transcripts'].filter(Boolean).join(' + ')})`
            : 'No speech engines installed: run npm run setup',
        );
      } else if (msg.type === 'partial' || msg.type === 'final') {
        this.o.onResult(msg);
      } else if (msg.type === 'error') {
        this.o.log.warn({ error: msg.message }, 'ears error');
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
      this.connected = false;
      if (!this.stopped) {
        if (opened) this.health('degraded', 'Ears disconnected; reconnecting');
        this.connectSoon(opened ? 500 : Math.min(5000, 500 * ++this.attempt));
      }
    });
    ws.on('error', () => {
      // close follows
    });
  }

  private checkHeartbeat(): void {
    if (!this.connected) return;
    if (Date.now() - this.lastBeat > this.o.heartbeatTimeoutS * 1000) {
      this.o.log.warn('ears heartbeat lost');
      this.scheduleRestart('Ears stalled (no heartbeat); restarting');
    }
  }

  private scheduleRestart(message: string): void {
    this.health('degraded', message);
    this.connected = false;
    this.ws?.terminate();
    this.ws = null;
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      p.kill('SIGKILL');
    }
    if (this.stopped) return;
    const delay = backoffMs(this.attempt++);
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.launch(), delay);
  }

  private send(m: EarsOutbound): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  reconfigure(): void {
    const cfg = this.o.configure();
    this.send({ type: 'configure', grammar: cfg.grammar, initialPrompt: cfg.initialPrompt, whisperModel: this.o.whisperModel, voskModel: this.o.voskModel });
  }

  /** Send 16 kHz mono PCM for a user. Opted-out users must never reach here (SPEC §7.2.3). */
  sendAudio(userId: string, pcm16k: Buffer, end = false): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1_000_000) return; // ears is behind; drop rather than queue speech
    const n = (this.seq.get(userId) ?? -1) + 1;
    this.seq.set(userId, n);
    ws.send(encodeEarsFrame(userId, n, pcm16k, end));
  }

  endUtterance(userId: string): void {
    this.sendAudio(userId, Buffer.alloc(0), true);
  }

  dropUser(userId: string): void {
    this.send({ type: 'drop_user', userId });
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
    this.ws = null;
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}
