import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import type { Writable } from 'node:stream';
import { floatToS16, FRAME_BYTES_S16 } from '../dsp.ts';
import type { OutputSink } from '../clock.ts';

/**
 * Plays the same mix through the Mac's default output (SPEC §6.5), via ffplay or FFmpeg's
 * AudioToolbox device. Used for in-person sessions and testing without Discord.
 */
export class LocalSpeakersSink implements OutputSink {
  readonly name = 'local-speakers';
  private proc: ChildProcessByStdio<Writable, null, null> | null = null;
  private readonly pcm = Buffer.allocUnsafe(FRAME_BYTES_S16);
  dropped = 0;
  error: string | null = null;

  constructor() {
    const cmd = LocalSpeakersSink.command();
    if (!cmd) {
      this.error = 'Neither ffplay nor FFmpeg with AudioToolbox is available';
      return;
    }
    const [bin, ...args] = cmd as [string, ...string[]];
    const proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    proc.on('error', (e) => (this.error = e.message));
    proc.on('close', () => (this.proc = null));
    proc.stdin.on('error', () => {});
    this.proc = proc;
  }

  static command(): string[] | null {
    const has = (c: string) =>
      spawnSync('/usr/bin/env', ['which', c], { stdio: 'ignore' }).status === 0;
    const input = ['-f', 's16le', '-ar', '48000', '-ac', '2'];
    if (has('ffplay')) {
      return [
        'ffplay',
        '-nodisp',
        '-autoexit',
        '-loglevel',
        'error',
        '-fflags',
        'nobuffer',
        ...input,
        '-i',
        'pipe:0',
      ];
    }
    if (process.platform === 'darwin' && has('ffmpeg')) {
      return ['ffmpeg', '-loglevel', 'error', ...input, '-i', 'pipe:0', '-f', 'audiotoolbox', '-'];
    }
    return null;
  }

  write(frame: Float32Array): void {
    const p = this.proc;
    if (!p) return;
    if (p.stdin.writableLength > FRAME_BYTES_S16 * 4) {
      this.dropped++;
      return;
    }
    p.stdin.write(Buffer.from(floatToS16(frame, this.pcm)));
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc?.kill('SIGTERM');
    this.proc = null;
  }
}

/** Collects frames in memory (tests and offline renders). */
export class MemorySink implements OutputSink {
  readonly name = 'memory';
  readonly frames: Float32Array[] = [];
  write(frame: Float32Array): void {
    this.frames.push(frame.slice());
  }
  close(): void {}
}
