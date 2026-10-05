import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { CHANNELS, SAMPLE_RATE } from './dsp.ts';

/**
 * A pull-based PCM source: 48 kHz stereo float32 interleaved. The mixer pulls one 20 ms frame at a
 * time and must never block, so sources buffer ahead asynchronously (SPEC §6.1).
 */
export interface PcmSource {
  readonly label: string;
  /** Fill `out` with up to `frames` stereo frames; return how many were written. */
  read(out: Float32Array, frames: number): number;
  /** True once no more audio will ever come. */
  readonly ended: boolean;
  /** Set if the source failed (bad file, decode error). */
  readonly error: string | null;
  readonly positionS: number;
  readonly durationS: number | null;
  /** Resolves once ≥ the pre-buffer is available, or the source ended/failed. */
  ready(timeoutMs?: number): Promise<void>;
  close(): void;
}

/** In-memory source, optionally looping with a short crossfade into its own start. */
export class BufferSource implements PcmSource {
  private pos = 0; // in frames
  private _ended = false;
  readonly error = null;
  private readonly frames: number;
  private readonly loopStart: number;
  private readonly loopEnd: number;
  private readonly xfade: number;

  constructor(
    readonly data: Float32Array,
    readonly label = 'buffer',
    readonly opts: {
      loop?: boolean;
      loopStartS?: number;
      loopEndS?: number;
      loopCrossfadeS?: number;
    } = {},
  ) {
    this.frames = Math.floor(data.length / CHANNELS);
    this.loopStart = Math.min(this.frames, Math.round((opts.loopStartS ?? 0) * SAMPLE_RATE));
    this.loopEnd = Math.min(
      this.frames,
      opts.loopEndS ? Math.round(opts.loopEndS * SAMPLE_RATE) : this.frames,
    );
    const maxX = Math.floor((this.loopEnd - this.loopStart) / 4);
    this.xfade = opts.loop
      ? Math.min(maxX, Math.round((opts.loopCrossfadeS ?? 0.05) * SAMPLE_RATE))
      : 0;
  }

  get ended(): boolean {
    return this._ended;
  }
  get positionS(): number {
    return this.pos / SAMPLE_RATE;
  }
  get durationS(): number | null {
    return this.opts.loop ? null : this.frames / SAMPLE_RATE;
  }

  read(out: Float32Array, frames: number): number {
    if (this._ended) return 0;
    const d = this.data;
    let written = 0;
    while (written < frames) {
      if (this.opts.loop && this.loopEnd - this.loopStart > 0) {
        // Each pass crossfades its tail into the loop start, then jumps past the overlap.
        const p = this.pos;
        const tailStart = this.loopEnd - this.xfade;
        let l = d[p * 2]!;
        let r = d[p * 2 + 1]!;
        if (this.xfade > 0 && p >= tailStart) {
          const k = (p - tailStart) / this.xfade;
          const gi = Math.sin((k * Math.PI) / 2);
          const go = Math.cos((k * Math.PI) / 2);
          const hp = this.loopStart + (p - tailStart);
          l = l * go + d[hp * 2]! * gi;
          r = r * go + d[hp * 2 + 1]! * gi;
        }
        out[written * 2] = l;
        out[written * 2 + 1] = r;
        this.pos++;
        if (this.pos >= this.loopEnd) this.pos = this.loopStart + this.xfade;
        written++;
      } else {
        if (this.pos >= this.frames) {
          this._ended = true;
          break;
        }
        const n = Math.min(frames - written, this.frames - this.pos);
        out.set(d.subarray(this.pos * 2, (this.pos + n) * 2), written * 2);
        this.pos += n;
        written += n;
        if (this.pos >= this.frames) this._ended = true;
      }
    }
    return written;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this._ended = true;
  }
}

export interface FfmpegOptions {
  startS?: number;
  /** Loop the file forever by re-spawning the decoder at the end (gapless concatenation). */
  loop?: boolean;
  /** Pre-buffer before playback starts (SPEC §6.1: at least 500 ms). */
  prebufferS?: number;
  /** Stop reading ahead beyond this much buffered audio. */
  maxBufferS?: number;
  ffmpegPath?: string;
  durationS?: number | null;
}

/** Streams a file through an FFmpeg child process, decoding to f32le 48 kHz stereo. */
export class FfmpegSource implements PcmSource {
  private chunks: Float32Array[] = [];
  private chunkOffset = 0;
  private bufferedFloats = 0;
  private leftover: Buffer | null = null;
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private procDone = false;
  private closed = false;
  private _error: string | null = null;
  private framesRead = 0;
  private gotData = false;
  private readyWaiters: (() => void)[] = [];
  private paused = false;
  private stderrTail = '';
  private readonly prebufferFloats: number;
  private readonly maxBufferFloats: number;

  constructor(
    readonly path: string,
    readonly label: string,
    private readonly opts: FfmpegOptions = {},
  ) {
    this.prebufferFloats = Math.round((opts.prebufferS ?? 0.5) * SAMPLE_RATE * CHANNELS);
    this.maxBufferFloats = Math.round((opts.maxBufferS ?? 8) * SAMPLE_RATE * CHANNELS);
    this.spawn(opts.startS ?? 0);
  }

  get ended(): boolean {
    return (
      (this.procDone && this.bufferedFloats === 0 && !this.opts.loop) ||
      this.closed ||
      !!this._error
    );
  }
  get error(): string | null {
    return this._error;
  }
  get positionS(): number {
    return (this.opts.startS ?? 0) + this.framesRead / SAMPLE_RATE;
  }
  get durationS(): number | null {
    return this.opts.durationS ?? null;
  }

  private spawn(startS: number): void {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (startS > 0) args.push('-ss', startS.toFixed(3));
    args.push(
      '-i',
      this.path,
      '-vn',
      '-f',
      'f32le',
      '-ac',
      String(CHANNELS),
      '-ar',
      String(SAMPLE_RATE),
      'pipe:1',
    );
    const proc = spawn(this.opts.ffmpegPath ?? 'ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.procDone = false;
    proc.stdout.on('data', (buf: Buffer) => this.onData(buf));
    proc.stderr.on('data', (b: Buffer) => {
      this.stderrTail = (this.stderrTail + b.toString()).slice(-500);
    });
    proc.on('error', (err) => this.fail(`ffmpeg failed to start: ${err.message}`));
    proc.on('close', (code) => {
      if (this.proc !== proc) return;
      this.procDone = true;
      if (this.closed) return;
      if (code !== 0 && !this.gotData) {
        this.fail(this.stderrTail.trim().split('\n').pop() || `ffmpeg exited with code ${code}`);
        return;
      }
      if (this.opts.loop && this.gotData) {
        this.spawn(0);
        return;
      }
      this.wake();
    });
  }

  private onData(buf: Buffer): void {
    if (this.closed) return;
    this.gotData = true;
    let data = buf;
    if (this.leftover) {
      data = Buffer.concat([this.leftover, buf]);
      this.leftover = null;
    }
    const usable = data.byteLength - (data.byteLength % 4);
    if (usable < data.byteLength) this.leftover = Buffer.from(data.subarray(usable));
    if (usable === 0) return;
    // Copy into an aligned Float32Array (Buffers from pipes may not be 4-byte aligned).
    const f = new Float32Array(usable / 4);
    new Uint8Array(f.buffer).set(data.subarray(0, usable));
    this.chunks.push(f);
    this.bufferedFloats += f.length;
    if (this.bufferedFloats >= this.prebufferFloats) this.wake();
    if (this.bufferedFloats > this.maxBufferFloats && !this.paused) {
      this.paused = true;
      this.proc?.stdout.pause();
    }
  }

  private wake(): void {
    const w = this.readyWaiters;
    this.readyWaiters = [];
    for (const fn of w) fn();
  }

  private fail(msg: string): void {
    this._error = msg;
    this.procDone = true;
    this.wake();
  }

  read(out: Float32Array, frames: number): number {
    if (this.closed || this._error) return 0;
    let need = frames * CHANNELS;
    let written = 0;
    while (need > 0 && this.chunks.length) {
      const c = this.chunks[0]!;
      const avail = c.length - this.chunkOffset;
      const n = Math.min(avail, need);
      out.set(c.subarray(this.chunkOffset, this.chunkOffset + n), written);
      written += n;
      need -= n;
      this.chunkOffset += n;
      this.bufferedFloats -= n;
      if (this.chunkOffset >= c.length) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    if (this.paused && this.bufferedFloats < this.maxBufferFloats / 2) {
      this.paused = false;
      this.proc?.stdout.resume();
    }
    const f = Math.floor(written / CHANNELS);
    this.framesRead += f;
    return f;
  }

  ready(timeoutMs = 3000): Promise<void> {
    if (this.bufferedFloats >= this.prebufferFloats || this.procDone || this._error)
      return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.readyWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  close(): void {
    this.closed = true;
    this.chunks = [];
    this.bufferedFloats = 0;
    if (this.proc && !this.procDone) this.proc.kill('SIGKILL');
    this.wake();
  }
}

/** Decode a whole (short) file into memory. Used for SFX so they start with no decode latency. */
export function decodeFile(
  path: string,
  opts: { ffmpegPath?: string; maxSeconds?: number } = {},
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path, '-vn'];
    if (opts.maxSeconds) args.push('-t', String(opts.maxSeconds));
    args.push('-f', 'f32le', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), 'pipe:1');
    const proc = spawn(opts.ffmpegPath ?? 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const parts: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (b: Buffer) => parts.push(b));
    proc.stderr.on('data', (b: Buffer) => (err = (err + b.toString()).slice(-500)));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg exited with ${code}`));
      const all = Buffer.concat(parts);
      const f = new Float32Array(Math.floor(all.byteLength / 4));
      new Uint8Array(f.buffer).set(all.subarray(0, f.length * 4));
      resolve(f);
    });
  });
}

/** LRU cache of decoded SFX buffers (SPEC §21: pre-decoded SFX in RAM for latency). */
export class SfxCache {
  private map = new Map<string, Float32Array>();
  private bytes = 0;
  private pending = new Map<string, Promise<Float32Array>>();

  constructor(
    private readonly maxBytes = 256 * 1024 * 1024,
    private readonly decoder: (path: string) => Promise<Float32Array> = (p) =>
      decodeFile(p, { maxSeconds: 120 }),
  ) {}

  get size(): number {
    return this.map.size;
  }

  has(path: string): boolean {
    return this.map.has(path);
  }

  async get(path: string): Promise<Float32Array> {
    const hit = this.map.get(path);
    if (hit) {
      this.map.delete(path);
      this.map.set(path, hit);
      return hit;
    }
    let p = this.pending.get(path);
    if (!p) {
      p = this.decoder(path).then((data) => {
        this.pending.delete(path);
        this.map.set(path, data);
        this.bytes += data.byteLength;
        this.evict();
        return data;
      });
      p.catch(() => this.pending.delete(path));
      this.pending.set(path, p);
    }
    return p;
  }

  private evict(): void {
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const [k, v] = this.map.entries().next().value as [string, Float32Array];
      this.map.delete(k);
      this.bytes -= v.byteLength;
    }
  }
}
