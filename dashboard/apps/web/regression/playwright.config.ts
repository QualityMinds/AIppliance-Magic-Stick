import {defineConfig} from '@playwright/test';
import {join} from 'node:path';
import {selections} from './profiles/selections.ts';
import {requireSafe} from './core/errors.ts';

const mode = process.env.REGRESSION_MODE ?? 'preflight';
requireSafe(Object.hasOwn(selections, mode), 'CONFIG');

export default defineConfig({
  testDir: '.',
  testMatch: selections[mode],
  forbidOnly: true,
  workers: 1,
  retries: 0,
  timeout: ['smoke-fast', 'phase2-fast'].includes(mode) ? 240_000 :
    ['selftest', 'smoke-fixtures', 'phase2-fixtures'].includes(mode) ? 45_000 :
      ['smoke', 'model-edit', 'core-smoke', 'phase2-models', 'phase2-faults', 'recover', 'foundations'].includes(mode) ? 1_200_000 : 240_000,
  globalTimeout: ['smoke-fast', 'phase2-fast'].includes(mode) ? 900_000 :
    ['selftest', 'smoke-fixtures', 'phase2-fixtures'].includes(mode) ? 240_000 :
      ['smoke', 'model-edit', 'core-smoke', 'phase2-models', 'phase2-faults', 'recover', 'foundations'].includes(mode) ? 7_200_000 : 300_000,
  reporter: [['./reporter.ts']],
  // Playwright clears outputDir at startup: never put the durable journal there.
  outputDir: process.env.REGRESSION_RUN_DIR ? join(process.env.REGRESSION_RUN_DIR, 'browser-temp') : '.regression-output',
  use: {browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off',
    serviceWorkers: 'block', acceptDownloads: false},
});
