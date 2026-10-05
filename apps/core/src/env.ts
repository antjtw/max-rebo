import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from './paths.ts';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const port = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? Number(v) : def))
    .pipe(z.number().int().min(1).max(65535));

export const EnvSchema = z.object({
  DISCORD_TOKEN: z.string().optional().default(''),
  DISCORD_CLIENT_ID: z.string().optional().default(''),
  DISCORD_GUILD_ID: z.string().optional().default(''),
  CANTINA_LIBRARY_PATHS: z.string().optional().default(''),
  CANTINA_PORT: port(4242),
  CANTINA_EARS_PORT: port(4243),
  CANTINA_LAN: bool,
  ACOUSTID_API_KEY: z.string().optional().default(''),
  OLLAMA_URL: z.string().optional().default(''),
  CANTINA_DATA_DIR: z.string().optional().default(''),
  CANTINA_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),
  CANTINA_NO_EARS: bool,
  CANTINA_NO_DISCORD: bool,
});
export type Env = z.infer<typeof EnvSchema> & { libraryRoots: string[] };

export function expandHome(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return path.join(process.env.HOME ?? '', p.slice(1));
  }
  return p;
}

export function parseLibraryRoots(raw: string): string[] {
  return raw
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(expandHome(s)));
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env, readDotenv = true): Env {
  if (readDotenv) loadDotenv({ path: path.join(REPO_ROOT, '.env'), quiet: true });
  const parsed = EnvSchema.parse(source);
  return { ...parsed, libraryRoots: parseLibraryRoots(parsed.CANTINA_LIBRARY_PATHS) };
}
