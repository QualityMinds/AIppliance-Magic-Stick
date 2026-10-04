import {test, expect} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';

test('NAV-03 [p1:navigation-browser] navigation, help and unsubmitted forms issue no mutations', async ({page}) => {
  let writes = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes++; });
  await fixturePage(page); await page.goto(origin + '/#/overview');
  for (const name of ['Models', 'Services', 'API Access', 'Overview']) {
    await page.getByRole('navigation', {name: 'Dashboard pages'}).getByRole('button', {name, exact: true}).click();
    await expect(page.getByRole('heading', {name: name === 'Models' ? 'Installed Models' : name, exact: true}).first()).toBeVisible();
  }
  await page.getByRole('navigation', {name: 'Dashboard pages'}).getByRole('button', {name: 'Models', exact: true}).click();
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  const create = page.getByRole('dialog', {name: 'Create Model', exact: true});
  await expect(create).toBeVisible(); await create.getByRole('button', {name: 'Close dialog'}).click();
  await expect(create).toHaveCount(0); expect(writes).toBe(0);
});
