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
    const instance = 'https://instance.fixture.test';
    const paperclip = 'https://paperclip.fixture.test';
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
      if (!first.some(cookie => cookie.name === 'OauthHMAC-fixture-dashboard') || !first.some(cookie => cookie.name === 'RefreshToken-fixture-dashboard')) {
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
    phase = 'instance-login';
    const instancePage = await context.newPage();
    const instanceResponse = await instancePage.goto(instance + '/protected', {waitUntil:'domcontentloaded'});
    const instanceCookie = (await context.cookies(instance)).find(c => c.name === '__Host-MagicStickAccessToken');
    if (instanceResponse?.status() !== 200 || !instanceCookie || instanceCookie.domain !== 'instance.fixture.test' ||
        !instanceCookie.secure || !instanceCookie.httpOnly || instanceCookie.path !== '/') {
      throw new Error('Real instance guard did not establish its isolated session');
    }
    phase = 'instance-forbidden';
    const forbiddenResponse = instancePage.waitForResponse(response => response.url() === instance + '/forbidden');
    const forbidden = await instancePage.evaluate(async () => {
      const result = await fetch('/forbidden', {redirect:'manual'});
      return {status:result.status, location:result.headers.get('location')};
    });
    const forbiddenHeaders = await (await forbiddenResponse).headersArray();
    // Envoy may normally refresh a valid token while migrating old broad
    // helper cookies. Require no token deletion, not byte-identical tokens.
    // The owning handler tests separately require no guard cookie writes.
    const erasedByDenial = forbiddenHeaders.some(header => header.name.toLowerCase() === 'set-cookie' &&
      /^__Host-MagicStick(?:Access|ID)Token=/.test(header.value) && /Max-Age=0(?:;|$)/i.test(header.value));
    if (forbidden.status !== 403 || forbidden.location !== null || erasedByDenial ||
        !(await context.cookies(instance)).some(c => c.name === '__Host-MagicStickAccessToken')) {
      process.stderr.write(`Instance denial: HTTP ${forbidden.status}, redirect ${forbidden.location !== null}, erased token ${erasedByDenial}\n`);
      throw new Error('A genuine instance role denial changed authentication state');
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
    const resourceRequest = (hostname='dash.fixture.test', headers={}, path='/protected') => new Promise((resolve, reject) => {
      const request = https.get({hostname, path, headers, ca, agent:false, timeout:8000}, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('timeout', () => request.destroy(new Error('Synthetic fanout timeout')));
      request.on('error', error => {
        const category = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error.code) ? error.code : 'OTHER';
        process.stderr.write(`Synthetic fanout transport category: ${category}\n`);
        reject(new Error('Synthetic fanout transport failed'));
      });
    });
    const statusCodes = await Promise.all(Array.from({length:32}, () => resourceRequest()));
    const metricsResponse = await fetch('http://api:8082/metrics');
    const metrics = await metricsResponse.json();
    if (statusCodes.some(code => code !== 302)) {
      const counts = Object.fromEntries([...new Set(statusCodes)].sort().map(code => [code, statusCodes.filter(value => value === code).length]));
      process.stderr.write(`Synthetic fanout status counts: ${JSON.stringify(counts)}; readiness calls ${Number(metrics.calls)}, concurrent ${Number(metrics.maximum)}, elapsed ${Date.now() - started} ms\n`);
      throw new Error('A delayed parallel request failed closed unexpectedly');
    }
    if (metricsResponse.status !== 200 || metrics.calls !== 1 || metrics.maximum !== 1 || metrics.joined !== 31) {
      process.stderr.write(`Synthetic fanout metrics: HTTP ${metricsResponse.status}, calls ${Number(metrics.calls)}, concurrent ${Number(metrics.maximum)}, joined ${Number(metrics.joined)}\n`);
      throw new Error('The complete overlapping readiness check was not shared');
    }
    process.stdout.write(`Synthetic delayed gate: 32 HTTPS requests, one readiness check, 31 joined, ${Date.now() - started} ms\n`);
    // No shared authorization: all 32 anonymous requests still need login.
    // A completed allow/deny must also not hide a new observation on this host.
    phase = 'completed-fanout-fresh-check';
    for (const [mode, expected] of [['stale', 503], ['ready', 302]]) {
      await control('/control?mode=' + mode);
      const code = await resourceRequest();
      const freshMetricsResponse = await fetch('http://api:8082/metrics');
      const freshMetrics = await freshMetricsResponse.json();
      if (code !== expected || freshMetricsResponse.status !== 200 || freshMetrics.calls !== 1 ||
          freshMetrics.maximum !== 1 || freshMetrics.joined !== 0) {
        throw new Error('A completed readiness decision masked a fresh same-host check');
      }
    }
    phase = 'paperclip-anonymous';
    for (const headers of [{}, {Authorization:'Bearer fixture-paperclip-agent'}]) {
      if (await resourceRequest('paperclip.fixture.test', headers, '/api/actor') !== 302) {
        throw new Error('Paperclip browser access bypassed central sign-in');
      }
    }
    phase = 'paperclip-login';
    const paperclipPage = await context.newPage();
    const paperclipResponse = await paperclipPage.goto(paperclip + '/protected', {waitUntil:'domcontentloaded'});
    if (paperclipResponse?.status() !== 200 || paperclipPage.url() !== paperclip + '/protected') {
      throw new Error('The browser SSO token reached the synthetic Paperclip agent verifier');
    }
    const paperclipCookie = (await context.cookies(paperclip)).find(c => c.name === '__Host-MagicStickAccessToken');
    if (!paperclipCookie || paperclipCookie.domain !== 'paperclip.fixture.test' ||
        !paperclipCookie.secure || !paperclipCookie.httpOnly || paperclipCookie.path !== '/') {
      throw new Error('Paperclip did not receive an isolated host-only session');
    }
    await paperclipPage.getByRole('button', {name:'Paperclip fixture', exact:true}).click();
    if (await paperclipPage.locator('output').textContent() !== 'clicked') {
      throw new Error('The protected Paperclip fixture did not become interactive');
    }
    phase = 'paperclip-native-authorization';
    const actors = await paperclipPage.evaluate(async () => {
      const results = [];
      for (const authorization of [null, 'Bearer fixture-paperclip-agent', 'Bearer fixture-wrong-paperclip-agent']) {
        const response = await fetch('/api/actor', {headers:authorization ? {Authorization:authorization} : {}});
        const body = await response.json();
        results.push({status:response.status, actor:body.actor || null, rejected:Boolean(body.error)});
      }
      for (const path of ['/forbidden', '/wrong-owner']) {
        const response = await fetch(path, {redirect:'manual'});
        results.push({status:response.status});
      }
      return results;
    });
    if (JSON.stringify(actors) !== JSON.stringify([
      {status:200,actor:'browser',rejected:false}, {status:200,actor:'agent',rejected:false},
      {status:401,actor:null,rejected:true}, {status:403}, {status:403}])) {
      throw new Error('Paperclip browser/agent credentials or instance grants were mixed');
    }
    for (const [token, expected] of [['fixture-paperclip-agent', 200], ['fixture-wrong-paperclip-agent', 401]]) {
      const result = await fetch('http://api:8084/api/actor', {headers:{Authorization:'Bearer ' + token}});
      if (result.status !== expected) throw new Error('Internal native agent callback behavior changed');
    }
    process.stdout.write('Synthetic Paperclip boundary: browser UI/API, native agent allow/deny, anonymous sign-in, role and owner denials passed\n');
    phase = 'stale-authenticated';
    await control('/control?mode=stale');
    gated = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!gated || gated.status() !== 503) throw new Error('Unconfirmed status did not fail closed');
    await control('/control?mode=ready');
    const recovered = await page.goto(service + '/protected', {waitUntil:'domcontentloaded'});
    if (!recovered || recovered.status() !== 200) throw new Error('Service did not recover after confirmed readiness');
    const servicePage = await context.newPage();
    // Each guard is the first navigation after real central logout twice.
    // A 403 page is NOT sufficient: require the real IdP form, exact callback
    // host and successful immediate re-login, without waiting for the fence.
    for (let round = 0; round < 2; round++) for (const destination of [instance, service, paperclip]) {
      const destinationPage = destination === instance ? instancePage : destination === paperclip ? paperclipPage : servicePage;
      phase = `global-logout-${new URL(destination).hostname.split('.')[0]}-${round + 1}`;
      const seeded = await servicePage.goto(service + '/protected', {waitUntil:'domcontentloaded'});
      if (seeded?.status() !== 200) throw new Error('Fresh service session prerequisite failed');
      phase = `global-logout-${destination === instance ? 'instance' : 'service'}-${round + 1}-seed-instance`;
      if ((await instancePage.goto(instance + '/protected', {waitUntil:'domcontentloaded'}))?.status() !== 200) {
        throw new Error('Fresh instance session prerequisite failed');
      }
      if ((await paperclipPage.goto(paperclip + '/protected', {waitUntil:'domcontentloaded'}))?.status() !== 200) {
        throw new Error('Fresh Paperclip session prerequisite failed');
      }
      phase = `global-logout-${destination === instance ? 'instance' : 'service'}-${round + 1}-logout`;
      // First reproduce dashboard logout. Later use the OTHER protected
      // host's normal global logout, proving cross-host invalidation for
      // both guards. Unattributed old root helper collisions are a separate
      // legacy migration limitation, not a new valid-session prerequisite.
      const logoutHost = round === 0 && destination === instance ? dashboard : destination === instance ? service : instance;
      await page.goto(logoutHost + '/logout', {waitUntil:'domcontentloaded'});
      if (await page.locator('#kc-logout').isVisible()) await page.locator('#kc-logout').click();
      const logoutPhase = phase;
      phase = logoutPhase + '-api-rejection';
      const cookieBefore = (await context.cookies(destination)).find(c => c.name === '__Host-MagicStickAccessToken');
      const rejected = await destinationPage.evaluate(async () => {
        const results = [];
        for (const method of ['GET', 'POST']) {
          const result = await fetch('/protected', {method, redirect:'manual', headers:{Accept:'application/json'}});
          results.push({status:result.status, location:result.headers.get('location')});
        }
        return results;
      });
      if (!cookieBefore || rejected.some(result => result.status !== 401 || result.location !== null) ||
          (await context.cookies(destination)).find(c => c.name === '__Host-MagicStickAccessToken')?.value !== cookieBefore.value) {
        process.stderr.write(`Logged-out API: statuses ${rejected.map(result => result.status).join(',')}, redirect ${rejected.some(result => result.location !== null)}, prior token ${Boolean(cookieBefore)}, same token ${(await context.cookies(destination)).find(c => c.name === '__Host-MagicStickAccessToken')?.value === cookieBefore?.value}\n`);
        throw new Error('Expired API session redirected, replayed a write or erased browser state');
      }
      phase = logoutPhase + '-login-form';
      const after = await page.goto(destination + '/protected', {waitUntil:'domcontentloaded'});
      const afterUrl = new URL(page.url());
      if (after?.status() !== 200 || afterUrl.origin !== 'https://id.fixture.test' ||
          afterUrl.pathname !== '/realms/magicstick/protocol/openid-connect/auth' ||
          afterUrl.searchParams.get('client_id') !== 'magicstick-human-gateway-local' ||
          afterUrl.searchParams.get('redirect_uri') !== destination + '/oauth2/callback' ||
          !(await page.locator('#username').isVisible()) || !(await page.locator('#password').isVisible()) ||
          !(await page.locator('#kc-login').isVisible())) {
        process.stderr.write(`Reauthentication: HTTP ${after?.status()}, identity ${afterUrl.origin === 'https://id.fixture.test'}, login form ${await page.locator('#username').isVisible()}\n`);
        throw new Error('Logged-out browser did not reach the real sign-in form');
      }
      await page.locator('#username').fill('fixture-user');
      await page.locator('#password').fill('fixture-password');
      await page.locator('#kc-login').click();
      phase = logoutPhase + '-return';
      await page.waitForURL(destination + '/');
      const cookies = await context.cookies(destination);
      if (!cookies.some(cookie => cookie.name === '__Host-MagicStickAccessToken' && cookie.domain === new URL(destination).hostname) ||
          cookies.some(cookie => cookie.name === '__Host-MagicStickReauth') ||
          (await page.reload({waitUntil:'domcontentloaded'}))?.status() !== 200) {
        throw new Error('Reauthentication did not restore normal protected traffic and clear the loop fence');
      }
    }
    process.stdout.write(`Trusted HTTPS multi-host and instance login, role/API denials, cookie isolation and repeated global logout/re-login (${process.env.LEGACY_COOKIE_UPGRADE === '1' ? 'legacy upgrade' : 'fresh browser'}): passed\n`);
  } finally {await context.close(); await browser.close();}
}

main().catch(() => {
  // Browser errors can include OAuth callback URLs and must not enter CI logs.
  process.stderr.write(`Trusted HTTPS multi-host browser probe failed at ${phase}; protocol details redacted\n`);
  process.exitCode = 1;
});
