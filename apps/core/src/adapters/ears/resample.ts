/**
 * 48 kHz stereo s16 → 16 kHz mono s16 for ears (SPEC §7.2). Stateful per stream: a windowed-sinc
 * low-pass (cutoff ≈ 7 kHz) then decimation by 3. Memory only.
 */
const TAPS = 31;
const KERNEL: Float32Array = (() => {
  const k = new Float32Array(TAPS);
  const fc = 7000 / 48000;
  const mid = (TAPS - 1) / 2;
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - mid;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (TAPS - 1));
    k[i] = sinc * w;
    sum += k[i]!;
  }
  for (let i = 0; i < TAPS; i++) k[i] = k[i]! / sum;
  return k;
})();

export class Downsampler48to16 {
  private hist = new Float32Array(TAPS);
  private pos = 0;
  private phase = 0;

  process(stereoS16: Buffer): Buffer {
    const frames = Math.floor(stereoS16.byteLength / 4);
    const out = Buffer.allocUnsafe(Math.ceil(frames / 3) * 2 + 2);
    let o = 0;
    for (let i = 0; i < frames; i++) {
      const mono = (stereoS16.readInt16LE(i * 4) + stereoS16.readInt16LE(i * 4 + 2)) / 65536;
      this.hist[this.pos] = mono;
      this.pos = (this.pos + 1) % TAPS;
      if (this.phase === 0) {
        let acc = 0;
        for (let k = 0; k < TAPS; k++) acc += KERNEL[k]! * this.hist[(this.pos + k) % TAPS]!;
        const s = Math.max(-1, Math.min(1, acc));
        out.writeInt16LE(Math.round(s * 32767), o);
        o += 2;
      }
      this.phase = (this.phase + 1) % 3;
    }
    return out.subarray(0, o);
  }
}
