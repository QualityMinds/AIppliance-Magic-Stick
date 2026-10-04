import {test, expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import type {CpuScenario} from '../core/cpu-scenario.ts';
import {readOnlyApi} from '../core/transport.ts';
import {requireSafe} from '../core/errors.ts';

/** Registered inside one explicit serial workflow; not standalone cross-file dependencies. */
export function registerNavigation(s: CpuScenario) {
  const title = s.title;
  test(title('NAV-03', 'read-only-navigation', 'pages, unsubmitted forms, help and polling do not change runtime intent'), async () => {
    const {heartbeat, config, context, observer} = s;
    await heartbeat();
    const api = readOnlyApi(context!.request, config.dashboardUrl, config.requestTimeoutMs);
    const fingerprint = async () => {
      const [models, modules, instances, hosts, pods] = await Promise.all([
        api.models(), api.modules(), api.instances(), api.hostManagement(), observer.list('pods'),
      ]);
      return createHash('sha256').update(JSON.stringify({
        models: models.activations.map(item => ({uid: item.metadata?.uid, generation: item.metadata?.generation, spec: item.spec})),
        modules: Object.entries(modules.modules).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) =>
          ({id, enabled: item.enabled, parameters: item.parameters})),
        instances: Object.fromEntries(Object.entries(instances.instances ?? {}).map(([id, items]) => [id,
          items.map(item => ({uid: item.metadata?.uid, generation: item.metadata?.generation, spec: item.spec}))])),
        operations: hosts.nodes.map(host => ({name: host.name, operation: host.operation?.requestId})),
        pods: pods.map(pod => pod.metadata.uid).sort(),
      })).digest('hex');
    };
    const before = await fingerprint(), writesBefore = s.blockedWrites;
    const page = await context!.newPage(); let errors = 0;
    page.on('pageerror', () => { errors++; });
    try {
      for (const [route, heading] of [
        ['overview', 'Overview'], ['models', 'Installed Models'], ['services', 'Services'],
        ['api-access', 'API Access'], ['system/status', 'System Status'], ['system/hardware', 'Hardware'],
      ]) {
        await page.goto(config.dashboardUrl + '/#/' + route, {waitUntil: 'domcontentloaded'});
        await expect(page.getByRole('heading', {name: heading, exact: true}).first()).toBeVisible();
        // Expansion and help are pure reads, even on a mixed-vendor appliance.
        const summaries = page.locator('details > summary');
        for (let index = 0; index < Math.min(await summaries.count(), 3); index++) {
          if (await summaries.nth(index).isVisible()) await summaries.nth(index).click();
        }
        const help = page.getByRole('button', {name: /^Explain /}).first();
        if (await help.count() && await help.isVisible()) {
          await help.click();
          const close = page.getByRole('button', {name: 'Close explanation'});
          if (await close.isVisible()) await close.click();
        }
      }
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: 'Create', exact: true}).click();
      const create = page.getByRole('dialog', {name: 'Create Model', exact: true});
      await expect(create).toBeVisible();
      await create.getByRole('button', {name: 'Close dialog'}).click();
      await page.waitForResponse(response => new URL(response.url()).pathname === '/api/models' &&
        response.request().method() === 'GET', {timeout: 25_000});
    } finally { await page.close(); }
    requireSafe(errors === 0 && s.blockedWrites === writesBefore && await fingerprint() === before, 'MUTATION');
  });
}
