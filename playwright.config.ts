import fs from 'node:fs';
import { defineConfig } from '@playwright/test';

// Use the pre-installed Chromium when present (cloud sessions); otherwise Playwright's own.
const executablePath = fs.existsSync('/opt/pw-browsers/chromium')
  ? '/opt/pw-browsers/chromium'
  : undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://127.0.0.1:4310',
    viewport: { width: 1440, height: 900 },
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'npm run build -w @cantina/dashboard && npx tsx tests/e2e/demo-server.ts',
    url: 'http://127.0.0.1:4310/api/health',
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
