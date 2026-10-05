import OpusScript from 'opusscript';
import { CHANNELS, FRAME_SAMPLES, SAMPLE_RATE } from '../dsp.ts';

/** Opus encoder/decoder via opusscript (DECISIONS D-009). */
export class OpusCodec {
  private readonly codec: OpusScript;

  constructor(application: 'audio' | 'voip' = 'audio') {
    this.codec = new OpusScript(
      SAMPLE_RATE as 48000,
      CHANNELS,
      application === 'audio' ? OpusScript.Application.AUDIO : OpusScript.Application.VOIP,
    );
  }

  encode(pcmS16: Buffer): Buffer {
    return Buffer.from(this.codec.encode(pcmS16, FRAME_SAMPLES));
  }

  decode(packet: Buffer): Buffer {
    return Buffer.from(this.codec.decode(packet));
  }

  close(): void {
    this.codec.delete();
  }
}
