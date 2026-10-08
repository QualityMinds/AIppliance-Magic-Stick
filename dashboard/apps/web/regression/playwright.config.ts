import {defineConfig} from '@playwright/test';
import {join} from 'node:path';
import {selections} from './profiles/selections.ts';
import {requireSafe} from './core/errors.ts';
import {loadBrowserDns} from './core/browser-dns.ts';

const mode = process.env.REGRESSION_MODE ?? 'preflight';
requireSafe(Object.hasOwn(selections, mode), 'CONFIG');
const browserArguments=await loadBrowserDns();

export default defineConfig({
  testDir: '.',
  testMatch: selections[mode],
  forbidOnly: true,
  workers: 1,
  // Each live test rechecks identity, the Lease and idle/recovery state.
  // A missing prerequisite must not cancel independent test cases.
  maxFailures: 0,
  retries: 0,
  timeout: mode==='campaign-recover'?900_000:/^phase[5-8]-fast$/.test(mode) ? 600_000 : /^phase[5-8]-fixtures$/.test(mode) ? 120_000 : /^phase[5-8]-live$/.test(mode) || mode === 'phase6-drill' ? 3_600_000 : ['smoke-fast', 'phase2-fast','phase3-fast','phase4-fast'].includes(mode) ? 600_000 :
    ['selftest', 'smoke-fixtures', 'phase2-fixtures','phase3-fixtures','phase4-fixtures'].includes(mode) ? 60_000 :
      ['phase3-gpu','phase3-validation','phase4-sharing','gpu-recover'].includes(mode) ? 3_600_000 :
      ['smoke', 'model-edit', 'core-smoke', 'phase2-models', 'phase2-faults', 'recover', 'foundations'].includes(mode) ? 1_200_000 : 240_000,
  globalTimeout: mode==='campaign-recover'?1_200_000:/^phase[5-8]-fast$/.test(mode) ? 1_800_000 : /^phase[5-8]-fixtures$/.test(mode) ? 900_000 : /^phase[5-8]-live$/.test(mode) || mode === 'phase6-drill' ? 10_800_000 : ['smoke-fast', 'phase2-fast','phase3-fast','phase4-fast'].includes(mode) ? 1_800_000 :
    ['selftest', 'smoke-fixtures', 'phase2-fixtures','phase3-fixtures','phase4-fixtures'].includes(mode) ? 300_000 :
      ['phase3-gpu','phase3-validation','phase4-sharing','gpu-recover'].includes(mode) ? 10_800_000 :
      ['smoke', 'model-edit', 'core-smoke', 'phase2-models', 'phase2-faults', 'recover', 'foundations'].includes(mode) ? 7_200_000 : 300_000,
  reporter: [['./reporter.ts']],
  // Playwright clears outputDir at startup: never put the durable journal there.
  outputDir: process.env.REGRESSION_RUN_DIR ? join(process.env.REGRESSION_RUN_DIR, 'browser-temp') : '.regression-output',
  use: {browserName: 'chromium', headless: true, trace: 'off', video: 'off', screenshot: 'off',
    launchOptions:{args:browserArguments},
    serviceWorkers: 'block', acceptDownloads: false},
});
