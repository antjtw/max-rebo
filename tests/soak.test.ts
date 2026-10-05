import { describe, expect, it } from 'vitest';
import { soak } from './soak.ts';

describe('soak (short)', () => {
  it('runs 20 simulated minutes with stable voices and no frame drift', () => {
    const r = soak(1 / 3);
    expect(r.frames).toBe(r.expectedFrames);
    expect(r.triggersFired).toBeGreaterThan(10);
    expect(r.voicesAtEnd).toBeLessThanOrEqual(1 + 3 + 8 + 1);
    expect(r.heapEndMb - r.heapStartMb).toBeLessThan(30);
  }, 120_000);
});
