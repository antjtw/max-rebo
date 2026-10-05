import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/core/src/**/*.test.ts',
      'apps/dashboard/src/**/*.test.{ts,tsx}',
      'tests/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 15000,
  },
});
