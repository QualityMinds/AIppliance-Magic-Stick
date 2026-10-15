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

const statusTools = {
  '/api/regression': {registered: true, applianceUid: 'fixture-appliance', runtimeAvailable: true,
    sourceRevision: 'b'.repeat(40), message: '', runs: [], executionLocation: 'appliance-kubernetes', externalRunnerRequired: ['reboot']},
  '/api/host-management': {nodes: []},
  '/api/license': {state: 'missing', valid: false, features: []},
};

for (const viewport of ['desktop', 'mobile'] as const) {
  test(`NAV-01 NAV-02 NAV-03 NAV-06 UX-02 ${viewport} nested System Status keeps tools lazy, links compatible and navigation inert`, async ({page}, info) => {
    await page.setViewportSize(viewport === 'desktop' ? {width: 1440, height: 1000} : {width: 390, height: 844});
    let writes = 0;
    const reads: string[] = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/')) return;
      if (request.method() === 'GET') reads.push(path); else writes++;
    });
    await fixturePage(page, {...statusTools, '/api/status': {
      pods: [{name: 'fixture-pod', phase: 'Running'}], services: [], ingresses: [],
      hardwareOperators: {nvidia: {displayName: 'Fixture NVIDIA Operator', phase: 'Degraded', operatorActive: true,
        message: 'Fixture NVIDIA driver unavailable', operatorVersion: 'fixture-version', driverMode: 'host-managed'},
        amd: {displayName: 'Fixture AMD Operator', phase: 'NotRequired', operatorActive: false, message: 'No AMD GPU detected.'}},
      fluxKustomizations: [{namespace: 'flux-system', name: 'fixture-flux', conditions: [{type: 'Ready', status: 'False',
        reason: 'FixtureReconcileFailed', message: 'Fixture dependency unavailable'}]}],
      httpRoutes: [{namespace: 'identity-system', name: 'fixture-route', hostnames: ['inference.example.local'], accepted: true}],
    }});
    await page.goto(origin + '/#/system/status');
    const top = page.getByRole('tablist', {name: 'System sections', exact: true});
    const tabs = page.getByRole('tablist', {name: 'System Status sections', exact: true});
    await expect(top.getByRole('tab', {name: 'Model cache', exact: true})).toHaveCount(0);
    await expect(top.getByRole('tab', {name: 'Regression tests', exact: true})).toHaveCount(0);
    await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'GPU Operators', 'Flux', 'Network & routes', 'Model cache', 'Regression tests']);
    await expect(page.getByText('1/1', {exact: true})).toBeVisible();
    await expect(page.getByText('Fixture NVIDIA Operator', {exact: true})).toHaveCount(0);
    expect(reads).not.toContain('/api/host-management'); expect(reads).not.toContain('/api/regression');
    await page.screenshot({path: info.outputPath(`system-status-${viewport}.png`)});
    const overview = tabs.getByRole('tab', {name: 'Overview', exact: true});
    await overview.focus(); await overview.press('ArrowRight');
    await expect(tabs.getByRole('tab', {name: 'GPU Operators', exact: true})).toBeFocused();
    await expect(page).toHaveURL(origin + '/#/system/status/gpu-operators');
    await expect(page.getByText('Fixture NVIDIA driver unavailable', {exact: true})).toBeVisible();
    await expect(page.getByText('No AMD GPU detected.', {exact: true})).toBeVisible();
    await tabs.getByRole('tab', {name: 'Flux', exact: true}).click();
    await expect(page.getByText('FixtureReconcileFailed', {exact: true})).toBeVisible();
    await expect(page.getByText('Fixture dependency unavailable', {exact: true})).toBeVisible();
    await tabs.getByRole('tab', {name: 'Network & routes', exact: true}).click();
    await expect(page.getByRole('link', {name: 'inference.example.local', exact: true})).toHaveAttribute('href', 'https://inference.example.local/');
    await tabs.getByRole('tab', {name: 'Model cache', exact: true}).click();
    await expect(page).toHaveURL(origin + '/#/system/status/model-cache');
    await expect(page.getByText('No manageable computers reported.', {exact: true})).toBeVisible();
    expect(reads).not.toContain('/api/regression');
    await tabs.getByRole('tab', {name: 'Regression tests', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Start regression tests', exact: true})).toBeEnabled();
    await expect(page).toHaveURL(origin + '/#/system/status/regression');
    expect(reads).not.toContain('/api/license');
    await page.reload();
    await expect(tabs.getByRole('tab', {name: 'Regression tests', exact: true})).toHaveAttribute('aria-selected', 'true');
    for (const section of ['model-cache', 'regression']) {
      await page.goto(origin + '/#/system/' + section);
      await expect(page).toHaveURL(origin + '/#/system/status/' + section);
    }
    await page.goto(origin + '/#/system/status/flux');
    await page.goto(origin + '/#/system/status/network');
    await page.goBack();
    await expect(tabs.getByRole('tab', {name: 'Flux', exact: true})).toHaveAttribute('aria-selected', 'true');
    await page.goForward();
    await expect(tabs.getByRole('tab', {name: 'Network & routes', exact: true})).toHaveAttribute('aria-selected', 'true');
    await tabs.getByRole('tab', {name: 'Network & routes', exact: true}).press('Home');
    await expect(overview).toBeFocused();
    await overview.press('End');
    await expect(tabs.getByRole('tab', {name: 'Regression tests', exact: true})).toBeFocused();
    await tabs.getByRole('tab', {name: 'Regression tests', exact: true}).press('ArrowRight');
    await expect(overview).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(writes).toBe(0);
  });

  test(`NAV-03 NAV-08 UX-02 ${viewport} resource loading and errors never trap the System Status navigation`, async ({page}) => {
    await page.setViewportSize(viewport === 'desktop' ? {width: 1440, height: 1000} : {width: 390, height: 844});
    let failed = true, writes = 0;
    let release!: () => void;
    const pending = new Promise<void>(resolve => {release = resolve;});
    page.on('request', request => {if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) writes++;});
    await fixturePage(page, statusTools);
    await page.route('**/api/status', async route => {
      await pending;
      await route.fulfill({status: failed ? 503 : 200, contentType: 'application/json',
        body: JSON.stringify(failed ? {error: 'Fixture resource status unavailable'} : {hardwareOperators: {}, fluxKustomizations: []})});
    });
    await page.goto(origin + '/#/system/status/flux');
    const tabs = page.getByRole('tablist', {name: 'System Status sections', exact: true});
    await expect(tabs.getByRole('tab', {name: 'Regression tests', exact: true})).toBeEnabled();
    await expect(page.getByText('Loading current appliance state…', {exact: true})).toBeVisible();
    release();
    await expect(page.getByText('Fixture resource status unavailable', {exact: true})).toBeVisible();
    failed = false;
    await page.getByRole('button', {name: 'Retry status', exact: true}).click();
    await expect(page.getByText('No Flux objects returned.', {exact: true})).toBeVisible();
    await tabs.getByRole('tab', {name: 'Regression tests', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Start regression tests', exact: true})).toBeEnabled();
    expect(writes).toBe(0);
  });

  for (const role of ['magicstick-viewer', 'magicstick-operator']) {
    test(`NAV-01 NAV-02 NAV-03 SEC-01 ${viewport} ${role} cannot mount nested maintenance tools`, async ({page}) => {
      await page.setViewportSize(viewport === 'desktop' ? {width: 1440, height: 1000} : {width: 390, height: 844});
      const privilegedReads: string[] = [];
      page.on('request', request => { const path = new URL(request.url()).pathname; if (/^\/api\/(regression|host-management|license)/.test(path)) privilegedReads.push(path); });
      await fixturePage(page, {...statusTools, '/api/session': {subject: 'fixture-reader', username: 'fixture-reader', roles: [role]}});
      for (const path of ['system/model-cache', 'system/regression', 'system/status/model-cache', 'system/status/regression']) {
        await page.goto(origin + '/#/' + path);
        await expect(page).toHaveURL(origin + '/#/system/status');
        const tabs = page.getByRole('tablist', {name: 'System Status sections', exact: true});
        await expect(tabs.getByRole('tab')).toHaveText(['Overview', 'GPU Operators', 'Flux', 'Network & routes']);
        await expect(page.getByRole('button', {name: 'Start regression tests', exact: true})).toHaveCount(0);
        await expect(page.getByRole('button', {name: 'Clear model cache', exact: true})).toHaveCount(0);
      }
      expect(privilegedReads).toEqual([]);
    });
  }
}
