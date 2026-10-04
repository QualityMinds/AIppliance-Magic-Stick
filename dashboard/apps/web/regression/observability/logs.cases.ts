import {test, expect} from '@playwright/test';
import type {CpuScenario} from '../core/cpu-scenario.ts';
import {activation} from '../core/owned-model.ts';
import {requireSafe} from '../core/errors.ts';

/** Registered inside one explicit serial workflow; not standalone cross-file dependencies. */
export function registerReadyLogs(s: CpuScenario) {
  const title = s.title;
  test(title('LOG-01', 'ready-runtime-logs', 'owned Ready Pod logs refresh and close through the browser'), async () => {
    const {heartbeat, config, context, model, name} = s;
    await heartbeat(); const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: `View logs for ${name}`}).click();
      const dialog = page.getByRole('dialog', {name: `Runtime logs · ${name}`});
    await expect(dialog.locator('pre').first()).toBeVisible();
    const logs = await model.logs();
    requireSafe(logs.model === name && logs.pods.length > 0, 'API');
      const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/logs`);
      await dialog.getByRole('button', {name: 'Refresh', exact: true}).click(); await refreshed;
      await dialog.getByRole('button', {name: 'Close dialog'}).click();
      await expect(dialog).toHaveCount(0);
    } finally { await page.close(); }
  });
}

export function registerLogTransport(s: CpuScenario) {
  const title = s.title;
  test(title('LOG-05', 'text-log-transport', 'real owned-container text is returned without a 406 negotiation error', 'A'), async () => {
    const {heartbeat, model, name, uid, modelState} = s;
    await heartbeat(); const state = await modelState(), logs = await model.logs();
    requireSafe(logs.model === name && logs.tailLines === 300 && logs.pods.length > 0 &&
      logs.pods.every(pod => state.pods.some(observed => observed.metadata.name === pod.name)), 'API');
    requireSafe(logs.pods.some(pod => pod.containers.some(container => container.logs.some(log =>
      !log.previous && log.text.trim().length > 0 && !log.error))) &&
      logs.pods.every(pod => pod.containers.every(container => container.logs.every(log =>
        typeof log.text === 'string' && log.text.length <= 2 * 1024 * 1024 && !log.error?.includes('406')))), 'API');
    // The separate JSON model read must still decode after the text transport.
    requireSafe(activation(await model.models(), name)?.metadata?.uid === uid, 'API');
  });
}
