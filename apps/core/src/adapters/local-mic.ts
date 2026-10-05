import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger } from '../util/logger.ts';

/**
 * Local microphone input (SPEC §7.1) for in-person sessions: one stream, no speaker identity,
 * so triggers rely on character names in the phrase. Audio goes straight to ears as 16 kHz mono
 * PCM in memory; nothing is written to disk. macOS needs microphone permission for the terminal.
 */
export const MIC_USER_ID = 'mic';

export function micCommand(
  platform = process.platform,
  device = process.env.CANTINA_MIC_DEVICE,
): string[] {
  const out = ['-ac', '1', '-ar', '16000', '-f', 's16le', '-loglevel', 'error', 'pipe:1'];
  if (platform === 'darwin')
    return ['ffmpeg', '-f', 'avfoundation', '-i', `:${device ?? 'default'}`, ...out];
  if (platform === 'win32')
    return ['ffmpeg', '-f', 'dshow', '-i', `audio=${device ?? 'default'}`, ...out];
  return ['ffmpeg', '-f', 'pulse', '-i', device ?? 'default', ...out];
}

export class LocalMic {
  private proc: ChildProcess | null = null;
  private stopped = true;
  private restarts = 0;

  constructor(
    private readonly onAudio: (pcm16k: Buffer) => void,
    private readonly log: Logger,
    private readonly onError: (message: string) => void = () => {},
  ) {}

  start(): void {
    this.stopped = false;
    const [bin, ...args] = micCommand() as [string, ...string[]];
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let err = '';
    proc.stdout?.on('data', (b: Buffer) => this.onAudio(b));
    proc.stderr?.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-300)));
    proc.on('error', (e) => this.onError(`Microphone failed: ${e.message}`));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      if (this.stopped) return;
      const msg = /permission|not authorized/i.test(err)
        ? 'Microphone permission denied: allow it for your terminal in System Settings → Privacy & Security → Microphone'
        : `Microphone stopped (code ${code})`;
      this.onError(msg);
      this.log.warn({ code }, 'local mic exited');
      if (this.restarts++ < 5)
        setTimeout(() => !this.stopped && this.start(), 2000 * this.restarts);
    });
  }

  stop(): void {
    this.stopped = true;
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}
