import { describe, expect, it } from 'vitest';
import { compareVersions, formatResults, runDoctor } from './doctor.ts';
import { loadEnv } from './env.ts';

describe('doctor', () => {
  it('compares versions', () => {
    expect(compareVersions('v22.12.0', '22.12.0')).toBe(0);
    expect(compareVersions('22.11.9', '22.12.0')).toBeLessThan(0);
    expect(compareVersions('v24.0.0', '22.12.0')).toBeGreaterThan(0);
  });

  it('runs offline and reports Discord items as pending when unset', async () => {
    const env = loadEnv({ CANTINA_DATA_DIR: '' }, false);
    const results = await runDoctor({ env, online: false });
    const byName = new Map(results.map((r) => [r.name, r]));
    expect(byName.get('Node.js ≥ 22.12')?.status).toBe('ok');
    expect(byName.get('Config files')?.status).toBe('ok');
    expect(byName.get('Discord token')?.status).toBe('pending');
    expect(byName.get('.env values')?.status).toBe('pending');
    expect(formatResults(results, false)).toContain('Node.js');
  });
});
