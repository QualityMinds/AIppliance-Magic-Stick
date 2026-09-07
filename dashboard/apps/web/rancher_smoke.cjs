// Invoked by apps/api/rancher_license_test.py --web. All tokens are synthetic.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const base = new URL(process.env.MAGICSTICK_TEST_URL);
  assert.equal(base.hostname, '127.0.0.1', 'The smoke test must stay on loopback.');
  const tokens = JSON.parse(process.env.MAGICSTICK_TEST_TOKENS);
  const get = (path, role) => fetch(new URL(path, base), role ? {headers: {Authorization: `Bearer ${tokens[role]}`}} : {});
  const root = await get('/');
  assert.equal(root.status, 200);
  assert.equal(root.headers.get('cache-control'), 'no-store');
  const html = await root.text();
  assert.match(html, /<title>Magic Stick Dashboard<\/title>/);
  assert.doesNotMatch(html, /Dashboard 2|React Preview/);
  const script = html.match(/src="(\/assets\/[^\"]+\.js)"/)[1];
  const asset = await get(script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal((await get('/assets/does-not-exist.js')).status, 404);
  const deepLink = await get('/nested/client/route');
  assert.equal(deepLink.headers.get('cache-control'), 'no-store');
  assert.equal(await deepLink.text(), html);
  assert.equal((await get('/api/session')).status, 401);
  for (const role of ['admin', 'viewer']) {
    const session = await get('/api/session', role);
    assert.equal(session.status, 200);
    assert.ok((await session.json()).roles.includes(`magicstick-${role}`));
  }
  assert.equal((await get('/api/license', 'viewer')).status, 403);
  const license = await get('/api/license', 'admin');
  assert.equal(license.headers.get('cache-control'), 'no-store');
  assert.equal((await license.json()).valid, true);
  console.log('PASS: primary Service, root SPA, deep links, cache headers, real API proxy and role enforcement');

  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true});
  try {
    const context = await browser.newContext({extraHTTPHeaders: {Authorization: `Bearer ${tokens.admin}`}, viewport: {width: 1440, height: 1000}});
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('/#/license', base).href);
    await page.getByRole('heading', {name: 'AI Appliance Dashboard'}).waitFor();
    await page.getByRole('heading', {name: 'Valid license', exact: true}).waitFor();
    assert.equal(await page.getByRole('link', {name: 'Log out'}).getAttribute('href'), '/logout');
    assert.equal(await page.getByRole('link', {name: 'Open current dashboard'}).count(), 0);
    await page.reload();
    await page.getByRole('heading', {name: 'Valid license', exact: true}).waitFor();
    assert.equal(new URL(page.url()).hash, '#/license');
    await page.getByLabel('License file').setInputFiles({name: 'example-license.json', mimeType: 'application/json', buffer: Buffer.from(process.env.MAGICSTICK_TEST_LICENSE)});
    const previewResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/license/validate' && response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Validate license', exact: true}).click();
    assert.equal((await previewResponse).status(), 200, 'Browser license validation must pass same-origin and CSRF checks.');
    await page.getByRole('heading', {name: 'Import preview', exact: true}).waitFor();
    const activationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/license' && response.request().method() === 'PUT');
    await page.getByRole('button', {name: 'Activate license', exact: true}).click();
    assert.equal((await activationResponse).status(), 200, 'Browser license activation must succeed through the real API proxy.');
    await page.getByRole('status').filter({hasText: 'License saved.'}).waitFor();
    assert.equal((await (await get('/api/license', 'admin')).json()).valid, true);
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'No horizontal page overflow on mobile.');
    assert.deepEqual(errors, []);
    await context.close();
    console.log('PASS: Chrome signed-file upload/preview/activation, standard branding, deep-link/reload, logout and mobile layout');

    const viewer = await browser.newContext({extraHTTPHeaders: {Authorization: `Bearer ${tokens.viewer}`}});
    const viewerPage = await viewer.newPage();
    let requestedLicense = false;
    viewerPage.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/license')) requestedLicense = true; });
    await viewerPage.goto(new URL('/#/license', base).href);
    await viewerPage.getByRole('heading', {name: 'AI Appliance Dashboard'}).waitFor();
    await viewerPage.waitForURL('**/#/overview');
    for (const name of ['Settings', 'Users', 'API Access', 'Kubernetes Access', 'License & Enterprise']) {
      assert.equal(await viewerPage.getByRole('button', {name, exact: true}).count(), 0);
    }
    assert.equal(requestedLicense, false);
    await viewer.close();
    console.log('PASS: Chrome viewer cannot open or fetch admin-only pages');
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
