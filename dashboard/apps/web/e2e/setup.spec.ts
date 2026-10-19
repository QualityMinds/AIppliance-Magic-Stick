import {readFileSync} from 'node:fs';
import {expect, test, type BrowserContext, type Page} from '@playwright/test';

// Run the actual standalone setup HTML/JS, not a React replacement. API fixtures
// are isolated; the Python setup-session suite tests the real backend separately.
const manifest = readFileSync(new URL('../../../../magic-cluster/platform/identity/setup-configmap.yaml', import.meta.url), 'utf8');
function embedded(name: string) {
  const match = manifest.match(new RegExp(`^    ${name} = r?"""([\\s\\S]*?)"""`, 'm'));
  if (!match) throw new Error(`Setup asset missing: ${name}`);
  return match[1]!.replace(/^    /gm, '');
}
const assets: Record<string, {type: string; body: string}> = {
  '/setup': {type: 'text/html', body: embedded('INDEX_HTML')},
  '/setup/app.js': {type: 'application/javascript', body: embedded('APP_JS')},
  '/setup/style.css': {type: 'text/css', body: embedded('STYLE_CSS')},
};
const origin = 'https://setup.example.local';

function setupFixture(phase = 'Claimed') {
  const state = {phase, sessions: new Set<string>(), claims: 0, completions: 0,
    failComplete: false, loseClaimResponse: false,
    draft: {applianceName: 'Example Appliance', mdnsDomain: 'example.local', timezone: 'UTC', language: 'en',
      publicDomain: '', username: '', displayName: '', email: ''}};
  async function attach(context: BrowserContext) {
    await context.route(origin + '/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => route.fulfill({
        status, contentType: 'application/json', headers: {'cache-control': 'no-store', ...headers}, body: JSON.stringify(body)});
      if (path in assets) {
        const asset = assets[path]!;
        return route.fulfill({contentType: asset.type, body: asset.body});
      }
      const cookies = request.headers()['cookie'] || '';
      const session = /(?:^|; )MagicStickSetupSession=([^;]+)/.exec(cookies)?.[1];
      const authorized = session !== undefined && state.sessions.has(session);
      if (path === '/setup/api/status') return reply({phase: state.phase, installationId: 'a1b2c3d4-1111-2222-3333-444444444444'});
      if (path === '/setup/api/config') return authorized ? reply(state.draft) : reply({message: 'Die Setup-Sitzung fehlt.'}, 401);
      if (path === '/setup/api/claim') {
        if (state.phase === 'Completed') return reply({message: 'Die Einrichtung ist abgeschlossen.'}, 409);
        if (request.postDataJSON().claimToken !== 'abc234xy') return reply({message: 'Der Einrichtungscode ist falsch.'}, 403);
        const id = 'browser-' + ++state.claims;
        state.sessions.add(id);
        if (state.phase === 'Pending') state.phase = 'Claimed';
        if (state.loseClaimResponse) {
          state.loseClaimResponse = false;
          return route.abort('connectionreset');
        }
        return reply({claimed: true}, 200, {'set-cookie':
          `MagicStickSetupSession=${id}; Path=/setup; Secure; HttpOnly; SameSite=Strict\n` +
          `MagicStickSetupCsrf=csrf-${id}; Path=/; Secure; SameSite=Strict`});
      }
      if (path === '/setup/api/complete') {
        if (!authorized) return reply({message: 'Die Setup-Sitzung ist abgelaufen.'}, 401);
        expect(request.headers()['x-magicstick-csrf']).toBe('csrf-' + session);
        const body = request.postDataJSON();
        for (const key of Object.keys(state.draft) as Array<keyof typeof state.draft>) state.draft[key] = body[key];
        if (state.failComplete) {
          state.phase = 'Failed';
          return reply({message: 'Eine interne Abhängigkeit ist noch nicht bereit.'}, 503);
        }
        state.completions++;
        state.phase = 'Completed';
        state.sessions.clear();
        return reply({completed: true, recoveryUsername: body.recoveryUsername, recoveryCode: body.recoveryCode,
          dashboardURL: 'https://example.local/'});
      }
      if (path === '/setup/api/handoff') return reply({dashboardReady: false, dashboardURL: 'https://example.local/'});
      return route.fulfill({status: 404, body: 'Unexpected setup fixture request'});
    });
  }
  return {state, attach};
}

async function enterCode(page: Page) {
  await page.getByLabel('Einrichtungscode', {exact: true}).fill('abc234xy');
  await page.getByRole('button', {name: 'Appliance übernehmen'}).click();
  await expect(page.getByRole('heading', {name: 'Grundkonfiguration'})).toBeVisible();
}

async function fillAdmin(page: Page) {
  await page.getByLabel('Benutzername', {exact: true}).fill('example-admin');
  await page.getByLabel('Anzeigename').fill('Example Admin');
  await page.getByLabel('E-Mail', {exact: true}).fill('admin@example.com');
  await page.getByLabel('Passwort', {exact: true}).fill('synthetic-password-only');
  await page.getByLabel('Passwort bestätigen').fill('synthetic-password-only');
}

for (const phase of ['Claimed', 'Applying', 'Failed']) {
  test(`initial setup ${phase}: missing cookie permits console-code re-entry instead of a dead end`, async ({page, context}, testInfo) => {
    const fixture = setupFixture(phase);
    await fixture.attach(context);
    await page.goto(origin + '/setup');
    await expect(page.getByText('Die Einrichtung ist noch nicht abgeschlossen.', {exact: false})).toBeVisible();
    if (phase === 'Claimed') await page.screenshot({path: testInfo.outputPath('setup-reenter-code.png'), fullPage: true});
    await enterCode(page);
    await expect(page.getByLabel('Appliance-Name')).toHaveValue('Example Appliance');
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Grundkonfiguration'})).toBeVisible();
    expect(fixture.state.claims).toBe(1);
    expect(fixture.state.completions).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (phase === 'Claimed') await page.screenshot({path: testInfo.outputPath('setup-resumed-form.png'), fullPage: true});
  });
}

test('independent browsers use the same setup code and neither displaces the other', async ({page, context, browser}) => {
  const fixture = setupFixture('Pending');
  await fixture.attach(context);
  await page.goto(origin + '/setup');
  await enterCode(page);
  const other = await browser.newContext();
  try {
    await fixture.attach(other);
    const second = await other.newPage();
    await second.goto(origin + '/setup#claim=abc234xy');
    await expect(second.getByRole('heading', {name: 'Grundkonfiguration'})).toBeVisible();
    expect(new URL(second.url()).hash).toBe('');
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Grundkonfiguration'})).toBeVisible();
    await second.reload();
    await expect(second.getByRole('heading', {name: 'Grundkonfiguration'})).toBeVisible();
    expect(fixture.state.claims).toBe(2);
  } finally { await other.close(); }
});

test('a lost claim response allows a second use of the still displayed code', async ({page, context}) => {
  const fixture = setupFixture('Pending');
  fixture.state.loseClaimResponse = true;
  await fixture.attach(context);
  await page.goto(origin + '/setup');
  await page.getByLabel('Einrichtungscode', {exact: true}).fill('abc234xy');
  await page.getByRole('button', {name: 'Appliance übernehmen'}).click();
  await expect(page.locator('#message')).not.toBeEmpty();
  await page.reload();
  await enterCode(page);
  expect(fixture.state.claims).toBe(2);
});

test('partial setup resumes non-secret data in another browser and completes only after retry', async ({page, context, browser}) => {
  const fixture = setupFixture('Pending');
  fixture.state.failComplete = true;
  await fixture.attach(context);
  await page.goto(origin + '/setup');
  await enterCode(page);
  await fillAdmin(page);
  await page.getByRole('button', {name: 'Einrichtung abschließen'}).click();
  await expect(page.locator('#message')).toContainText('interne Abhängigkeit');
  const other = await browser.newContext();
  try {
    await fixture.attach(other);
    const second = await other.newPage();
    await second.goto(origin + '/setup');
    await enterCode(second);
    await expect(second.getByLabel('Benutzername', {exact: true})).toHaveValue('example-admin');
    await expect(second.getByLabel('E-Mail', {exact: true})).toHaveValue('admin@example.com');
    await expect(second.getByLabel('Passwort', {exact: true})).toBeEmpty();
    await expect(second.getByLabel('Passwort bestätigen')).toBeEmpty();
    fixture.state.failComplete = false;
    await fillAdmin(second);
    await second.getByRole('button', {name: 'Einrichtung abschließen'}).click();
    await expect(second.getByRole('heading', {name: 'Einrichtung abgeschlossen'})).toBeVisible();
    expect(fixture.state.completions).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Einrichtung abgeschlossen'})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Grundkonfiguration'})).not.toBeVisible();
  } finally { await other.close(); }
});

test('expired session during completion preserves this browser draft after signing in again', async ({page, context}) => {
  const fixture = setupFixture('Pending');
  await fixture.attach(context);
  await page.goto(origin + '/setup');
  await enterCode(page);
  await fillAdmin(page);
  await page.getByLabel('Appliance-Name').fill('Unsaved Browser Draft');
  fixture.state.sessions.clear();
  await page.getByRole('button', {name: 'Einrichtung abschließen'}).click();
  await expect(page.locator('#message')).toContainText('Deine Eingaben bleiben');
  await enterCode(page);
  await expect(page.getByLabel('Appliance-Name')).toHaveValue('Unsaved Browser Draft');
  await expect(page.getByLabel('Benutzername', {exact: true})).toHaveValue('example-admin');
  await expect(page.getByRole('button', {name: 'Einrichtung abschließen'})).toBeEnabled();
});
