// SPDX-License-Identifier: BUSL-1.1
// Runs inside an isolated Linux container with an NSS-trusted synthetic CA.
// Never logs browser storage, OAuth responses, or synthetic credentials.
const {chromium} = require('/repo/dashboard/apps/web/node_modules/@playwright/test');
const fs = require('node:fs');
const https = require('node:https');
let phase = 'browser-start';

async function main() {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    const dashboard = 'https://dash.fixture.test';
    const service = 'https://service.fixture.test';
    if (process.env.EXPECT_UNTRUSTED === '1') {
      phase = 'untrusted-ca';
      let denied = false;
      try {await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});}
      catch (error) {denied = String(error.message).includes('ERR_CERT_AUTHORITY_INVALID');}
      if (!denied) throw new Error('An untrusted test CA was not rejected by Chromium');
      process.stdout.write('Untrusted synthetic CA correctly rejected\n');
      return;
    }
    // Only the readiness decision is synthetic. Envoy's ext_proc filter and
    // the product gRPC processor execute for the actual HTTPS navigation.
    async function control(path) {
      const result = await fetch('http://api:8082' + path);
      if (result.status !== 204) throw new Error('Synthetic readiness control failed');
    }
    phase = 'grpc-tls-rejection';
    for (const host of ['bad-ca.fixture.test', 'bad-host.fixture.test', 'expired.fixture.test']) {
      const destination = 'https://' + host + '/protected';
      const response = await page.goto(destination, {waitUntil:'domcontentloaded'});
      if (!response || response.status() < 400 || page.url() !== destination) {
        throw new Error('Invalid gRPC TLS peer was not rejected before authentication');
      }
    }
    phase = 'stale-gate';
    await control('/control?mode=stale');
    let gated = await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});
    if (!gated || gated.status() !== 503 || new URL(page.url()).origin !== dashboard) {
      throw new Error('Stale callback readiness did not gate before login');
    }
    await control('/control?mode=additive');
    phase = 'additive-gate';
    gated = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!gated || gated.status() !== 503 || new URL(page.url()).origin !== service) {
      throw new Error('Unconfirmed additive service was not fenced');
    }
    phase = 'dashboard-login';
    await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});
    await page.locator('#username').fill('fixture-user');
    await page.locator('#password').fill('fixture-password');
    await page.locator('#kc-login').click();
    await page.waitForURL(dashboard + '/protected');
    const first = await context.cookies(dashboard);
    const dashboardCookie = first.find(c => c.name === '__Host-MagicStickAccessToken');
    if (!dashboardCookie || dashboardCookie.domain !== 'dash.fixture.test' || !dashboardCookie.secure || !dashboardCookie.httpOnly || dashboardCookie.path !== '/') {
      throw new Error('Dashboard host-only secure session cookie missing');
    }
    // Exercise an existing browser, not only an empty cookie jar. Retain the
    // native Keycloak SSO session while projecting the old broad gateway jar,
    // including its route helper cookies, onto the shared parent domain.
    if (process.env.LEGACY_COOKIE_UPGRADE === '1') {
      phase = 'legacy-cookie-upgrade';
      if (!first.some(cookie => cookie.name === 'OauthHMAC') || !first.some(cookie => cookie.name === 'RefreshToken')) {
        throw new Error('Synthetic legacy jar is missing actual OAuth helper cookies');
      }
      await context.clearCookies({domain:'dash.fixture.test'});
      await context.addCookies(first.map(cookie => ({...cookie, domain:'.fixture.test',
        name:cookie.name === '__Host-MagicStickAccessToken' ? 'MagicStickAccessToken' :
          cookie.name === '__Host-MagicStickIDToken' ? 'MagicStickIDToken' : cookie.name})));
      const upgraded = await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});
      const upgradedCookies = await context.cookies(dashboard);
      if (!upgraded || upgraded.status() !== 200 || page.url() !== dashboard + '/protected' ||
          !upgradedCookies.some(cookie => cookie.name === '__Host-MagicStickAccessToken' && cookie.domain === 'dash.fixture.test') ||
          upgradedCookies.some(cookie => ['MagicStickAccessToken','MagicStickIDToken'].includes(cookie.name))) {
        process.stderr.write(`Legacy upgrade: HTTP ${upgraded?.status()}, protected ${page.url() === dashboard + '/protected'}, host session ${upgradedCookies.some(cookie => cookie.name === '__Host-MagicStickAccessToken' && cookie.domain === 'dash.fixture.test')}, old named tokens ${upgradedCookies.some(cookie => ['MagicStickAccessToken','MagicStickIDToken'].includes(cookie.name))}\n`);
        throw new Error('Existing broad cookie jar did not migrate without an authentication loop');
      }
    }
    phase = 'gate-stop';
    await control('/stop-gate');
    const offline = await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});
    if (!offline || offline.status() < 400 || new URL(page.url()).origin !== dashboard) {
      throw new Error('Unavailable gRPC processor did not fail closed');
    }
    phase = 'gate-restart';
    await control('/restart-gate');
    const existing = await page.goto(dashboard + '/protected', {waitUntil:'domcontentloaded'});
    if (!existing || existing.status() !== 200) throw new Error('Confirmed dashboard failed after gRPC restart');
    await control('/control?mode=ready');
    phase = 'service-login';
    const response = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!response || response.status() !== 200 || page.url() !== service + '/protected') {
      throw new Error('Central sign-in did not establish a service-host session');
    }
    const serviceCookies = await context.cookies(service);
    const serviceCookie = serviceCookies.find(c => c.name === '__Host-MagicStickAccessToken');
    if (!serviceCookie || serviceCookie.domain !== 'service.fixture.test' || !serviceCookie.secure || !serviceCookie.httpOnly || serviceCookie.path !== '/') {
      throw new Error('Service host-only secure session cookie missing');
    }
    if (serviceCookies.some(c => c.domain === 'dash.fixture.test') ||
        (await context.cookies(dashboard)).some(c => c.domain === 'service.fixture.test')) {
      throw new Error('A session cookie crossed the host boundary');
    }
    // The service policy emulates LiteLLM: OAuth does not replace an
    // application's native Authorization header. Only synthetic data is used.
    phase = 'native-authorization';
    const native = await page.evaluate(async () => {
      const result = await fetch('/protected', {headers:{Authorization:'Bearer fixture-native'}});
      return {status:result.status, forwarded:result.headers.get('x-fixture-native-authorization')};
    });
    if (native.status !== 200 || native.forwarded !== 'Bearer fixture-native') {
      throw new Error('Native service Authorization was not preserved');
    }
    phase = 'delayed-fanout';
    await control('/control?mode=slow');
    const ca = fs.readFileSync('/test/ca.pem');
    const started = Date.now();
    const statusCodes = await Promise.all(Array.from({length:32}, () => new Promise((resolve, reject) => {
      const request = https.get({hostname:'dash.fixture.test', path:'/protected', ca, agent:false, timeout:8000}, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('timeout', () => request.destroy(new Error('Synthetic fanout timeout')));
      request.on('error', error => {
        const category = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code) ? error.code : 'OTHER';
        process.stderr.write(`Synthetic fanout transport category: ${category}\n`);
        reject(new Error('Synthetic fanout transport failed'));
      });
    })));
    const metricsResponse = await fetch('http://api:8082/metrics');
    const metrics = await metricsResponse.json();
    if (statusCodes.some(code => code !== 302)) {
      const counts = Object.fromEntries([...new Set(statusCodes)].sort().map(code => [code, statusCodes.filter(value => value === code).length]));
      process.stderr.write(`Synthetic fanout status counts: ${JSON.stringify(counts)}; readiness calls ${Number(metrics.calls)}, concurrent ${Number(metrics.maximum)}, elapsed ${Date.now() - started} ms\n`);
      throw new Error('A delayed parallel request failed closed unexpectedly');
    }
    if (metricsResponse.status !== 200 || metrics.calls !== 32 || metrics.maximum < 2) {
      process.stderr.write(`Synthetic fanout metrics: HTTP ${metricsResponse.status}, calls ${Number(metrics.calls)}, concurrent ${Number(metrics.maximum)}\n`);
      throw new Error('The concurrent readiness fanout was not observed');
    }
    process.stdout.write(`Synthetic delayed gate: 32 requests, ${metrics.maximum} concurrent, ${Date.now() - started} ms\n`);
    phase = 'stale-authenticated';
    await control('/control?mode=stale');
    gated = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!gated || gated.status() !== 503) throw new Error('Unconfirmed status did not fail closed');
    await control('/control?mode=ready');
    const recovered = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!recovered || recovered.status() !== 200) throw new Error('Service did not recover after confirmed readiness');
    phase = 'global-logout';
    const logout = await page.goto(dashboard + '/logout', {waitUntil:'domcontentloaded'});
    const logoutAtIdentity = new URL(page.url()).origin === 'https://id.fixture.test';
    const confirm = page.locator('#kc-logout');
    const confirmation = await confirm.isVisible();
    if (confirmation) await confirm.click();
    const after = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    const afterUrl = new URL(page.url());
    const deniedInPlace = after?.status() === 403 && afterUrl.origin === service && afterUrl.pathname === '/protected';
    const loginRequired = after?.status() === 200 && afterUrl.origin === 'https://id.fixture.test' &&
      afterUrl.pathname === '/realms/magicstick/protocol/openid-connect/auth' &&
      afterUrl.searchParams.get('client_id') === 'magicstick-human-gateway-local' &&
      afterUrl.searchParams.get('redirect_uri') === service + '/oauth2/callback' &&
      await page.locator('#username').isVisible() && await page.locator('#password').isVisible() &&
      await page.locator('#kc-login').isVisible();
    if (!deniedInPlace && !loginRequired) {
      process.stderr.write(`Logout proof: HTTP ${logout?.status()}, identity ${logoutAtIdentity}, confirmed ${confirmation}; other host HTTP ${after?.status()}, protected ${page.url() === service + '/protected'}, identity ${new URL(page.url()).origin === 'https://id.fixture.test'}, login form ${await page.locator('#username').isVisible()}\n`);
      throw new Error('Other service accepted a logged-out session');
    }
    process.stdout.write(`Trusted HTTPS multi-host login, cookie isolation and global logout (${process.env.LEGACY_COOKIE_UPGRADE === '1' ? 'legacy upgrade' : 'fresh browser'}): passed\n`);
  } finally {await context.close(); await browser.close();}
}

main().catch(() => {
  // Browser errors can include OAuth callback URLs and must not enter CI logs.
  process.stderr.write(`Trusted HTTPS multi-host browser probe failed at ${phase}; protocol details redacted\n`);
  process.exitCode = 1;
});
