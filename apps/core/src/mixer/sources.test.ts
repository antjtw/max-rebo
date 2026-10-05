import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAME_SAMPLES, SAMPLE_RATE } from './dsp.ts';
import { BufferSource, decodeFile, FfmpegSource, SfxCache } from './sources.ts';

let dir: string;
let tone: string;

beforeAll(() => {
  // Test artefacts only, in a temp dir (SPEC §16.2). Never real session audio.
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-src-'));
  tone = path.join(dir, 'tone.wav');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1.5:sample_rate=44100',
    '-ac',
    '1',
    tone,
  ]);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function drain(src: { read(o: Float32Array, n: number): number; ended: boolean }): number {
  const buf = new Float32Array(FRAME_SAMPLES * 2);
  let total = 0;
  for (let i = 0; i < 1000 && !src.ended; i++) total += src.read(buf, FRAME_SAMPLES);
  return total;
}

describe('FfmpegSource', () => {
  it('decodes a file to 48 kHz stereo after pre-buffering', async () => {
    const src = new FfmpegSource(tone, 'tone', { prebufferS: 0.5 });
    await src.ready();
    const buf = new Float32Array(FRAME_SAMPLES * 2);
    expect(src.read(buf, FRAME_SAMPLES)).toBe(FRAME_SAMPLES);
    expect(buf[0]).toBeCloseTo(buf[1]!, 6); // mono upmixed to both channels
    await new Promise((r) => setTimeout(r, 300));
    const rest = drain(src);
    expect((rest + FRAME_SAMPLES) / SAMPLE_RATE).toBeCloseTo(1.5, 1);
    expect(src.ended).toBe(true);
    expect(src.error).toBeNull();
  });

  it('seeks with startS', async () => {
    const src = new FfmpegSource(tone, 'tone', { startS: 1.0 });
    await src.ready();
    await new Promise((r) => setTimeout(r, 300));
    expect(drain(src) / SAMPLE_RATE).toBeCloseTo(0.5, 1);
    expect(src.positionS).toBeCloseTo(1.5, 1);
  });

  it('reports an error for a missing file', async () => {
    const src = new FfmpegSource(path.join(dir, 'nope.wav'), 'missing');
    await src.ready();
    await new Promise((r) => setTimeout(r, 100));
    expect(src.error).toBeTruthy();
    expect(src.ended).toBe(true);
  });

  it('loops by re-spawning the decoder', async () => {
    const src = new FfmpegSource(tone, 'tone', { loop: true, maxBufferS: 1 });
    await src.ready();
    const buf = new Float32Array(FRAME_SAMPLES * 2);
    let total = 0;
    const deadline = Date.now() + 5000;
    while (total < SAMPLE_RATE * 2 && Date.now() < deadline) {
      total += src.read(buf, FRAME_SAMPLES);
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(total).toBeGreaterThanOrEqual(SAMPLE_RATE * 2);
    expect(src.ended).toBe(false);
    src.close();
    expect(src.ended).toBe(true);
  });
});

describe('decodeFile and SfxCache', () => {
  it('decodes fully into memory and caches', async () => {
    let calls = 0;
    const cache = new SfxCache(1024 * 1024 * 1024, (p) => {
      calls++;
      return decodeFile(p);
    });
    const [a, b] = await Promise.all([cache.get(tone), cache.get(tone)]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(a.length / 2 / SAMPLE_RATE).toBeCloseTo(1.5, 2);
  });

  it('evicts least recently used buffers over budget', async () => {
    const cache = new SfxCache(1000, async (p) => new Float32Array(p.length * 100));
    await cache.get('aa');
    await cache.get('bbb');
    expect(cache.has('aa')).toBe(false);
    expect(cache.has('bbb')).toBe(true);
  });
});

describe('BufferSource looping', () => {
  it('loops continuously with a crossfade and no discontinuity spikes', () => {
    const n = SAMPLE_RATE; // 1 s ramp-free sine at an integer frequency
    const d = new Float32Array(n * 2);
    for (let i = 0; i < n; i++)
      d[i * 2] = d[i * 2 + 1] = 0.5 * Math.sin((2 * Math.PI * 100 * i) / SAMPLE_RATE);
    const src = new BufferSource(d, 'loop', { loop: true, loopCrossfadeS: 0.05 });
    const buf = new Float32Array(FRAME_SAMPLES * 2);
    let prev = 0;
    let maxJump = 0;
    for (let f = 0; f < 200; f++) {
      expect(src.read(buf, FRAME_SAMPLES)).toBe(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        maxJump = Math.max(maxJump, Math.abs(buf[i * 2]! - prev));
        prev = buf[i * 2]!;
      }
    }
    // A 100 Hz sine at 0.5 changes by at most ~0.0066 per sample; allow small slack.
    expect(maxJump).toBeLessThan(0.01);
    expect(src.ended).toBe(false);
    expect(src.durationS).toBeNull();
  });
});
