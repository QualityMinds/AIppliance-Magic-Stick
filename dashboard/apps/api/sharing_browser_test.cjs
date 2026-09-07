// SPDX-License-Identifier: MIT
// Real Chrome checks against the built frontend with explicit synthetic API fixtures.
// Backend/SSO enforcement is tested separately by rancher_sharing_test.py.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const {createServer} = require('node:http');
const {readFile} = require('node:fs/promises');
const {resolve, extname} = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const dist = resolve(__dirname, '../web/dist');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    const file = resolve(dist, '.' + (path === '/' ? '/index.html' : path));
    if (!file.startsWith(dist + '/')) {res.writeHead(404); res.end(); return;}
    try {res.setHeader('Content-Type', {'.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html'}[extname(file)] || 'application/octet-stream'); res.end(await readFile(file));}
    catch {res.writeHead(404); res.end();}
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  let page;
  try {
    page = await browser.newPage({viewport: {width: 1365, height: 1000}});
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let role = 'admin', update;
    const feature = {id: 'resource-sharing', name: 'Targeted access', available: true, implemented: true, licensed: true, reason: 'available'};
    const instance = {metadata: {name: 'hermes-example'}, spec: {application: 'hermes', targetNamespace: 'ai', access: {authentication: 'sso', role: 'user'}}, status: {phase: 'Ready', localURL: 'https://example.hermes.example.local/'}};
    await page.route('**/api/**', async route => {
      const req = route.request(), url = new URL(req.url()); let data = {};
      if (url.pathname === '/api/session') data = {subject: role, username: 'Example', roles: [`magicstick-${role}`], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
      if (url.pathname === '/api/modules') data = {catalogJson: {modules: {'hermes-operator': {displayName: 'Hermes', group: 'apps', activationMode: 'moduleactivation'}}, applications: {hermes: {displayName: 'Hermes', requiredModules: ['hermes-operator']}}}, modules: {'hermes-operator': {enabled: true, phase: 'Ready', activationMode: 'moduleactivation'}}};
      if (url.pathname === '/api/instances') data = {items: [instance], instances: {hermes: [instance]}};
      if (url.pathname === '/api/models') data = {models: [{id: 'example-model', type: 'chat'}]};
      if (url.pathname === '/api/status') data = {routes: [], pods: []};
      if (url.pathname === '/api/settings') data = {publicDomain: 'example.com', mdnsDomain: 'example.local'};
      if (url.pathname === '/api/license') data = {state: 'missing', valid: false, message: 'Community mode.', installationId: 'example-installation', revision: '1', checkedAt: 1, hasDocument: false, trustedKeyIds: [], features: [feature]};
      if (url.pathname === '/api/instance-principals') data = {kind: url.searchParams.get('kind'), items: [{id: url.searchParams.get('kind') === 'groups' ? 'group-id' : 'user-id', name: url.searchParams.get('kind') === 'groups' ? '/Example Team' : 'Example User'}], next: null};
      if (url.pathname.endsWith('/access')) {
        if (req.method() === 'PUT') update = req.postDataJSON();
        data = {name: 'hermes-example', revision: '4', sharing: {mode: 'all', users: [], groups: []}, authentication: 'sso', guardReady: true, feature};
      }
      if (url.pathname === '/api/my-instances') data = {items: [{name: 'hermes-example', application: 'hermes', phase: 'Ready', urls: [instance.status.localURL]}]};
      await route.fulfill({json: data});
    });
    await page.goto(base + '/#/services');
    await page.getByRole('button', {name: '▸ Show', exact: true}).click();
    await page.getByRole('button', {name: 'Sharing', exact: true}).click();
    await page.getByLabel('Visible and accessible to', {exact: true}).selectOption('selected');
    await page.getByRole('button', {name: '+ Example User', exact: true}).click();
    await page.getByLabel('Search directory', {exact: true}).selectOption('groups');
    await page.getByRole('button', {name: '+ /Example Team', exact: true}).click();
    assert.equal(await page.getByRole('button', {name: 'Save sharing', exact: true}).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCREENSHOT_DIRECTORY) await page.screenshot({path: `${process.env.SCREENSHOT_DIRECTORY}/instance-sharing-desktop.png`, fullPage: true});
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCREENSHOT_DIRECTORY) await page.screenshot({path: `${process.env.SCREENSHOT_DIRECTORY}/instance-sharing-mobile.png`, fullPage: true});
    await page.getByRole('checkbox').check();
    await page.getByRole('button', {name: 'Save sharing', exact: true}).click();
    await page.getByRole('dialog').waitFor({state: 'hidden'});
    assert.deepEqual(update, {sharing: {mode: 'selected', users: ['user-id'], groups: ['group-id']}, expectedRevision: '4'});
    await page.goto(base + '/#/license');
    await page.getByRole('heading', {name: 'Software licenses', exact: true}).waitFor();
    await page.context().setOffline(true);
    for (const [title, filename, source] of [
      ['Licensing overview', 'LICENSING.md', '../../../LICENSING.md'],
      ['Community · MIT License', 'MagicStick-MIT.txt', '../../../LICENSE'],
      ['Enterprise · Provisional notice', 'MagicStick-Enterprise.txt', '../../../enterprise/LICENSE'],
    ]) {
      await page.getByText(title, {exact: true}).click();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('link', {name: `Download ${title}`, exact: true}).click(),
      ]);
      assert.equal(download.suggestedFilename(), filename);
      assert.equal(await readFile(await download.path(), 'utf8'), await readFile(resolve(__dirname, source), 'utf8'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByText(title, {exact: true}).click();
    }
    await page.context().setOffline(false);
    role = 'user'; await page.reload();
    await page.getByRole('heading', {name: 'My instances', exact: true}).waitFor();
    assert.equal(await page.getByRole('button', {name: 'Services', exact: true}).count(), 0);
    assert.equal(await page.getByRole('link', {name: 'example.hermes.example.local', exact: true}).count(), 1);
    assert.deepEqual(errors, []);
    console.log('PASS: real Chrome user/group selection, explicit confirmation/CAS payload, desktop/mobile layout, exact offline license downloads and basic-user launchpad.');
  } catch (error) {
    console.error((await page.locator('body').innerText()).slice(-3500));
    if (process.env.SCREENSHOT_DIRECTORY) await page.screenshot({path: `${process.env.SCREENSHOT_DIRECTORY}/failure.png`, fullPage: true});
    throw error;
  } finally {await browser.close(); await new Promise(done => server.close(done));}
})().catch(error => {console.error(error.message); process.exitCode = 1;});
