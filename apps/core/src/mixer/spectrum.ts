import { SAMPLE_RATE } from './dsp.ts';

/** In-place iterative radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci;
        const xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * Mono analyser for the Scope's bottom level meter (SPEC §12.5): log-spaced bands, 0–1.
 */
export class SpectrumAnalyser {
  private readonly ring: Float64Array;
  private pos = 0;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly edges: number[];
  private smoothed: number[];

  constructor(
    readonly size = 1024,
    readonly bands = 24,
    readonly minHz = 40,
    readonly maxHz = 16000,
  ) {
    this.ring = new Float64Array(size);
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++)
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.edges = [];
    for (let b = 0; b <= bands; b++) {
      const hz = minHz * Math.pow(maxHz / minHz, b / bands);
      this.edges.push(Math.max(1, Math.min(size / 2 - 1, Math.round((hz * size) / SAMPLE_RATE))));
    }
    this.smoothed = new Array<number>(bands).fill(0);
  }

  /** Push interleaved stereo samples (downmixed to mono). */
  push(stereo: Float32Array): void {
    for (let i = 0; i < stereo.length; i += 2) {
      this.ring[this.pos] = (stereo[i]! + stereo[i + 1]!) * 0.5;
      this.pos = (this.pos + 1) % this.size;
    }
  }

  /** Band levels 0–1 (−60 dBFS → 0, 0 dBFS → 1), with fast-attack/slow-decay smoothing. */
  compute(): number[] {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.re[i] = this.ring[(this.pos + i) % n]! * this.window[i]!;
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const out: number[] = [];
    for (let b = 0; b < this.bands; b++) {
      const lo = this.edges[b]!;
      const hi = Math.max(lo + 1, this.edges[b + 1]!);
      let p = 0;
      for (let k = lo; k < hi; k++) p = Math.max(p, Math.hypot(this.re[k]!, this.im[k]!));
      const mag = (2 * p) / (n / 2); // window gain ≈ 0.5
      const db = mag > 0 ? 20 * Math.log10(mag) : -120;
      const v = Math.max(0, Math.min(1, (db + 60) / 60));
      const prev = this.smoothed[b]!;
      const s = v > prev ? v : prev * 0.8 + v * 0.2;
      this.smoothed[b] = s;
      out.push(Math.round(s * 1000) / 1000);
    }
    return out;
  }
}
