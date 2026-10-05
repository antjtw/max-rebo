import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Cantina } from '../app.ts';
import { loadEnv } from '../env.ts';
import { silentLogger } from '../util/logger.ts';
import { createServer } from './server.ts';

let tmp: string;
let app: Cantina;
let srv: Awaited<ReturnType<typeof createServer>>;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-lan-'));
  app = new Cantina({
    env: loadEnv({ CANTINA_DATA_DIR: tmp }, false),
    log: silentLogger,
    discord: false,
    ears: false,
    clock: false,
    watchLibrary: false,
  });
  srv = await createServer(app, { port: 0, lan: true, serveDashboard: false });
});
afterAll(async () => {
  await srv.server.close();
  await app.shutdown();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('LAN mode (SPEC §12.10)', () => {
  const remote = '192.168.1.50';

  it('requires the PIN from other devices but not from the Mac itself', async () => {
    expect((await srv.server.inject({ url: '/api/state', remoteAddress: remote })).statusCode).toBe(
      401,
    );
    expect(
      (await srv.server.inject({ url: '/api/state', remoteAddress: '127.0.0.1' })).statusCode,
    ).toBe(200);
  });

  it('shows the PIN only to the Mac', async () => {
    const local = await srv.server.inject({ url: '/api/lan', remoteAddress: '127.0.0.1' });
    expect(local.json().pin).toBe(srv.lanPin);
    const other = await srv.server.inject({
      url: '/api/lan/login',
      method: 'POST',
      payload: { pin: '000000' === srv.lanPin ? '111111' : '000000' },
      remoteAddress: remote,
    });
    expect(other.statusCode).toBe(401);
  });

  it('issues a session cookie for the right PIN', async () => {
    const login = await srv.server.inject({
      url: '/api/lan/login',
      method: 'POST',
      payload: { pin: srv.lanPin },
      remoteAddress: remote,
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    const ok = await srv.server.inject({
      url: '/api/state',
      headers: { cookie },
      remoteAddress: remote,
    });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses everything remote when LAN mode is off', async () => {
    const off = await createServer(app, { port: 0, lan: false, serveDashboard: false });
    expect((await off.server.inject({ url: '/api/state', remoteAddress: remote })).statusCode).toBe(
      403,
    );
    await off.server.close();
  });
});
