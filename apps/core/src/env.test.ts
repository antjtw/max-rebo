import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseLibraryRoots } from './env.ts';

describe('env', () => {
  it('parses colon-separated library roots and expands ~', () => {
    const roots = parseLibraryRoots('~/Music/A: /tmp/B ::');
    expect(roots).toEqual([path.join(process.env.HOME ?? '', 'Music/A'), '/tmp/B']);
  });

  it('applies port defaults and booleans', () => {
    const env = loadEnv({ CANTINA_LAN: 'true' }, false);
    expect(env.CANTINA_PORT).toBe(4242);
    expect(env.CANTINA_EARS_PORT).toBe(4243);
    expect(env.CANTINA_LAN).toBe(true);
  });
});
