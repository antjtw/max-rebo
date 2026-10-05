import { z } from 'zod';

/**
 * Core <-> ears protocol over ws://127.0.0.1:4243 (SPEC §7.2).
 *
 * Audio frames are binary: a fixed 32-byte header followed by s16le mono 16 kHz PCM.
 *   bytes 0..3   magic "CAF1"
 *   bytes 4..7   uint32 LE sequence number
 *   bytes 8..9   uint16 LE flags (bit 0 = end of utterance)
 *   bytes 10..11 uint16 LE length of userId in bytes (max 20)
 *   bytes 12..31 userId (ASCII digits or a player id), zero padded
 * Control and results are JSON text frames.
 */

export const EARS_MAGIC = 'CAF1';
export const EARS_HEADER_BYTES = 32;
export const EARS_SAMPLE_RATE = 16000;
export const EARS_FLAG_END = 1;

export const EarsWord = z.object({
  w: z.string(),
  start: z.number(),
  end: z.number(),
  conf: z.number(),
});

export const EarsResult = z.object({
  type: z.enum(['partial', 'final']),
  engine: z.enum(['vosk', 'whisper']),
  userId: z.string(),
  utteranceId: z.string(),
  text: z.string(),
  confidence: z.number(),
  words: z.array(EarsWord).default([]),
  /** Seconds since the end of speech, as measured by ears, for latency reporting. */
  latencyMs: z.number().optional(),
});
export type EarsResult = z.infer<typeof EarsResult>;

export const EarsInbound = z.discriminatedUnion('type', [
  EarsResult.extend({ type: z.literal('partial') }),
  EarsResult.extend({ type: z.literal('final') }),
  z.object({
    type: z.literal('heartbeat'),
    ts: z.number(),
    engines: z.object({ vosk: z.boolean(), whisper: z.boolean(), vad: z.boolean() }),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({ type: z.literal('ready'), version: z.string() }),
]);
export type EarsInbound = z.infer<typeof EarsInbound>;

export const EarsOutbound = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('configure'),
    grammar: z.array(z.string()),
    initialPrompt: z.string(),
    whisperModel: z.string(),
    voskModel: z.string(),
  }),
  z.object({ type: z.literal('drop_user'), userId: z.string() }),
  z.object({ type: z.literal('ping'), ts: z.number() }),
]);
export type EarsOutbound = z.infer<typeof EarsOutbound>;

export function encodeEarsFrame(
  userId: string,
  seq: number,
  pcm: Uint8Array,
  end = false,
): Uint8Array {
  const out = new Uint8Array(EARS_HEADER_BYTES + pcm.byteLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = EARS_MAGIC.charCodeAt(i);
  view.setUint32(4, seq >>> 0, true);
  view.setUint16(8, end ? EARS_FLAG_END : 0, true);
  const id = userId.slice(0, 20);
  view.setUint16(10, id.length, true);
  for (let i = 0; i < id.length; i++) out[12 + i] = id.charCodeAt(i) & 0x7f;
  out.set(pcm, EARS_HEADER_BYTES);
  return out;
}

export function decodeEarsFrame(
  buf: Uint8Array,
): { userId: string; seq: number; end: boolean; pcm: Uint8Array } | null {
  if (buf.byteLength < EARS_HEADER_BYTES) return null;
  for (let i = 0; i < 4; i++) if (buf[i] !== EARS_MAGIC.charCodeAt(i)) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const seq = view.getUint32(4, true);
  const flags = view.getUint16(8, true);
  const len = Math.min(view.getUint16(10, true), 20);
  let userId = '';
  for (let i = 0; i < len; i++) userId += String.fromCharCode(buf[12 + i] ?? 0);
  return {
    userId,
    seq,
    end: (flags & EARS_FLAG_END) !== 0,
    pcm: buf.subarray(EARS_HEADER_BYTES),
  };
}
