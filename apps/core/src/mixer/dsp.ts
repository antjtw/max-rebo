/**
 * Pure DSP building blocks for the mixer (SPEC §6). No I/O, so everything here is unit-tested.
 * Audio is 48 kHz stereo float32, interleaved [L, R, L, R, …], in 20 ms frames.
 */

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = 960; // per channel, 20 ms
export const FRAME_MS = 20;
export const FRAME_FLOATS = FRAME_SAMPLES * CHANNELS;
export const FRAME_BYTES_S16 = FRAME_FLOATS * 2;

export function dbToLin(db: number): number {
  return Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
}

export function linToDb(lin: number): number {
  return lin > 0 ? 20 * Math.log10(lin) : -Infinity;
}

export function secondsToFrames(s: number): number {
  return Math.max(0, Math.round((s * SAMPLE_RATE) / FRAME_SAMPLES));
}

/** Equal-power fade curves: in² + out² = 1 at every point (SPEC §6.4). */
export function equalPowerIn(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.sin((x * Math.PI) / 2);
}
export function equalPowerOut(t: number): number {
  const x = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.cos((x * Math.PI) / 2);
}

/**
 * A gain ramp over a number of samples. Linear in the "curve" domain, mapped through
 * equal-power for fades so crossfades keep constant perceived loudness.
 */
export class Fade {
  private pos = 0;

  constructor(
    readonly from: number,
    readonly to: number,
    readonly samples: number,
    readonly curve: 'equal-power' | 'linear' = 'equal-power',
  ) {}

  get done(): boolean {
    return this.pos >= this.samples;
  }

  /** Gain at the current position, then advance by one sample. */
  next(): number {
    const g = this.at(this.pos);
    if (this.pos < this.samples) this.pos++;
    return g;
  }

  at(pos: number): number {
    if (this.samples <= 0) return this.to;
    const t = Math.min(1, pos / this.samples);
    if (this.curve === 'linear') return this.from + (this.to - this.from) * t;
    // Equal-power between two arbitrary levels: interpolate along the quarter circle.
    if (this.to >= this.from) return this.from + (this.to - this.from) * equalPowerIn(t);
    return this.to + (this.from - this.to) * equalPowerOut(t);
  }

  /** Current gain without advancing. */
  get value(): number {
    return this.at(this.pos);
  }
}

/**
 * Attack/release smoother in the dB domain, evaluated once per frame and interpolated linearly
 * across the frame to avoid zipper noise (SPEC §6.3 ducking: attack 150 ms, release 800 ms).
 */
export class DuckEnvelope {
  private currentDb = 0;

  constructor(
    public attackMs: number,
    public releaseMs: number,
  ) {}

  get db(): number {
    return this.currentDb;
  }

  /** Advance one frame toward targetDb (≤ 0). Returns [startLin, endLin] for the frame. */
  step(targetDb: number, frameMs = FRAME_MS): [number, number] {
    const start = this.currentDb;
    const falling = targetDb < this.currentDb;
    const timeMs = falling ? this.attackMs : this.releaseMs;
    // Time to cover the full distance linearly in dB: predictable and easy to reason about.
    const span = Math.max(1e-6, Math.abs(targetDb - start));
    const maxStep = (frameMs / Math.max(1, timeMs)) * Math.max(span, 6);
    const delta = Math.max(-maxStep, Math.min(maxStep, targetDb - start));
    this.currentDb = Math.abs(targetDb - (start + delta)) < 1e-3 ? targetDb : start + delta;
    return [dbToLin(start), dbToLin(this.currentDb)];
  }

  reset(db = 0): void {
    this.currentDb = db;
  }
}

/** One-pole gain smoother for fader moves (per frame, linear interpolation inside the frame). */
export class GainSmoother {
  constructor(private current: number) {}
  get value(): number {
    return this.current;
  }
  step(target: number, coeff = 0.35): [number, number] {
    const start = this.current;
    const next = start + (target - start) * coeff;
    this.current = Math.abs(target - next) < 1e-5 ? target : next;
    return [start, this.current];
  }
  set(v: number): void {
    this.current = v;
  }
}

/**
 * Lookahead brick-wall limiter (SPEC §6.3: lookahead ~5 ms, ceiling −1 dBFS).
 *
 * gr[n] = min(1, ceiling / peak[n]); m[n] = min(gr[n..n+L]) (sliding min over the lookahead);
 * r[n] = min(m[n], release-smoothed r[n-1]); g[n] = mean(r[n-L..n]).
 * Every r[k] in the averaging window is ≤ gr[n], so |x[n] · g[n]| ≤ ceiling by construction.
 * Latency is L samples. A final clamp guards against floating-point rounding.
 */
export class Limiter {
  readonly lookahead: number;
  private readonly ceiling: number;
  private readonly releaseCoeff: number;
  // Audio delay line (length L) and the ring of smoothed gains being averaged (length L+1).
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private readonly rRing: Float32Array;
  private aIdx = 0;
  private idx = 0;
  private rPrev = 1;
  private rSum: number;
  // Monotonic deque for the sliding minimum (indices into a virtual sample counter).
  private readonly dqVal: Float64Array;
  private readonly dqPos: Float64Array;
  private dqHead = 0;
  private dqTail = 0;
  private t = 0;
  /** Lowest gain applied during the last process() call (1 = no limiting). */
  minGain = 1;

  constructor(ceilingDb = -1, lookaheadMs = 5, releaseMs = 120) {
    this.ceiling = dbToLin(ceilingDb);
    this.lookahead = Math.max(1, Math.round((lookaheadMs / 1000) * SAMPLE_RATE));
    this.releaseCoeff = 1 - Math.exp(-1 / ((releaseMs / 1000) * SAMPLE_RATE));
    const n = this.lookahead + 1;
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    this.rRing = new Float32Array(n).fill(1);
    this.rSum = n;
    this.dqVal = new Float64Array(n + 1);
    this.dqPos = new Float64Array(n + 1);
  }

  /** Process an interleaved stereo buffer in place. */
  process(buf: Float32Array): void {
    const L = this.lookahead;
    const n = L + 1;
    const cap = this.dqVal.length;
    let minGain = 1;
    for (let i = 0; i < buf.length; i += 2) {
      const xl = buf[i]!;
      const xr = buf[i + 1]!;
      const peak = Math.max(Math.abs(xl), Math.abs(xr));
      const gr = peak > this.ceiling ? this.ceiling / peak : 1;

      // Push gr into the sliding-min deque.
      while (this.dqTail !== this.dqHead) {
        const last = (this.dqTail - 1 + cap) % cap;
        if (this.dqVal[last]! >= gr) this.dqTail = last;
        else break;
      }
      this.dqVal[this.dqTail] = gr;
      this.dqPos[this.dqTail] = this.t;
      this.dqTail = (this.dqTail + 1) % cap;
      // Drop entries older than the window [t-L, t].
      while (this.dqPos[this.dqHead]! < this.t - L) this.dqHead = (this.dqHead + 1) % cap;
      const m = this.dqVal[this.dqHead]!; // min over the window = m[t-L]

      // Release smoothing (never above m, so the guarantee holds).
      const released = this.rPrev + (1 - this.rPrev) * this.releaseCoeff;
      const r = Math.min(m, released);
      this.rPrev = r;

      // Box average of r over the last L+1 values.
      const slot = this.idx;
      this.rSum += r - this.rRing[slot]!;
      this.rRing[slot] = r;
      const g = Math.min(1, this.rSum / n);

      // Output the delayed sample x[t-L] and store the new one.
      const a = this.aIdx;
      const outL = this.delayL[a]! * g;
      const outR = this.delayR[a]! * g;
      this.delayL[a] = xl;
      this.delayR[a] = xr;
      this.aIdx = (a + 1) % L;
      this.idx = (slot + 1) % n;
      this.t++;

      const c = this.ceiling;
      buf[i] = outL > c ? c : outL < -c ? -c : outL;
      buf[i + 1] = outR > c ? c : outR < -c ? -c : outR;
      if (g < minGain) minGain = g;
    }
    this.minGain = minGain;
  }
}

/** RMS of an interleaved stereo buffer (both channels). */
export function rms(buf: Float32Array, start = 0, end = buf.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    const v = buf[i]!;
    sum += v * v;
  }
  const n = end - start;
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

export function peak(buf: Float32Array): number {
  let p = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i]!);
    if (v > p) p = v;
  }
  return p;
}

/** float32 [-1, 1] → s16le. */
export function floatToS16(src: Float32Array, out?: Buffer): Buffer {
  const dst = out ?? Buffer.allocUnsafe(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    const v = src[i]!;
    const s = v >= 1 ? 32767 : v <= -1 ? -32768 : Math.round(v * 32767);
    dst.writeInt16LE(s, i * 2);
  }
  return dst;
}

/** s16le → float32. */
export function s16ToFloat(src: Buffer | Uint8Array): Float32Array {
  const n = Math.floor(src.byteLength / 2);
  const out = new Float32Array(n);
  const view = new DataView(src.buffer, src.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
