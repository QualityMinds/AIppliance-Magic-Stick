import {expect, test} from '@playwright/test';

// Synthetic application resources; no live cluster or provider mutation.
test('creates and opens the Pi service configuration without layout overflow', async ({page}) => {
  const writes: Array<{path: string; body: Record<string, unknown>}> = [];
  let instances: Record<string, unknown[]> = {};
  const modules = {
    modules: Object.fromEntries(['pi-coding', 'litellm', 'model-catalog'].map(name => [name, {
      enabled: true, activationMode: 'moduleactivation', status: {phase: 'Ready'},
    }])),
    catalogJson: {
      applications: {'pi-coding': {displayName: 'Pi Coding Agent', requiredModules: ['pi-coding', 'litellm', 'model-catalog']}},
      modules: {'pi-coding': {displayName: 'Pi Coding Agent', group: 'apps', activationMode: 'moduleactivation'},
        litellm: {displayName: 'LiteLLM', group: 'runtime'}, 'model-catalog': {displayName: 'Model Catalog', group: 'runtime'}},
    },
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let value: unknown;
    if (request.method() !== 'GET') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({path, body});
      expect(path).toBe('/api/instances/pi-coding');
      const instance = {metadata: {name: `pi-coding-${body.name}`},
        spec: {application: 'pi-coding', enabled: true, targetNamespace: 'ai', values: body, access: body.access},
        status: {phase: 'Ready', localURL: `https://${body.name}.pi-coding.example.local/`}};
      instances = {'pi-coding': [instance]};
      value = instance;
    } else if (path === '/api/session') value = {
      authenticated: true, subject: 'fixture-operator', username: 'example-operator', roles: ['magicstick-operator'],
      identityManagementAvailable: false, identityManagementMode: 'external', csrfToken: 'synthetic-csrf',
    };
    else if (path === '/api/modules') value = modules;
    else if (path === '/api/instances') value = {instances};
    else if (path === '/api/models') value = {models: [{id: 'local-coder', type: 'chat'}]};
    else if (path === '/api/status') value = {httpRoutes: [], hardwareOperators: {}};
    else if (path === '/api/settings') value = {publicDomain: 'example.com', mdnsDomain: 'example.local'};
    else if (path === '/api/license') value = {state: 'missing', valid: false, features: []};
    else value = {};
    await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(value)});
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#/services');
  await expect(page.getByRole('heading', {name: 'Pi Coding Agent'})).toBeVisible();
  expect(writes).toEqual([]);
  await page.getByRole('button', {name: 'New Instance'}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Instance'});
  await expect(dialog.getByLabel('Application')).toHaveValue('pi-coding');
  await expect(dialog.getByLabel('Model')).toHaveValue('local-coder');
  await expect(dialog.getByLabel('Access')).toHaveValue('sso');
  await dialog.getByLabel('Name', {exact: true}).fill('project');
  await dialog.getByLabel('Name', {exact: true}).press('Tab');
  await expect(dialog.getByLabel('Model')).toBeFocused();
  await expect(dialog.locator('details')).not.toHaveAttribute('open', '');
  await dialog.getByText('Configure', {exact: true}).click();
  await expect(dialog.getByLabel('Storage')).toHaveValue('5Gi');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await dialog.getByRole('button', {name: 'Create Pi Coding Agent'}).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.body).toMatchObject({model: 'local-coder', storage: {size: '5Gi'},
    access: {authentication: 'sso', role: 'user'}, ingress: {host: 'project.pi-coding.example.com', enabled: false}});
  await page.getByRole('button', {name: /Show/}).first().click();
  await expect(page.getByText('pi-coding-project', {exact: true})).toBeVisible();
  await expect(page.getByRole('link', {name: 'project.pi-coding.example.local', exact: true})).toHaveAttribute('href', 'https://project.pi-coding.example.local/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
