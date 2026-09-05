// Optional real-Chrome check of rancher_license_test.py --serve. Test fixture only.
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

(async () => {
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  try {
    const page = await browser.newPage({viewport: {width: 1365, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:18082/#/license');
    await page.getByRole('heading', {name: 'Valid license', exact: true}).waitFor();
    const exported = await (await page.request.get('http://127.0.0.1:18082/api/license/export')).json();
    const file = page.getByLabel('License file', {exact: true});
    await file.setInputFiles({name: 'test-license.json', mimeType: 'application/json', buffer: Buffer.from(exported.content)});
    await page.getByRole('button', {name: 'Validate license', exact: true}).click();
    await page.getByRole('button', {name: 'Activate license', exact: true}).click();
    await page.getByRole('status').filter({hasText: 'License saved.'}).waitFor();
    assert.equal(await file.inputValue(), '');
    await file.setInputFiles({name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{}')});
    await page.getByRole('button', {name: 'Validate license', exact: true}).click();
    const activate = page.getByRole('button', {name: 'Activate license', exact: true});
    await activate.waitFor();
    assert.equal(await activate.isDisabled(), true);
    const preserved = await (await page.request.get('http://127.0.0.1:18082/api/license/export')).json();
    assert.equal(preserved.content, exported.content);
    await page.reload();
    await page.getByRole('heading', {name: 'Valid license', exact: true}).waitFor();
    assert.equal(await page.getByRole('cell', {name: 'Not implemented', exact: true}).count(), 7);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCREENSHOT_DIRECTORY) {
      await page.screenshot({path: `${process.env.SCREENSHOT_DIRECTORY}/license-desktop.png`, fullPage: true});
    }
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.SCREENSHOT_DIRECTORY) {
      await page.screenshot({path: `${process.env.SCREENSHOT_DIRECTORY}/license-mobile.png`, fullPage: true});
    }
    assert.deepEqual(errors, []);
    console.log('PASS: real Chrome upload/preview/activate, invalid-file protection, reload, seven unavailable features, desktop/mobile layout');
  } finally { await browser.close(); }
})().catch(error => {console.error(error.message); process.exitCode = 1;});
