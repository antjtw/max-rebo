import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError, type z } from 'zod';
import {
  BulkConfirmRequest,
  ConfigName,
  DespairRequest,
  DuckingRequest,
  FeedbackRequest,
  FocusRequest,
  LanPinRequest,
  Layer,
  LayerRequest,
  LibraryPatch,
  LibraryQuery,
  ListenRequest,
  LockRequest,
  MasterRequest,
  ModeRequest,
  MusicPauseRequest,
  MusicPlayRequest,
  MusicQueueRequest,
  RollRequest,
  SceneRequest,
  SfxFireRequest,
  SimSayRequest,
  StopRequest,
  TestPhraseRequest,
  VoiceJoinRequest,
  type WsServerMessage,
} from '@cantina/shared';
import type { Cantina } from '../app.ts';
import { ConfigValidationError } from '../config/store.ts';
import { runDoctor } from '../doctor.ts';
import { analyseLibrary } from '../library/analyse.ts';
import { DASHBOARD_DIST } from '../paths.ts';

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};

function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  return schema.parse(data ?? {});
}

export interface ServerOptions {
  port: number;
  lan: boolean;
  /** Serve the built dashboard (off in tests). */
  serveDashboard?: boolean;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/**
 * REST + WebSocket API (SPEC §13), bound to 127.0.0.1 unless LAN mode is on. In LAN mode,
 * non-local clients must enter the 6-digit PIN shown on the Mac's dashboard (SPEC §12.10).
 */
export async function createServer(
  app: Cantina,
  opts: ServerOptions,
): Promise<{ server: FastifyInstance; lanPin: string; url: string }> {
  const server = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const lanPin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const sessions = new Set<string>();
  await server.register(fastifyWebsocket);

  /* ------------------------------ LAN guard ------------------------------ */
  const cookieName = 'cantina_session';
  const sessionOf = (req: FastifyRequest) =>
    (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === cookieName)?.[1];
  server.addHook('onRequest', async (req, reply) => {
    if (isLoopback(req.ip)) return;
    if (!opts.lan) return reply.code(403).send({ error: 'LAN access is off' });
    if (
      req.url.startsWith('/api/lan/login') ||
      (!req.url.startsWith('/api') && !req.url.startsWith('/ws'))
    )
      return;
    const sid = sessionOf(req);
    if (!sid || !sessions.has(sid)) return reply.code(401).send({ error: 'PIN required' });
  });
  server.post('/api/lan/login', async (req, reply) => {
    const { pin } = parse(LanPinRequest, req.body);
    if (!crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(lanPin)))
      return reply.code(401).send({ error: 'Wrong PIN' });
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.add(sid);
    reply.header('set-cookie', `${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Strict`);
    return { ok: true };
  });
  server.get('/api/lan', async (req) => ({
    enabled: opts.lan,
    pin: isLoopback(req.ip) && opts.lan ? lanPin : null,
  }));

  /* ------------------------------ errors ------------------------------ */
  server.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'Invalid request',
        details: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    if (err instanceof ConfigValidationError) {
      return reply.code(422).send({
        error: `${err.file} is invalid`,
        details: err.issues.map(
          (i) =>
            `${i.line != null ? `line ${i.line}: ` : ''}${i.path ? `${i.path}: ` : ''}${i.message}`,
        ),
      });
    }
    const e = err as Error & { statusCode?: number };
    return reply
      .code(e.statusCode && e.statusCode >= 400 ? e.statusCode : 400)
      .send({ error: e.message });
  });

  /* ------------------------------ WebSocket ------------------------------ */
  const clients = new Set<{ send: (s: string) => void; readyState: number }>();
  const broadcast = (msg: WsServerMessage) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  };
  const unsub = app.bus.onAny((e) =>
    broadcast({ kind: 'event', type: e.type, ts: e.ts, payload: e.payload }),
  );
  const snapTimer = setInterval(() => {
    if (clients.size) broadcast({ kind: 'snapshot', state: app.snapshot() });
  }, 2000);
  server.addHook('onClose', async () => {
    unsub();
    clearInterval(snapTimer);
  });
  server.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(
      JSON.stringify({ kind: 'snapshot', state: app.snapshot() } satisfies WsServerMessage),
    );
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  });
  /** After any action, push a fresh snapshot so every screen updates at once. */
  server.addHook('onResponse', async (req) => {
    if (req.method !== 'GET' && clients.size)
      broadcast({ kind: 'snapshot', state: app.snapshot() });
  });

  /* ------------------------------- state ------------------------------- */
  server.get('/api/state', async () => app.snapshot());
  server.get('/api/health', async () => ({ ok: true, version: app.snapshot().version }));
  server.get('/api/doctor', async () => runDoctor({ env: app.opts.env, online: false }));

  /* ------------------------------- voice ------------------------------- */
  server.post('/api/voice/join', async (req) => {
    await app.join(parse(VoiceJoinRequest, req.body).channelId);
    return { ok: true };
  });
  server.post('/api/voice/leave', async () => {
    await app.leave();
    return { ok: true };
  });

  /* ------------------------------- scenes ------------------------------- */
  server.post('/api/scene', async (req) => ({
    ok: true,
    message: await app.setScene(parse(SceneRequest, req.body).sceneId),
  }));
  server.post('/api/scene/revert', async () => ({ ok: await app.director.revert() }));
  server.post<{ Params: { id: string } }>('/api/suggestion/:id/accept', async (req) => ({
    ok: await app.director.accept(req.params.id === 'current' ? undefined : req.params.id),
  }));
  server.post<{ Params: { id: string } }>('/api/suggestion/:id/dismiss', async (req) => ({
    ok: app.director.dismiss(req.params.id === 'current' ? undefined : req.params.id),
  }));
  server.post('/api/mode', async (req) => {
    app.setMode(parse(ModeRequest, req.body).mode);
    return { ok: true };
  });
  server.post('/api/lock', async (req) => {
    app.setLocked(parse(LockRequest, req.body).locked);
    return { ok: true };
  });

  /* ------------------------------- mixer ------------------------------- */
  server.post<{ Params: { layer: string } }>('/api/layers/:layer', async (req) => {
    const layer = Layer.parse(req.params.layer);
    const b = parse(LayerRequest, req.body);
    if (b.gain !== undefined) app.mixer.setLayerGain(layer, b.gain);
    if (b.muted !== undefined) app.mixer.setLayerMuted(layer, b.muted);
    return { ok: true };
  });
  server.post('/api/master', async (req) => {
    app.mixer.setMaster(parse(MasterRequest, req.body).gain);
    return { ok: true };
  });
  server.post('/api/ducking', async (req) => {
    const b = parse(DuckingRequest, req.body);
    app.mixer.setDucking(Object.fromEntries(Object.entries(b).filter(([, v]) => v !== undefined)));
    return { ok: true };
  });
  server.post('/api/stop', async (req) => {
    app.stop(parse(StopRequest, req.body).layer);
    return { ok: true };
  });
  server.post('/api/panic', async () => {
    app.panic();
    return { ok: true };
  });
  server.post('/api/outputs/local', async (req) => {
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    app.setLocalSpeakers(!!enabled);
    return { ok: true };
  });

  /* ------------------------------- music ------------------------------- */
  server.post('/api/music/play', async (req) => {
    const b = parse(MusicPlayRequest, req.body);
    const t = await app.director.playTrack(b.trackId, b.transition);
    return { ok: true, title: t.title };
  });
  server.post('/api/music/next', async () => {
    await app.director.skip();
    return { ok: true };
  });
  server.post('/api/music/queue', async (req) => {
    const t = app.director.queue(parse(MusicQueueRequest, req.body).trackId);
    return { ok: true, title: t.title };
  });
  server.post('/api/music/pause', async (req) => {
    app.mixer.setMusicPaused(parse(MusicPauseRequest, req.body).paused);
    return { ok: true };
  });
  server.post('/api/music/feedback', async (req) => {
    const b = parse(FeedbackRequest, req.body);
    app.director.feedback(b.trackId, b.vote);
    return { ok: true };
  });

  /* -------------------------------- sfx -------------------------------- */
  server.post('/api/sfx/fire', async (req) => {
    const b = parse(SfxFireRequest, req.body);
    const id = b.sfxId ?? `trigger:${b.triggerId}`;
    return { ok: true, message: await app.fireSfx(id, null, b.subject) };
  });

  /* ------------------------------ listening ------------------------------ */
  server.post('/api/listen', async (req) => {
    const b = parse(ListenRequest, req.body);
    if (b.enabled !== undefined) app.setListening(b.enabled);
    if (b.userId && b.userEnabled !== undefined) app.setUserListening(b.userId, b.userEnabled);
    return { ok: true };
  });
  server.get('/api/transcripts', async () => app.transcripts.list());
  server.delete('/api/transcripts', async () => {
    app.transcripts.clear();
    return { ok: true };
  });

  /* ------------------------------- library ------------------------------- */
  server.get('/api/library', async (req) => {
    const q = parse(LibraryQuery, req.query);
    const { total, rows } = app.repo.list(q);
    return { total, rows: rows.map((r) => app.repo.summary(r)) };
  });
  server.get<{ Params: { id: string } }>('/api/library/:id', async (req, reply) => {
    const r = app.repo.get(req.params.id);
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return { ...app.repo.summary(r), fields: app.repo.fields(r.id) };
  });
  server.patch<{ Params: { id: string } }>('/api/library/:id', async (req, reply) => {
    if (!app.repo.get(req.params.id)) return reply.code(404).send({ error: 'Not found' });
    app.repo.applyPatch(req.params.id, parse(LibraryPatch, req.body));
    return app.repo.summary(app.repo.get(req.params.id)!);
  });
  server.post('/api/library/confirm', async (req) => {
    const { trackIds } = parse(BulkConfirmRequest, req.body);
    for (const id of trackIds) app.repo.confirmAllInferred(id);
    return { ok: true, count: trackIds.length };
  });
  server.get<{ Params: { id: string } }>('/api/library/:id/waveform', async (req, reply) => {
    const w = app.repo.waveform(req.params.id);
    if (!w) return reply.code(404).send({ error: 'No waveform yet' });
    return { peaks: Array.from(w) };
  });
  server.get('/api/library/health', async () => libraryHealth(app));
  server.post('/api/library/scan', async () => {
    void app.rescan();
    return { ok: true };
  });
  server.post('/api/library/analyse', async () => {
    void analyseLibrary(app.repo, { onProgress: (p) => app.bus.emit('library.scan', p) });
    return { ok: true };
  });

  /** Range-request audio for browser preview (Ant's headphones only, never to Discord). */
  server.get<{ Params: { trackId: string } }>('/api/media/:trackId', async (req, reply) => {
    const row = app.repo.get(req.params.trackId);
    if (!row || !fs.existsSync(row.path)) return reply.code(404).send({ error: 'Not found' });
    return sendFileRange(req, reply, row.path);
  });

  /* ------------------------------- config ------------------------------- */
  server.get<{ Params: { name: string } }>('/api/config/:name', async (req) => {
    const name = ConfigName.parse(req.params.name);
    return { name, text: app.config.text(name), value: app.config.get(name) };
  });
  server.put<{ Params: { name: string } }>('/api/config/:name', async (req) => {
    const name = ConfigName.parse(req.params.name);
    const body = (req.body ?? {}) as { text?: string; value?: unknown };
    const value =
      typeof body.text === 'string'
        ? app.config.writeText(name, body.text)
        : app.config.writeValue(name, body.value);
    return { ok: true, value };
  });

  /* ----------------------------- simulator ----------------------------- */
  server.post('/api/sim/say', async (req) => {
    const b = parse(SimSayRequest, req.body);
    await app.simulate(b.playerId, b.text, b.final);
    return { ok: true };
  });
  server.post('/api/triggers/test', async (req) => {
    const b = parse(TestPhraseRequest, req.body);
    return app.triggers.test(b.text, b.playerId ?? null);
  });

  /* -------------------------------- game -------------------------------- */
  server.post('/api/game/despair', async (req) => {
    app.hooks.despair(parse(DespairRequest, req.body).delta);
    return app.hooks.state();
  });
  server.post('/api/game/focus', async (req) => {
    app.hooks.setFocus(parse(FocusRequest, req.body).holder);
    return app.hooks.state();
  });
  server.post('/api/game/roll', async (req) => {
    const b = parse(RollRequest, req.body);
    return { outcome: app.hooks.roll(b.balance, b.despair) };
  });
  server.post('/api/game/conclude', async () => {
    app.hooks.concludeScene();
    return app.hooks.state();
  });

  /* ------------------------------ event log ------------------------------ */
  server.get<{ Querystring: { limit?: string } }>('/api/events', async (req) =>
    app.repo.recentEvents(Math.min(1000, Number(req.query.limit ?? 200))),
  );

  /* ------------------------------ dashboard ------------------------------ */
  if (opts.serveDashboard !== false && fs.existsSync(DASHBOARD_DIST)) {
    await server.register(fastifyStatic, { root: DASHBOARD_DIST, wildcard: false });
    server.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/ws'))
        return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').sendFile('index.html');
    });
  } else {
    server.get('/', async (_req, reply) =>
      reply
        .type('text/html')
        .send(
          '<h1>Cantina</h1><p>Dashboard not built. Run <code>npm run build -w @cantina/dashboard</code>, or use <code>npm run dev</code>.</p>',
        ),
    );
  }

  const url = await server.listen({ port: opts.port, host: opts.lan ? '0.0.0.0' : '127.0.0.1' });
  return { server, lanPin, url };
}

function sendFileRange(req: FastifyRequest, reply: FastifyReply, file: string) {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  reply
    .header('accept-ranges', 'bytes')
    .header('content-type', type)
    .header('cache-control', 'no-store');
  if (!range) {
    reply.header('content-length', size);
    return reply.send(fs.createReadStream(file));
  }
  let start = range[1] ? Number(range[1]) : 0;
  let end = range[2] ? Number(range[2]) : size - 1;
  if (!range[1] && range[2]) {
    start = Math.max(0, size - Number(range[2]));
    end = size - 1;
  }
  if (start >= size || end < start)
    return reply.code(416).header('content-range', `bytes */${size}`).send();
  end = Math.min(end, size - 1);
  reply
    .code(206)
    .header('content-range', `bytes ${start}-${end}/${size}`)
    .header('content-length', end - start + 1);
  return reply.send(fs.createReadStream(file, { start, end }));
}

export function libraryHealth(app: Cantina): {
  sceneId: string;
  label: string;
  confirmed: number;
  inferred: number;
  message: string | null;
}[] {
  const out = [];
  for (const sc of app.config.get('scenes').scenes) {
    const cands = app.repo.candidates(sc.music, ['music']);
    let confirmed = 0;
    let inferred = 0;
    for (const c of cands) {
      const tags = sc.music.scenes?.map((s) => c.tags.get('scenes')?.get(s)).filter(Boolean) ?? [];
      if (sc.music.tracks?.length) confirmed++;
      else if (tags.some((t) => t!.status === 'confirmed')) confirmed++;
      else if (tags.length) inferred++;
    }
    const msg =
      confirmed + inferred === 0
        ? `No ${sc.label.toLowerCase()} tracks`
        : confirmed < 3
          ? `Only ${confirmed} confirmed ${sc.label.toLowerCase()} track(s)`
          : null;
    out.push({ sceneId: sc.id, label: sc.label, confirmed, inferred, message: msg });
  }
  return out;
}
