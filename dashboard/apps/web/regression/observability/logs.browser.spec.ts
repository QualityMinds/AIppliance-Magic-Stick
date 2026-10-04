import {test, expect} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';
import {requireSafe} from '../core/errors.ts';

test('LOG-06 [p1:inert-log-output] logs render as inert text with current, previous and init streams', async ({page}) => {
  const hostile = '<img src=x onerror="window.__regressionLogExecuted=true">' + 'x'.repeat(12_000);
  const logs = {model: 'fixture-cpu', namespace: 'ai', generatedAt: '2026-10-02T00:00:00Z', tailLines: 300,
    pods: [{name: 'fixture-pod', phase: 'Running', deleting: false, containers: [
      {name: 'server', kind: 'application', state: 'running', restartCount: 1, logs: [
        {previous: false, text: hostile, truncated: true}, {previous: true, text: 'Previous startup fixture'},
      ]}, {name: 'download', kind: 'init', state: 'terminated', restartCount: 0, logs: [{previous: false, text: 'Init startup fixture'}]},
    ]}]};
  await fixturePage(page, {'/api/models/fixture-cpu/logs': logs});
  await page.goto(origin + '/#/models');
  await page.getByRole('button', {name: 'View logs for fixture-cpu'}).click();
  const dialog = page.getByRole('dialog', {name: 'Runtime logs · fixture-cpu'});
  await expect(dialog.getByText('Previous run', {exact: true})).toBeVisible();
  await expect(dialog.getByText('Init container', {exact: true})).toBeVisible();
  await expect(dialog.locator('pre')).toHaveCount(3);
  requireSafe((await dialog.locator('pre').first().textContent()) === hostile, 'API');
  requireSafe(!(await page.evaluate(() => Boolean((window as unknown as {__regressionLogExecuted?: boolean}).__regressionLogExecuted))), 'API');
  await expect(dialog.locator('img')).toHaveCount(0);
  await page.setViewportSize({width: 420, height: 800});
  requireSafe(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'API');
  await dialog.getByRole('button', {name: 'Close dialog'}).click();
  await expect(dialog).toHaveCount(0);
});
