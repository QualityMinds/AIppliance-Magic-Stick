import {defineConfig} from '@playwright/test';
import {join} from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: process.env.REGRESSION_MODE === 'selftest' ? 'fixtures/harness.spec.ts' :
    process.env.REGRESSION_MODE === 'locktest' ? 'live-lock.spec.ts' :
    process.env.REGRESSION_MODE === 'ownedtest' ? 'live-owned.spec.ts' :
    process.env.REGRESSION_MODE === 'recover' ? 'recovery.spec.ts' :
    process.env.REGRESSION_MODE === 'smoke' ? 'smoke.spec.ts' : 'phase0.spec.ts',
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: process.env.REGRESSION_MODE === 'selftest' ? 30_000 : ['smoke', 'recover'].includes(process.env.REGRESSION_MODE ?? '') ? 1_200_000 : 240_000,
  globalTimeout: process.env.REGRESSION_MODE === 'selftest' ? 180_000 : ['smoke', 'recover'].includes(process.env.REGRESSION_MODE ?? '') ? 2_400_000 : 300_000,
  reporter: [['./reporter.ts']],
  // Playwright clears outputDir at startup: never put the durable journal there.
  outputDir: process.env.REGRESSION_RUN_DIR ? join(process.env.REGRESSION_RUN_DIR, 'browser-temp') : '.regression-output',
  use: {browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off',
    serviceWorkers: 'block', acceptDownloads: false},
});
