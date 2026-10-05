/** Cantina core entry point: `npm start` / `npm run dev`. */
import { createServer } from './api/server.ts';
import { Cantina } from './app.ts';
import { ConfigValidationError } from './config/store.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './util/logger.ts';

const env = loadEnv();
const log = createLogger(env.CANTINA_LOG_LEVEL);

let app: Cantina;
try {
  app = new Cantina({ env, log, discord: !env.CANTINA_NO_DISCORD, ears: !env.CANTINA_NO_EARS });
} catch (err) {
  if (err instanceof ConfigValidationError) {
    log.error(err.message);
    console.error(`\n${err.message}\n\nFix the file above and start again.`);
    process.exit(1);
  }
  throw err;
}

const lan = env.CANTINA_LAN || app.settings.lan.enabled;
const { server, lanPin } = await createServer(app, { port: env.CANTINA_PORT, lan });
await app.start();
log.info(
  `Cantina console on http://127.0.0.1:${env.CANTINA_PORT}${lan ? ` (LAN on, PIN ${lanPin})` : ''}`,
);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'stopping');
  const force = setTimeout(() => process.exit(1), 8000);
  try {
    await app.shutdown();
    await server.close();
  } finally {
    clearTimeout(force);
    process.exit(0);
  }
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
process.on('unhandledRejection', (err) => log.error({ err: String(err) }, 'unhandled rejection'));
