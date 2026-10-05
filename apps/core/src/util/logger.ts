import pino from 'pino';

/**
 * Logs record decisions, never speech (SPEC §7.4). Never pass transcript text to the logger.
 */
export function createLogger(level: string = process.env.CANTINA_LOG_LEVEL ?? 'info') {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production';
  return pino({
    level,
    base: undefined,
    redact: {
      paths: ['token', '*.token', 'text', '*.text', 'transcript', '*.transcript'],
      remove: true,
    },
    transport: pretty
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
      : undefined,
  });
}

export type Logger = ReturnType<typeof createLogger>;

/** A logger that discards everything (tests). */
export const silentLogger: Logger = pino({ level: 'silent' });
