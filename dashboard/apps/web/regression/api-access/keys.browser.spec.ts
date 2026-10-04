import {test, expect, type Request} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

test('KEY-01 KEY-03 isolated browser wiring creates, clears and revokes a synthetic one-time key', evidenceAnnotations(
  {id: 'KEY-01', variant: 'keys-browser-create', layer: 'B'}, {id: 'KEY-03', variant: 'keys-browser-revoke', layer: 'B'}), async ({page}) => {
  const id = 'fixture-key-1234567890', name = 'fixture-browser-key', secret = 'sk-synthetic-browser-fixture';
  let present = false, writes = 0;
  await fixturePage(page, {
    '/api/api-access': (request: Request) => {
      if (request.method() === 'POST') {
        expect(request.postDataJSON()).toEqual({name}); present = true; writes++;
        return {id, key: secret, name};
      }
      expect(request.method()).toBe('GET');
      return {total: present ? 1 : 0, items: present ? [{id, name, status: 'active'}] : []};
    },
    [`/api/api-access/${id}`]: (request: Request) => {
      expect(request.method()).toBe('DELETE'); expect(request.postData()).toBeNull();
      present = false; writes++; return {status: 'revoked'};
    },
  });
  await page.goto(origin + '/#/api-access');
  await page.getByRole('button', {name: 'Create API Key', exact: true}).click();
  const create = page.getByRole('dialog', {name: 'Create API Key', exact: true});
  await create.getByLabel('Name', {exact: true}).fill(name);
  await create.getByRole('button', {name: 'Create Key', exact: true}).click();
  const created = page.getByRole('dialog', {name: 'API key created', exact: true});
  await expect(created.getByText(secret, {exact: true})).toBeVisible();
  await created.getByRole('button', {name: 'Done', exact: true}).click();
  await page.getByRole('button', {name: 'Refresh', exact: true}).click();
  await page.reload();
  await expect(page.getByRole('row').filter({hasText: name})).toBeVisible();
  expect(await page.content()).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify({local: {...localStorage}, session: {...sessionStorage}}))).not.toContain(secret);
  await page.getByRole('row').filter({hasText: name}).getByRole('button', {name: 'Revoke', exact: true}).click();
  const revoke = page.getByRole('dialog', {name: 'Revoke API key', exact: true});
  await revoke.getByRole('button', {name: 'Revoke', exact: true}).click();
  await expect(revoke).toHaveCount(0);
  await expect(page.getByRole('row').filter({hasText: name})).toHaveCount(0);
  expect(writes).toBe(2);
});
