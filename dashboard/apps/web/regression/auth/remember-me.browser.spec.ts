// SPDX-License-Identifier: BUSL-1.1
import {test, expect, chromium, type BrowserContext, type Page} from '@playwright/test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {IdentityStack, accessSeconds, idleProbeSeconds, maximumSeconds} from '../fixtures/identity-stack.ts';

// Explicit Docker-host profile only. These are real OIDC protocol/browser
// checks against isolated upstream containers, not installed-appliance evidence.
test.describe.configure({mode:'serial'});
const stack = new IdentityStack();
test.beforeAll(async () => {await stack.start();});
test.afterAll(async () => {await stack.stop();});

async function login(page:Page, remember:boolean) {
  await page.goto(`${stack.origin}/protected`);
  await page.locator('#username').fill(stack.username);
  await page.locator('#password').fill(stack.password);
  await page.locator('#rememberMe').setChecked(remember);
  await page.locator('#kc-login').click();
  await expect(page).toHaveURL(`${stack.origin}/protected`);
  await expect(page.locator('body')).toContainText('session-fixture');
}
async function probe(context:BrowserContext) {
  const response = await context.request.get(`${stack.origin}/protected`, {
    headers:{'x-session-fixture':'probe'}, maxRedirects:0, timeout:10_000});
  // Do not log tokens/cookies/response bodies in assertion diagnostics.
  return response.status();
}
async function pause(seconds:number) {await new Promise(done => setTimeout(done, seconds * 1000));}

test('AUTH-01 AUTH-03 [isolated:remember-policy] real import, default migration and repeated startup preserve short normal sessions', async () => {
  expect(await stack.policy()).toMatchObject({rememberMe:true, accessTokenLifespan:300,
    ssoSessionIdleTimeout:1800, ssoSessionMaxLifespan:36000,
    ssoSessionIdleTimeoutRememberMe:604800, ssoSessionMaxLifespanRememberMe:2592000,
    attributes:{magicstickRememberMePolicyVersion:'1'}});
  await stack.oldDefaults();
  expect(await stack.migrate()).toContain('version 1 applied');
  expect(await stack.policy()).toMatchObject({accessTokenLifespan:300, ssoSessionIdleTimeout:1800,
    ssoSessionMaxLifespan:36000, ssoSessionIdleTimeoutRememberMe:604800,
    ssoSessionMaxLifespanRememberMe:2592000, attributes:{unrelated:'preserve', magicstickRememberMePolicyVersion:'1'}});
  expect(await stack.migrate()).toContain('already reviewed');
});

test('AUTH-01 AUTH-03 AUTH-06 [isolated:remember-browser] idle expiry, refresh, browser restart and logout reject old session state', async ({browser}) => {
  await stack.accelerate();
  const normal = await browser.newContext();
  const profile = await mkdtemp(join(tmpdir(), 'magicstick-remember-browser-'));
  let remembered:BrowserContext|undefined;
  try {
    await login(await normal.newPage(), false);
    remembered = await chromium.launchPersistentContext(profile, {headless:true, serviceWorkers:'block'});
    await login(await remembered.newPage(), true);
    const before = (await remembered.cookies()).find(cookie => cookie.name === 'MagicStickAccessToken')?.value;
    expect(Boolean(before)).toBe(true);
    await pause(accessSeconds + 2);
    expect(await probe(remembered)).toBe(200);
    const after = (await remembered.cookies()).find(cookie => cookie.name === 'MagicStickAccessToken')?.value;
    expect(Boolean(after) && before !== after, 'Access token was renewed without a login').toBe(true);
    const refresh = (await remembered.cookies()).find(cookie => cookie.name === 'RefreshToken');
    expect(Boolean(refresh && refresh.expires > Date.now() / 1000), 'Remembered refresh cookie persists across browser restart').toBe(true);
    await remembered.close(); remembered = undefined;
    // No requests during this pause (standby/closed browser), including no UI
    // polling that could keep the normal session alive inadvertently.
    await pause(idleProbeSeconds);
    expect(await probe(normal), 'Normal idle session must expire before its maximum lifetime').toBe(401);
    remembered = await chromium.launchPersistentContext(profile, {headless:true, serviceWorkers:'block'});
    expect(await probe(remembered), 'Remembered session survives idle and a real Chromium restart').toBe(200);
    const oldState = await remembered.storageState();
    const page = await remembered.newPage();
    await page.goto(`${stack.origin}/logout`);
    const confirm = page.locator('#kc-logout');
    if (await confirm.isVisible()) await confirm.click();
    await pause(accessSeconds + 2);
    const stale = await browser.newContext({storageState:oldState});
    try {expect(await probe(stale), 'Logged-out session cannot refresh using its old browser data').toBe(401);}
    finally {await stale.close();}
    const clean = await remembered.newPage();
    await clean.goto(`${stack.origin}/protected`);
    await expect(clean.locator('#kc-login')).toBeVisible();
  } finally {await normal.close(); await remembered?.close(); await rm(profile, {recursive:true, force:true});}
});

for (const remember of [true, false]) test(`AUTH-03 [isolated:${remember ? 'remember' : 'normal'}-maximum] frequent token renewal cannot extend the absolute lifetime`, async ({browser}) => {
  await stack.accelerate(remember ? 'remember-maximum' : 'normal-maximum');
  const context = await browser.newContext();
  try {
    await login(await context.newPage(), remember);
    const started = Date.now();
    let status = 200;
    while (Date.now() - started < (maximumSeconds + accessSeconds + 10) * 1000) {
      await pause(3);
      status = await probe(context);
      if (status === 401) break;
      expect(status).toBe(200);
    }
    expect(status, 'Maximum lifespan must end despite activity').toBe(401);
    expect(Date.now() - started, 'Failure must not be premature idle expiry').toBeGreaterThan((maximumSeconds - 3) * 1000);
  } finally {await context.close();}
});
