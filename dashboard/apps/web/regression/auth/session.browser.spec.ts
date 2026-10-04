import {test, expect} from '@playwright/test';
import {fixturePage, origin} from '../fixtures/dashboard.ts';

test('AUTH-06 [p1:logout-browser] logout control leaves privileged UI; denied reload cannot show cached controls', async ({page}) => {
  await fixturePage(page); await page.goto(origin + '/#/api-access');
  await expect(page.getByRole('button', {name: 'Create API Key', exact: true})).toBeVisible();
  await page.route(origin + '/logout', route => route.fulfill({status: 200, contentType: 'text/html', body: '<h1>Signed out fixture</h1>'}));
  await page.getByRole('link', {name: 'Log out'}).click(); await expect(page.getByRole('heading', {name: 'Signed out fixture'})).toBeVisible();
  await page.route(origin + '/api/session', route => route.fulfill({status: 401, contentType: 'application/json', body: '{"error":"Unauthenticated"}'}));
  await page.goto(origin + '/#/api-access'); await page.reload();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', {name: 'Create API Key', exact: true})).toHaveCount(0);
});
