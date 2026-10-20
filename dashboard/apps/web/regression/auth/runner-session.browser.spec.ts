import {test, expect, type BrowserContext} from '@playwright/test';
import {createServer, type Server} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ensureDashboardSession, realLogin, type RealLoginOptions} from '../core/auth.ts';
import {writePrivate} from '../core/private-files.ts';
import type {LabConfig} from '../core/config.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {OwnedKeyClient} from '../core/owned-key.ts';
import {HarnessError} from '../core/errors.ts';

/** Synthetic loopback HTTP only; accepted live lab configuration requires
 * verified HTTPS. No appliance credentials, cluster access or product writes. */
async function identityFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'runner-session-'));
  const username = 'fixture-admin', password = 'synthetic-password', subject = 'fixture-subject';
  await writePrivate(join(directory, 'username'), username);
  await writePrivate(join(directory, 'password'), password);
  const state = {dashboard: '', identity: '', token: 0, expired: false, loginPosts: 0, reads: 0, writes: 0,
    subject, roles: ['magicstick-admin'], status: 200, unavailable: false, callbackDelay: 0, silentRenewal: false,
    writeOnLoad: false, initialPassword: '', initialLogins: 0, currentLogins: 0, resets: 0};
  const identity = createServer((request, response) => {
    if (state.unavailable) { response.writeHead(503); response.end(); return; }
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const form = new URLSearchParams(body);
        if (request.url === '/reset-password') {
          if (form.get('password-new') !== password || form.get('password-confirm') !== password) {
            response.writeHead(401); response.end(); return;
          }
          state.resets++;
        } else {
          state.loginPosts++;
          if (form.get('username') !== username || ![password, state.initialPassword].filter(Boolean).includes(form.get('password') ?? '')) {
            response.writeHead(401); response.end(); return;
          }
          if (form.get('password') === state.initialPassword) {
            state.initialLogins++;
            response.writeHead(302, {Location: state.identity + '/reset-password'}); response.end(); return;
          }
          state.currentLogins++;
        }
        state.token++; state.expired = false;
        response.writeHead(302, {Location: state.dashboard + '/oauth2/callback'}); response.end();
      }); return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url === '/reset-password' ?
      '<form method="post"><input name="password-new"><input name="password-confirm"><button type="submit">Update</button></form>' :
      '<form method="post"><input id="username" name="username"><input id="password" name="password" type="password"><button id="kc-login">Sign in</button></form>');
  });
  const dashboard = createServer((request, response) => {
    const authenticated = !state.expired && request.headers.cookie?.includes(`fixture-session=${state.token}`);
    if (request.url === '/api/session') {
      state.reads++;
      response.setHeader('Content-Type', 'application/json');
      response.writeHead(authenticated ? state.status : 401);
      response.end(JSON.stringify({subject: state.subject, username, roles: state.roles})); return;
    }
    if (request.url === '/api/api-access' && request.method === 'POST') {
      state.writes++;
      response.writeHead(authenticated ? 200 : 401, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({item: {id: 'fixture-key-00000001', name: 'reg-fixture-key'}, key: 'sk-synthetic-unused'})); return;
    }
    if (request.url === '/oauth2/callback') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>setTimeout(() => location.replace('/'), ${state.callbackDelay})</script>`); return;
    }
    if (state.silentRenewal && state.token && state.expired) { state.token++; state.expired = false; }
    if (state.token && !state.expired) {
      response.setHeader('Set-Cookie', `fixture-session=${state.token}; HttpOnly; SameSite=Lax; Path=/`);
      response.setHeader('Content-Type', 'text/html');
      response.end('<h1>Fixture dashboard</h1>' + (state.writeOnLoad ?
        '<script>fetch("/api/api-access", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"reg-fixture-key"})}).catch(()=>{})</script>' : '')); return;
    }
    response.writeHead(302, {Location: state.identity + '/login'}); response.end();
  });
  for (const server of [identity, dashboard]) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = (server: Server) => `http://127.0.0.1:${(server.address() as {port: number}).port}`;
  state.dashboard = origin(dashboard); state.identity = origin(identity);
  const config: LabConfig = {version: 1, profile: 'preflight', dashboardUrl: state.dashboard, identityUrl: state.identity,
    usernameFile: join(directory, 'username'), passwordFile: join(directory, 'password'), observerKubeconfig: 'unused',
    requestTimeoutMs: 3000, loginTimeoutMs: 3000, expected: {applianceUid: 'fixture-appliance', applianceName: 'local',
      applianceNamespace: 'ai-system', role: 'magicstick-admin', nodes: [], capabilities: [], images: []}};
  return {state, config, username, password, subject, close: async () => {
    await Promise.all([identity, dashboard].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await rm(directory, {recursive: true, force: true});
  }};
}

function foundation(context: BrowserContext, config: LabConfig, assertHeld: () => Promise<void>): LiveFoundation {
  // Initialize the real instance fields, replacing only its independent Lease
  // store. Neither the constructor nor this synthetic guard uses kubectl.
  const selection = {...config, modelCleanupKubeconfig: 'unused',
    lock: {namespace: 'magicstick-regression', name: 'lab-lock', kubeconfig: 'unused'}};
  return Object.assign(Reflect.construct(LiveFoundation, [context, selection,
    {prefix: 'reg-fixture-', entries: [], runId: 'reg-11111111-2222-3333-4444-555555555555'},
    {observer: {}, api: {}}, new Set()]), {lease: {assertHeld}});
}

test('HAR-01 K8S-05 only the explicit private export login accepts browser downloads', async ({browser}) => {
  const fixture=await identityFixture();
  try {for(const allowed of [false,true]) {
    fixture.state.token=0;
    const context=await realLogin(browser,fixture.config,allowed?{allowPrivateDownloads:true}:{});
    try {
      const page=await context.newPage();await page.goto(fixture.config.dashboardUrl);
      await page.route(fixture.config.dashboardUrl+'/fixture-download',route=>route.fulfill({status:200,
        headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="synthetic.txt"'},body:'synthetic'}));
      await page.setContent('<a href="/fixture-download">Synthetic download</a>');
      const received=page.waitForEvent('download');await page.getByRole('link',{name:'Synthetic download'}).click();
      const download=await received;
      expect(await download.failure()===null).toBe(allowed);await download.delete();
    }finally{await context.close();}
  }}finally{await fixture.close();}
});

test('HAR-01 HAR-09 gateway callback completes before the authenticated session is verified', async ({browser}) => {
  const fixture = await identityFixture(); fixture.state.callbackDelay = 250;
  let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config);
    expect(fixture.state.reads).toBe(1); expect(fixture.state.loginPosts).toBe(1);
    await ensureDashboardSession(context);
    expect(fixture.state.loginPosts).toBe(1);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-04 HAR-06 HAR-09 guarded cleanup renews the same browser identity without replaying writes', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config);
    const order: string[] = [];
    const live = foundation(context, fixture.config, async () => { order.push('lease'); });
    const keys = new OwnedKeyClient(context.request, fixture.config.dashboardUrl, 3000, 'reg-fixture-', [], live.guard);
    await keys.create('reg-fixture-key');
    fixture.state.expired = true;
    await keys.create('reg-fixture-key');
    expect(fixture.state.writes).toBe(2); expect(fixture.state.loginPosts).toBe(2);
    expect(order).toEqual(['lease', 'lease', 'lease', 'lease']);
    expect(context.pages()).toHaveLength(0);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-09 concurrent expired-session checks share one bounded SSO renewal', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config); fixture.state.expired = true;
    await Promise.all([ensureDashboardSession(context), ensureDashboardSession(context), ensureDashboardSession(context)]);
    expect(fixture.state.loginPosts).toBe(2); expect(fixture.state.reads).toBe(3);
    expect(fixture.state.writes).toBe(0);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-09 existing IdP SSO can renew silently without replaying a login form', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config); fixture.state.expired = true; fixture.state.silentRenewal = true;
    await ensureDashboardSession(context);
    expect(fixture.state.loginPosts).toBe(1); expect(fixture.state.reads).toBe(3);
    expect(fixture.state.token).toBe(2); expect(fixture.state.writes).toBe(0);
  } finally { await context?.close(); await fixture.close(); }
});

for (const mismatch of ['subject', 'role'] as const) test(`HAR-01 HAR-06 ${mismatch} drift permanently fences the bound runner session`, async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config); fixture.state.expired = true;
    if (mismatch === 'subject') fixture.state.subject = 'different-subject'; else fixture.state.roles = ['magicstick-user'];
    await expect(ensureDashboardSession(context)).rejects.toMatchObject({code: 'AUTH', outcome: 'Failed', stage: 'login-session'});
    const reads = fixture.state.reads, logins = fixture.state.loginPosts;
    fixture.state.subject = fixture.subject; fixture.state.roles = ['magicstick-admin'];
    await expect(ensureDashboardSession(context)).rejects.toMatchObject({code: 'AUTH', outcome: 'Failed'});
    expect(fixture.state.reads).toBe(reads); expect(fixture.state.loginPosts).toBe(logins);
    expect(context.pages()).toHaveLength(0); expect(fixture.state.writes).toBe(0);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-09 forbidden and unavailable session reads fail without reauthentication', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config);
    for (const status of [403, 503]) {
      fixture.state.status = status; const reads = fixture.state.reads;
      await expect(ensureDashboardSession(context)).rejects.toMatchObject({code: 'API', outcome: 'Failed'});
      expect(fixture.state.reads).toBe(reads + 1); expect(fixture.state.loginPosts).toBe(1);
    }
    fixture.state.status = 200; await ensureDashboardSession(context);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-06 failed renewal remains Failed and cannot revive a runner', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config); fixture.state.expired = true; fixture.state.unavailable = true;
    await expect(ensureDashboardSession(context)).rejects.toMatchObject({code: 'AUTH', outcome: 'Failed', stage: 'login-form'});
    fixture.state.unavailable = false;
    await expect(ensureDashboardSession(context)).rejects.toMatchObject({code: 'AUTH', outcome: 'Failed'});
    expect(fixture.state.loginPosts).toBe(1); expect(fixture.state.writes).toBe(0);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-09 failed initial authentication is Failed rather than a missing prerequisite', async ({browser}) => {
  const fixture = await identityFixture(); fixture.state.unavailable = true;
  try {
    await expect(realLogin(browser, fixture.config)).rejects.toMatchObject({code: 'AUTH', outcome: 'Failed', stage: 'login-form'});
    expect(fixture.state.writes).toBe(0);
  } finally { await fixture.close(); }
});

test('HAR-04 HAR-11 sign-in pages cannot submit an armed product write during renewal', async ({browser}) => {
  const fixture = await identityFixture(); fixture.state.writeOnLoad = true;
  let context: BrowserContext | undefined, guards = 0;
  const options: RealLoginOptions = {allowedDashboardRequests: () => [{method: 'POST', path: '/api/api-access', body: {name: 'reg-fixture-key'}}],
    assertMutationAllowed: async () => { guards++; }};
  try {
    context = await realLogin(browser, fixture.config, options); fixture.state.expired = true;
    await ensureDashboardSession(context);
    expect(guards).toBe(0); expect(fixture.state.writes).toBe(0);
    expect(fixture.state.loginPosts).toBe(2);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-01 HAR-11 disposable-user renewal uses the current password without replaying initial setup', async ({browser}) => {
  const fixture = await identityFixture(); fixture.state.initialPassword = 'synthetic-initial-password';
  fixture.state.roles = ['magicstick-operator']; let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config, {actor: {username: fixture.username, password: fixture.password,
      initialPassword: fixture.state.initialPassword, subject: fixture.subject, role: 'magicstick-operator'}});
    fixture.state.expired = true; await ensureDashboardSession(context);
    expect(fixture.state.initialLogins).toBe(1); expect(fixture.state.currentLogins).toBe(1);
    expect(fixture.state.resets).toBe(1);
  } finally { await context?.close(); await fixture.close(); }
});

test('HAR-04 HAR-09 renewed authentication cannot bypass a lost Lease or send its pending write', async ({browser}) => {
  const fixture = await identityFixture(); let context: BrowserContext | undefined;
  try {
    context = await realLogin(browser, fixture.config); fixture.state.expired = true;
    const live = foundation(context, fixture.config, async () => { if (fixture.state.loginPosts > 1) throw new HarnessError('LOCK_LOST'); });
    const keys = new OwnedKeyClient(context.request, fixture.config.dashboardUrl, 3000, 'reg-fixture-', [], live.guard);
    await expect(keys.create('reg-fixture-key')).rejects.toMatchObject({code: 'LOCK_LOST'});
    expect(fixture.state.loginPosts).toBe(2); expect(fixture.state.writes).toBe(0);
  } finally { await context?.close(); await fixture.close(); }
});
