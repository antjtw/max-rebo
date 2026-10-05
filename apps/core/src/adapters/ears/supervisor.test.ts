import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { decodeEarsFrame, type AnyBusEvent, type EarsResult } from '@cantina/shared';
import { EventBus } from '../../bus/bus.ts';
import { silentLogger } from '../../util/logger.ts';
import { EarsSupervisor } from './supervisor.ts';

/** A stand-in for the Python sidecar speaking the same protocol. */
function fakeEars(port: number, opts: { heartbeat: boolean }) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const received: { userId: string; bytes: number; end: boolean }[] = [];
  let configured: unknown = null;
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify({ type: 'ready', version: 'test' }));
    const hb = opts.heartbeat
      ? setInterval(() => ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now(), engines: { vosk: true, whisper: true, vad: true } })), 100)
      : null;
    ws.on('close', () => hb && clearInterval(hb));
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const f = decodeEarsFrame(new Uint8Array(data as Buffer));
        if (f) {
          received.push({ userId: f.userId, bytes: f.pcm.byteLength, end: f.end });
          if (f.end) ws.send(JSON.stringify({ type: 'final', engine: 'whisper', userId: f.userId, utteranceId: `${f.userId}-1`, text: 'I ignite my lightsaber', confidence: 0.9, words: [] }));
        }
      } else configured = JSON.parse(data.toString());
    });
  });
  return { wss, received, configured: () => configured, sockets };
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EarsSupervisor', () => {
  it('configures the grammar, streams audio and relays results', async () => {
    const port = 47301;
    const fake = fakeEars(port, { heartbeat: true });
    cleanup.push(() => fake.wss.close());
    const bus = new EventBus();
    const results: EarsResult[] = [];
    const sup = new EarsSupervisor({
      port, bus, log: silentLogger, silenceMs: 800, whisperModel: 'small.en', voskModel: 'v', heartbeatTimeoutS: 5, modelsDir: '/tmp',
      onResult: (r) => results.push(r),
      configure: () => ({ grammar: ['ignite', 'lightsaber'], initialPrompt: 'p' }),
      spawnProcess: false,
    });
    cleanup.push(() => sup.stop());
    sup.start();
    await wait(800);
    expect(sup.connected).toBe(true);
    expect(fake.configured()).toMatchObject({ type: 'configure', grammar: ['ignite', 'lightsaber'] });
    sup.sendAudio('222', Buffer.alloc(640));
    sup.endUtterance('222');
    await wait(200);
    expect(fake.received).toEqual([
      { userId: '222', bytes: 640, end: false },
      { userId: '222', bytes: 0, end: true },
    ]);
    expect(results[0]?.text).toBe('I ignite my lightsaber');
  });

  it('marks ears DEGRADED and reconnects when the heartbeat stops', async () => {
    const port = 47302;
    const fake = fakeEars(port, { heartbeat: false });
    cleanup.push(() => fake.wss.close());
    const bus = new EventBus();
    const health: AnyBusEvent[] = [];
    bus.on('system.health', (p, ts) => health.push({ type: 'system.health', ts, payload: p } as AnyBusEvent));
    const sup = new EarsSupervisor({
      port, bus, log: silentLogger, silenceMs: 800, whisperModel: 'x', voskModel: 'v', heartbeatTimeoutS: 1, modelsDir: '/tmp',
      onResult: () => {}, configure: () => ({ grammar: [], initialPrompt: '' }), spawnProcess: false,
    });
    cleanup.push(() => sup.stop());
    sup.start();
    await wait(2800);
    const msgs = health.map((h) => (h.payload as { status: string; message: string }));
    expect(msgs.some((m) => m.status === 'degraded' && /no heartbeat/.test(m.message))).toBe(true);
    // It reconnects after the backoff (1 s).
    await wait(1500);
    expect(fake.sockets.length).toBeGreaterThanOrEqual(2);
  });
});
