import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../util/time.ts';
import { Downsampler48to16 } from './resample.ts';
import { TranscriptBuffer } from './transcripts.ts';

describe('Downsampler48to16', () => {
  function stereoSine(freq: number, seconds: number, amp = 0.5): Buffer {
    const n = Math.round(48000 * seconds);
    const b = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const v = Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / 48000));
      b.writeInt16LE(v, i * 4);
      b.writeInt16LE(v, i * 4 + 2);
    }
    return b;
  }
  const rms = (b: Buffer) => {
    let s = 0;
    const n = b.byteLength / 2;
    for (let i = 0; i < n; i++) s += (b.readInt16LE(i * 2) / 32768) ** 2;
    return Math.sqrt(s / n);
  };

  it('produces a third of the samples, in mono', () => {
    const out = new Downsampler48to16().process(stereoSine(440, 0.3));
    expect(out.byteLength / 2).toBe(4800);
  });

  it('passes speech-band audio and removes content above 8 kHz', () => {
    const pass = rms(new Downsampler48to16().process(stereoSine(1000, 0.5)).subarray(200));
    const stop = rms(new Downsampler48to16().process(stereoSine(12000, 0.5)).subarray(200));
    expect(pass).toBeGreaterThan(0.3);
    expect(stop).toBeLessThan(0.03);
  });

  it('is continuous across chunks', () => {
    const d = new Downsampler48to16();
    const whole = new Downsampler48to16().process(stereoSine(500, 0.06));
    const a = d.process(stereoSine(500, 0.06).subarray(0, 960 * 4));
    const b = d.process(stereoSine(500, 0.06).subarray(960 * 4));
    expect(Buffer.concat([a, b]).equals(whole)).toBe(true);
  });
});

describe('TranscriptBuffer', () => {
  it('keeps lines for the retention window only', () => {
    const clock = new ManualClock(0);
    const t = new TranscriptBuffer(5, () => clock.now());
    t.add({ utteranceId: 'a', userId: '1', text: 'hello', final: true });
    clock.advance(4 * 60_000);
    t.add({ utteranceId: 'b', userId: '1', text: 'there', final: true });
    clock.advance(2 * 60_000);
    expect(t.list().map((l) => l.utteranceId)).toEqual(['b']);
  });

  it('replaces partials with the final and never stores with retention 0', () => {
    const t = new TranscriptBuffer(5);
    t.add({ utteranceId: 'a', userId: '1', text: 'i ign', final: false });
    t.add({ utteranceId: 'a', userId: '1', text: 'I ignite my lightsaber.', final: true });
    t.add({ utteranceId: 'a', userId: '1', text: 'i ignite', final: false });
    expect(t.list()).toHaveLength(1);
    expect(t.list()[0]?.final).toBe(true);
    const zero = new TranscriptBuffer(0);
    zero.add({ utteranceId: 'a', userId: '1', text: 'x', final: true });
    expect(zero.list()).toEqual([]);
  });
});
