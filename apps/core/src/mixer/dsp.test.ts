import { describe, expect, it } from 'vitest';
import {
  dbToLin,
  DuckEnvelope,
  equalPowerIn,
  equalPowerOut,
  Fade,
  floatToS16,
  FRAME_FLOATS,
  Limiter,
  peak,
  s16ToFloat,
  SAMPLE_RATE,
} from './dsp.ts';

describe('equal-power crossfade', () => {
  it('keeps in² + out² = 1 across the fade', () => {
    for (let i = 0; i <= 100; i++) {
      const t = i / 100;
      expect(equalPowerIn(t) ** 2 + equalPowerOut(t) ** 2).toBeCloseTo(1, 10);
    }
  });

  it('Fade ramps between levels and finishes on the target', () => {
    const f = new Fade(0, 1, 100);
    const values: number[] = [];
    while (!f.done) values.push(f.next());
    expect(values[0]).toBe(0);
    expect(f.value).toBe(1);
    expect(values.every((v, i) => i === 0 || v >= values[i - 1]!)).toBe(true);
    const out = new Fade(1, 0, 100);
    for (let i = 0; i < 100; i++) out.next();
    expect(out.value).toBeCloseTo(0, 10);
  });

  it('crossfading two correlated signals sums to constant power', () => {
    const fin = new Fade(0, 1, 1000);
    const fout = new Fade(1, 0, 1000);
    for (let i = 0; i < 1000; i++) {
      const a = fin.next();
      const b = fout.next();
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });
});

describe('DuckEnvelope', () => {
  it('reaches the duck depth within the attack time and releases more slowly', () => {
    const env = new DuckEnvelope(150, 800);
    let frames = 0;
    while (env.db > -6 && frames < 100) {
      env.step(-6);
      frames++;
    }
    expect(frames * 20).toBeLessThanOrEqual(160);
    expect(env.db).toBe(-6);
    frames = 0;
    while (env.db < 0 && frames < 100) {
      env.step(0);
      frames++;
    }
    expect(frames * 20).toBeGreaterThan(600);
    expect(frames * 20).toBeLessThanOrEqual(820);
  });

  it('returns start/end linear gains for in-frame interpolation', () => {
    const env = new DuckEnvelope(150, 800);
    const [a, b] = env.step(-6);
    expect(a).toBe(1);
    expect(b).toBeLessThan(1);
    expect(b).toBeGreaterThan(dbToLin(-6));
  });
});

describe('Limiter', () => {
  function sine(seconds: number, amp: number, freq = 440): Float32Array {
    const n = Math.round(seconds * SAMPLE_RATE);
    const out = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const v = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
      out[i * 2] = v;
      out[i * 2 + 1] = v;
    }
    return out;
  }

  it('never exceeds the ceiling, even with hot input and transients', () => {
    const lim = new Limiter(-1, 5);
    const ceiling = dbToLin(-1);
    const buf = sine(1, 3.0);
    // Add brutal single-sample spikes.
    for (let i = 1000; i < buf.length; i += 7919) buf[i] = 8;
    for (let off = 0; off < buf.length; off += FRAME_FLOATS) {
      const frame = buf.subarray(off, off + FRAME_FLOATS);
      lim.process(frame);
      expect(peak(frame)).toBeLessThanOrEqual(ceiling + 1e-6);
    }
  });

  it('is transparent below the ceiling (after the lookahead delay)', () => {
    const lim = new Limiter(-1, 5);
    const input = sine(0.2, 0.5);
    const out = input.slice();
    lim.process(out);
    const delay = lim.lookahead * 2;
    for (let i = delay; i < out.length; i++) {
      expect(out[i]).toBeCloseTo(input[i - delay]!, 6);
    }
    expect(lim.minGain).toBe(1);
  });

  it('reports gain reduction while limiting', () => {
    const lim = new Limiter(-1, 5);
    lim.process(sine(0.1, 2));
    expect(lim.minGain).toBeLessThan(0.6);
  });
});

describe('PCM conversion', () => {
  it('round-trips through s16 within quantisation error and clips', () => {
    const f = new Float32Array([0, 0.5, -0.5, 1.5, -1.5, 0.25]);
    const back = s16ToFloat(floatToS16(f));
    expect(back[1]).toBeCloseTo(0.5, 3);
    expect(back[3]).toBeCloseTo(1, 3);
    expect(back[4]).toBeCloseTo(-1, 3);
  });
});
