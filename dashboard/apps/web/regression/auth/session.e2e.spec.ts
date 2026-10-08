import {test, expect, type BrowserContext} from '@playwright/test';
import {loadLabConfig, type LabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {readOnlyApi} from '../core/transport.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {requirePhase1Profile} from '../profiles/phase1-p0.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';

test.describe.serial('installed session smoke', () => {
  let config: LabConfig, context: BrowserContext | undefined;
  test.beforeAll(async () => {
    requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
    config = await loadLabConfig(process.env.REGRESSION_CONFIG); requirePhase1Profile(config);
  });
  test.afterAll(async () => { await context?.close(); });

  test('AUTH-02 [p1:anonymous-api] [layer:A] fresh clients cannot read protected inventory', async ({browser}) => {
    const anonymous = await browser.newContext({serviceWorkers: 'block'});
    try {
      for (const path of ['/api/session', '/api/models', '/api/status', '/api/api-access']) {
        const response = await anonymous.request.get(config.dashboardUrl + path,
          {timeout: config.requestTimeoutMs, maxRedirects: 0, failOnStatusCode: false});
        requireSafe([302, 303, 307, 401, 403].includes(response.status()), 'AUTH');
        const bytes = await response.body(); requireSafe(bytes.length < 2 * 1024 * 1024, 'API');
        if ((response.headers()['content-type'] ?? '').includes('application/json')) {
          const value = await response.json() as Record<string, unknown>;
          requireSafe(!['activations', 'items', 'roles', 'pods', 'subject'].some(key => Object.hasOwn(value, key)), 'AUTH');
        }
      }
    } finally { await anonymous.close(); }
  });

  test('AUTH-02 [p1:anonymous-browser] protected model deep-link enters real local OIDC login', async ({browser}) => {
    const anonymous = await browser.newContext({serviceWorkers: 'block'});
    const page = await anonymous.newPage();
    try {
      const loginPage = await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs});
      if (loginPage?.status() !== 200 || new URL(page.url()).origin !== config.identityUrl) {
        throw new HarnessError('AUTH', 'Blocked', 'login-form');
      }
      await expect(page.locator('#username')).toBeVisible({timeout: config.loginTimeoutMs});
      await expect(page.getByRole('heading', {name: 'Installed Models'})).toHaveCount(0);
    } finally { await anonymous.close(); }
  });

  test('AUTH-01 [p1:login-session] [layer:A+E] real local OIDC identifies the correct administrator and pinned appliance', async ({browser}) => {
    context = await realLogin(browser, config);
    await LiveFoundation.snapshot(context, config);
    const session = await readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs).session();
    requireSafe(session.subject && session.roles.includes(config.expected.role), 'AUTH');
    const page = await context.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('heading', {name: 'AI Appliance Dashboard'})).toBeVisible();
      await expect(page.getByRole('heading', {name: 'Installed Models'})).toBeVisible();
    } finally { await page.close(); }
  });

  test('AUTH-06 [p1:logout-session] [layer:A+E] logout, reload and a new tab cannot reuse stale privilege', async ({browser}) => {
    requireSafe(context, 'AUTH');
    const page = await context.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('link', {name: 'Log out'}).click();
      await page.waitForURL(url => url.origin === config.identityUrl, {timeout: config.loginTimeoutMs, waitUntil: 'domcontentloaded'});
      await expect(page.locator('#username')).toBeVisible({timeout: config.loginTimeoutMs});
      const denied = await context.request.get(config.dashboardUrl + '/api/session',
        {timeout: config.requestTimeoutMs, maxRedirects: 0, failOnStatusCode: false});
      requireSafe([302, 303, 307, 401, 403].includes(denied.status()), 'AUTH');
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.reload({waitUntil: 'domcontentloaded'});
      requireSafe(new URL(page.url()).origin === config.identityUrl, 'AUTH');
      await expect(page.locator('#username')).toBeVisible();
      const tab = await context.newPage();
      try {
        await tab.goto(config.dashboardUrl + '/#/api-access', {waitUntil: 'domcontentloaded'});
        requireSafe(new URL(tab.url()).origin === config.identityUrl, 'AUTH');
        await expect(tab.getByRole('button', {name: 'Create API Key', exact: true})).toHaveCount(0);
      } finally { await tab.close(); }
    } finally { await page.close(); }
    // A new legitimate login recovers; no saved authentication state is reused.
    const recovered = await realLogin(browser, config); await recovered.close();
  });
});
