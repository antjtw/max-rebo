import { describe, expect, it } from 'vitest';
import { MixClock } from './clock.ts';
import { FRAME_FLOATS, FRAME_SAMPLES } from './dsp.ts';
import { DiscordSink } from './outputs/discord-sink.ts';
import { OpusCodec } from './outputs/opus.ts';
import { MemorySink } from './outputs/local-speakers.ts';

describe('MixClock', () => {
  it('renders one frame per 20 ms and fans out to sinks', () => {
    let now = 0;
    let rendered = 0;
    const clock = new MixClock(
      () => {
        rendered++;
        return new Float32Array(FRAME_FLOATS);
      },
      () => now,
    );
    const sink = new MemorySink();
    clock.addSink(sink);
    // Simulate scheduling manually.
    (clock as unknown as { t0: number }).t0 = 0;
    clock.tick(); // t=0 → frame 1 due
    now = 100;
    clock.tick(); // t=100ms → frames 2..6
    expect(rendered).toBe(6);
    expect(sink.frames.length).toBe(6);
  });

  it('skips ahead after a stall instead of bursting', () => {
    let now = 0;
    let rendered = 0;
    const clock = new MixClock(
      () => {
        rendered++;
        return new Float32Array(FRAME_FLOATS);
      },
      () => now,
    );
    clock.tick();
    now = 10_000;
    clock.tick();
    expect(rendered).toBe(6);
    expect(clock.late).toBeGreaterThan(400);
  });

  it('runs on a real timer at roughly 50 frames per second', async () => {
    let rendered = 0;
    const clock = new MixClock(() => {
      rendered++;
      return new Float32Array(FRAME_FLOATS);
    });
    clock.start();
    await new Promise((r) => setTimeout(r, 500));
    clock.stop();
    expect(rendered).toBeGreaterThanOrEqual(23);
    expect(rendered).toBeLessThanOrEqual(28);
  });
});

describe('DiscordSink', () => {
  it('encodes frames to Opus and caps its queue at 3 frames', () => {
    const sink = new DiscordSink(3);
    const frame = new Float32Array(FRAME_FLOATS);
    for (let i = 0; i < FRAME_SAMPLES; i++)
      frame[i * 2] = frame[i * 2 + 1] = 0.3 * Math.sin(i / 10);
    for (let i = 0; i < 5; i++) sink.write(frame);
    expect(sink.stream.readableLength).toBe(3);
    expect(sink.dropped).toBe(2);
    const packet = sink.stream.read() as Buffer;
    expect(packet.byteLength).toBeGreaterThan(10);
    const codec = new OpusCodec();
    expect(codec.decode(packet).byteLength).toBe(FRAME_SAMPLES * 2 * 2);
    codec.close();
    sink.close();
  });
});
