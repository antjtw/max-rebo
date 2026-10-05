import { Readable } from 'node:stream';
import { floatToS16, FRAME_BYTES_S16 } from '../dsp.ts';
import type { OutputSink } from '../clock.ts';
import { OpusCodec } from './opus.ts';

/**
 * Feeds the mix to Discord as Opus packets. One long-lived object-mode stream wrapped in a single
 * AudioResource (StreamType.Opus). The queue holds at most 3 frames (60 ms jitter buffer); if
 * Discord stops pulling, frames are dropped rather than building latency.
 */
export class DiscordSink implements OutputSink {
  readonly name = 'discord';
  readonly stream: Readable;
  private readonly codec = new OpusCodec('audio');
  private readonly pcm = Buffer.allocUnsafe(FRAME_BYTES_S16);
  dropped = 0;
  private closed = false;

  constructor(private readonly maxQueue = 3) {
    this.stream = new Readable({ objectMode: true, highWaterMark: maxQueue, read() {} });
  }

  write(frame: Float32Array): void {
    if (this.closed) return;
    if (this.stream.readableLength >= this.maxQueue) {
      this.dropped++;
      return;
    }
    floatToS16(frame, this.pcm);
    this.stream.push(this.codec.encode(this.pcm));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stream.push(null);
    this.codec.close();
  }
}
