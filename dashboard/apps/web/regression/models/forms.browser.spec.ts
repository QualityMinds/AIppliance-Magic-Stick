import {test, expect, type Request} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';

test('UX-02 [p1:forms-browser] isolated browser wiring verifies the CPU edit draft and default Advanced state', async ({page}) => {
  let estimates = 0;
  await fixturePage(page, {
    '/api/models/fixture-cpu/estimate-memory': (request: Request) => {
      expect(request.method()).toBe('POST'); estimates++;
      return {minimumMi: 1024, recommendedMi: 2048, maximumMi: 16384, confidence: 'high', weightsMi: 512, kvCacheMi: 256, reserveMi: 256};
    },
  });
  await page.goto(origin + '/#/models');
  await page.getByRole('button', {name: 'Edit fixture-cpu', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Edit Model · fixture-cpu'}), field = dialog.getByLabel('Context Size');
  const save = dialog.getByRole('button', {name: 'Save changes', exact: true});
  await expect(field).toHaveValue('2048'); await expect(save).toBeDisabled();
  const advanced = dialog.locator('details').filter({has: page.locator('summary').filter({hasText: /^Advanced$/})});
  await expect(advanced).toHaveCount(1); expect(await advanced.getAttribute('open')).toBeNull();
  await field.fill('1024'); await expect(save).toBeEnabled();
  await field.fill('2048'); await expect(save).toBeDisabled();
  await field.fill('0'); await expect(save).toBeDisabled();
  await dialog.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(dialog).toHaveCount(0); expect(estimates).toBeGreaterThan(0);
});
