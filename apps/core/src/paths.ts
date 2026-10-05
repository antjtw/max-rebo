import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (two levels above apps/core/src). */
export const REPO_ROOT = path.resolve(here, '../../..');
export const CONFIG_DIR = path.join(REPO_ROOT, 'config');
export const DASHBOARD_DIST = path.join(REPO_ROOT, 'apps/dashboard/dist');
export const EARS_DIR = path.join(REPO_ROOT, 'ears');

export function dataDir(env: { CANTINA_DATA_DIR?: string } = process.env): string {
  const custom = env.CANTINA_DATA_DIR?.trim();
  return custom ? path.resolve(custom) : path.join(REPO_ROOT, 'data');
}
