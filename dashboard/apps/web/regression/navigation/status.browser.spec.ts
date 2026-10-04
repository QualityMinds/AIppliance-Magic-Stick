import {test, expect} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';

test('NAV-06 [p1:failed-status] real browser preserves module, Flux and model failure causes', async ({page}) => {
  await fixturePage(page);
  await page.goto(origin + '/#/overview');
  await expect(page.getByText('Fixture module health failed', {exact: true})).toBeVisible();
  await expect(page.getByText('FixtureReconcileFailed', {exact: true})).toBeVisible();
  await expect(page.getByText('ImagePullBackOff: controlled fixture', {exact: true}).first()).toBeVisible();
  await page.getByRole('navigation', {name: 'Dashboard pages'}).getByRole('button', {name: 'Models', exact: true}).click();
  await expect(page.getByText('Degraded', {exact: true})).toBeVisible();
  const progress = page.getByRole('progressbar');
  await expect(progress).toBeVisible();
  expect(await progress.getAttribute('aria-valuenow')).not.toBe('100');
  await expect(page.getByText('ImagePullBackOff: controlled fixture', {exact: true}).first()).toBeVisible();
});

test('NAV-06 [p1:unknown-memory] missing readings stay unknown, not zero or fully available', async ({page}) => {
  await fixturePage(page);
  await page.goto(origin + '/#/models');
  const gauge = page.getByRole('article', {name: 'Fixture NVIDIA memory'});
  await expect(gauge).toBeVisible();
  await expect(gauge.getByLabel('Not reported')).toHaveCount(4);
  expect(await gauge.locator('[data-known="false"]').count()).toBe(2);
  expect(await gauge.locator('.gauge-progress').count()).toBe(0);
  expect(await gauge.innerText()).not.toContain('0 MiB');
});
