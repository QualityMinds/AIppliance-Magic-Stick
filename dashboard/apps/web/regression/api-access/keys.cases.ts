import {test, expect} from '@playwright/test';
import type {CpuScenario} from '../core/cpu-scenario.ts';
import {InferenceProbe} from '../core/inference.ts';
import {requireSafe} from '../core/errors.ts';

/** Registered inside one explicit serial workflow; not standalone cross-file dependencies. */
export function registerKeyCreation(s: CpuScenario) {
  const title = s.title;
  test(title('KEY-01', 'ui-key-create', 'browser creates one journal-owned inference key'), async () => {
    const {heartbeat, config, context, journal, keys} = s;
    await heartbeat(); s.keyName = journal.prefix + 'smoke-key';
    await journal.requested('key', s.keyName);
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/api-access', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: 'Create API Key', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: 'Create API Key', exact: true});
      await dialog.getByLabel('Name', {exact: true}).fill(s.keyName);
      s.allowedKeyName = s.keyName;
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/api-access' &&
        response.request().method() === 'POST');
      await dialog.getByRole('button', {name: 'Create Key', exact: true}).click();
      const response = await responsePromise; requireSafe(response.status() === 201, 'API');
      const key = keys.adoptCredential(s.keyName, await response.json());
      await journal.owned('key', s.keyName, key.id); s.keyId = key.id; s.keySecret = key.secret;
      await expect(page.getByRole('dialog', {name: 'API key created', exact: true})).toBeVisible();
      requireSafe((await page.getByRole('dialog', {name: 'API key created', exact: true}).innerText()).includes(key.secret), 'API');
      await page.getByRole('dialog', {name: 'API key created', exact: true}).getByRole('button', {name: 'Done', exact: true}).click();
    } finally { s.allowedKeyName = undefined; await page.close(); }
  });
}

export function registerKeySecrecy(s: CpuScenario) {
  const title = s.title;
  test(title('KEY-01', 'one-time-key', 'close, refresh and new tab retain metadata but not the raw key'), async () => {
    const {heartbeat, config, context, keys} = s;
    await heartbeat(); requireSafe(s.keySecret && s.keyId, 'CONFIG');
    const metadata = await keys.list();
    requireSafe(metadata.items.some(item => item.id === s.keyId && item.name === s.keyName) &&
      !JSON.stringify(metadata).includes(s.keySecret), 'API');
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/api-access', {waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('row').filter({hasText: s.keyName})).toBeVisible();
      await page.getByRole('button', {name: 'Refresh', exact: true}).click();
      await page.reload({waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('row').filter({hasText: s.keyName})).toBeVisible();
      requireSafe(!(await page.content()).includes(s.keySecret), 'API');
      const storage = await page.evaluate(() => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}}));
      requireSafe(!storage.includes(s.keySecret), 'API');
    } finally { await page.close(); }
  });
}

export function registerKeyRevocation(s: CpuScenario) {
  const title = s.title;
  test(title('KEY-03', 'ui-key-revoke', 'browser revokes exactly the owned key while another owned key still infers'), async () => {
    const {heartbeat, config, context, journal, keys, name} = s;
    await heartbeat(); requireSafe(s.keyId && s.keySecret, 'CONFIG');
    const page = await context!.newPage(); s.allowedKeyId = s.keyId;
    try {
      await page.goto(config.dashboardUrl + '/#/api-access', {waitUntil: 'domcontentloaded'});
      await page.getByRole('row').filter({hasText: s.keyName}).getByRole('button', {name: 'Revoke', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: 'Revoke API key', exact: true});
      const revoked = page.waitForResponse(response => new URL(response.url()).pathname === `/api/api-access/${s.keyId}` &&
        response.request().method() === 'DELETE');
      await dialog.getByRole('button', {name: 'Revoke', exact: true}).click(); requireSafe((await revoked).status() === 200, 'API');
      await expect(dialog).toHaveCount(0);
    } finally { s.allowedKeyId = undefined; await page.close(); }
    requireSafe(!(await keys.list()).items.some(item => item.id === s.keyId), 'API');
    const spareName = journal.prefix + 'verify-key'; await journal.requested('key', spareName);
    const spare = await keys.createCredential(spareName); await journal.owned('key', spareName, spare.id);
    await new InferenceProbe(context!.request, config.inferenceUrl!, spare.secret).chat(name);
  });
}
