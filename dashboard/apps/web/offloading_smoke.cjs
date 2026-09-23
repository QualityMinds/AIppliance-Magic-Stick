// Chrome UI smoke test against a loopback Vite server. All API data is synthetic.
const assert = require('node:assert/strict');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const base = new URL(process.env.MAGICSTICK_TEST_URL || 'http://127.0.0.1:5179');
  assert.equal(base.hostname, '127.0.0.1', 'Keep this synthetic smoke test on loopback.');
  const models = {activations: [], presets: {}, models: [], computeTargets: {targets: [
    {id: 'nvidia-gpu', displayName: 'NVIDIA GPU', kind: 'gpu', available: true, engines: ['VLLM', 'OLlama']},
  ]}, computeMemory: {devices: [{id: 'gpu-1', name: 'Example GPU', computeTarget: 'nvidia-gpu', unreservedMi: 12000, totalMi: 24000, freeMi: 12000}]}};
  const estimate = {minimumMi: 15000, recommendedMi: 18000, maximumMi: 12000, computeTarget: 'nvidia-gpu', weightsMi: 12000, kvCacheMi: 2000, reserveMi: 1000, recommendedReserveMi: 1000};
  const plan = {enabled: true, mode: 'weights', vramBudgetMi: 12000, weightsOnGpuMi: 8000, weightsOnCpuMi: 4000,
    kvOnGpuMi: 2000, kvOnCpuMi: 0, hostRuntimeMi: 6144, ramMinimumMi: 10200, ramRecommendedMi: 12300,
    ramMaximumMi: 32000, gpuMinimumMi: 11000, gpuRecommendedMi: 12000, fitsVram: true, estimated: true};
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true});
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({viewport: {width, height: 1000}});
      const errors = []; const created = [];
      page.on('pageerror', error => {errors.push(error.message); console.error('Browser error:', error.message);});
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        let body;
        if (path === '/api/session') body = {subject: 'example-admin', username: 'admin', roles: ['magicstick-admin'], identityManagementAvailable: true, identityManagementMode: 'keycloak'};
        else if (path === '/api/models') body = models;
        else if (path === '/api/model-discovery/popular') body = {results: [], provider: 'huggingface', total: 0};
        else if (path === '/api/models/estimate-memory') {
          body = route.request().postDataJSON().cpuOffloading ? {...estimate, minimumMi: 11000, recommendedMi: 12000, offloading: plan} : estimate;
        } else if (route.request().method() === 'POST' && path === '/api/models/local') {
          created.push(route.request().postDataJSON()); body = {};
        } else throw new Error(`Unexpected API request: ${path}`);
        await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(body)});
      });
      await page.goto(new URL('/#/models', base).href);
      await page.getByRole('button', {name: 'Create', exact: true}).click();
      await page.getByRole('dialog').waitFor();
      if (process.env.MAGICSTICK_SCREENSHOT_DIR) await page.screenshot({path: `${process.env.MAGICSTICK_SCREENSHOT_DIR}/offloading-start-${width}.png`});
      await page.getByLabel('Model source').selectOption('direct');
      await page.getByLabel('Hugging Face URL', {exact: true}).fill('hf://example/model');
      await page.getByLabel('VRAM budget (MiB)', {exact: true}).waitFor();
      assert.equal(await page.getByLabel('Use additional system RAM', {exact: true}).isChecked(), false);
      await page.getByLabel('Use additional system RAM', {exact: true}).check();
      await page.getByLabel('Host RAM budget (MiB)', {exact: true}).waitFor();
      await page.waitForFunction(() => [...document.querySelectorAll('label')].find(label => label.textContent.includes('Host RAM budget (MiB)'))?.querySelector('input')?.value === '12300');
      await page.getByText('Breakdown', {exact: true}).click();
      await page.getByText('Weights · RAM', {exact: true}).waitFor();
      await page.getByLabel('Host RAM budget (MiB)', {exact: true}).scrollIntoViewIfNeeded();
      if (process.env.MAGICSTICK_SCREENSHOT_DIR) await page.screenshot({path: `${process.env.MAGICSTICK_SCREENSHOT_DIR}/offloading-${width}.png`});
      assert.ok(await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], dialog');
        return document.documentElement.scrollWidth <= window.innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1;
      }), 'No horizontal overflow in the offloading dialog.');
      await page.getByRole('button', {name: 'Add Local Model', exact: true}).click();
      await page.getByRole('dialog').waitFor({state: 'hidden'});
      assert.equal(created.length, 1);
      assert.equal(created[0].local.cpuOffloading, true);
      assert.equal(created[0].local.memoryRequiredMi, 12300);
      assert.equal(created[0].local.vram, '12000Mi');
      assert.equal(created[0].local.cpuOffloadMi, undefined);
      assert.deepEqual(errors, []);
      console.log(`PASS: Chrome ${width}px opt-in, RAM/VRAM budgets, breakdown, create/close and overflow checks`);
      await page.close();
    }
  } finally { await browser.close(); }
}

main().catch(error => {console.error(error); process.exitCode = 1;});
