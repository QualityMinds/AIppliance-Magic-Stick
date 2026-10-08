import {test, expect} from '@playwright/test';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat, mkdtemp, readFile, rm} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {request as httpRequest} from 'node:http';
import type {BrowserContext} from '@playwright/test';
import type {ApiAccessPayload, KubernetesAccessPayload, Session} from '@magicstick/dashboard-contracts';
import {setupFacts, sameSetupTarget, callbackCode, oidcMetadata, validateSetupIdToken, withSetupAdmin, setupOidcToken} from '../core/setup-bootstrap.ts';
import {readPrivate, withPrivateCommandInput} from '../core/private-files.ts';

const issuer = 'https://id.lab.example.test/realms/magicstick';
const session: Session = {subject: 'subject-id', username: 'synthetic-admin', roles: ['magicstick-admin'],
  identityManagementAvailable: true, identityManagementMode: 'keycloak'};
const access: KubernetesAccessPayload = {users: [{id: session.subject, username: session.username, enabled: true, accessLevel: 'none'}],
  first: 0, max: 100, total: 1, configuration: {configured: true, issuerUrl: issuer, clientId: 'magicstick-kubernetes', apiServer: 'https://kubernetes.example.test:6443'}};
const bases: ApiAccessPayload = {items: [], total: 0, apiBases: [{scope: 'local', url: 'https://inference.lab.example.test/v1'}]};
function facts() {return setupFacts('https://lab.example.test', 'https://id.lab.example.test', session, access, bases, 'appliance-uid');}
const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength: 2048});
const jwks = {keys: [{...publicKey.export({format: 'jwk'}), kid: 'synthetic', alg: 'RS256', use: 'sig'}]};
const now = 1_800_000_000_000;
function idToken(changes: Record<string, unknown> = {}, headerChanges: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({alg: 'RS256', kid: 'synthetic', ...headerChanges})).toString('base64url');
  const payload = Buffer.from(JSON.stringify({iss: issuer, sub: 'subject-id', aud: 'magicstick-kubernetes', nonce: 'synthetic-nonce',
    groups: ['/magicstick-kubernetes-admin'], iat: now / 1000, exp: now / 1000 + 300, ...changes})).toString('base64url');
  return header + '.' + payload + '.' + sign('RSA-SHA256', Buffer.from(header + '.' + payload), privateKey).toString('base64url');
}

function callbackStatus(url: string, host = 'localhost:8000') {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, {hostname: '127.0.0.1', headers: {Host: host}}, response => {
      response.resume(); response.on('end', () => resolve(response.statusCode!));
      response.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('Synthetic callback timeout')));
    req.on('error', reject); req.end();
  });
}

test('HAR-10 bootstrap patch input is a private reopenable file removed after success and failure', async () => {
  for(const fail of [false, true]) {
    let filename = '';
    const result = withPrivateCommandInput({marker: 'synthetic'}, async path => {
      filename = path;
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
      execFileSync(process.execPath, ['--input-type=module', '-e',
        'import {readFileSync} from "node:fs"; if(JSON.parse(readFileSync(process.argv[1],"utf8")).marker!=="synthetic")process.exit(1)', path], {stdio: 'pipe'});
      if(fail)throw new Error('Synthetic command failure');
      return 'complete';
    });
    if(fail)await expect(result).rejects.toThrow('Synthetic command failure');
    else expect(await result).toBe('complete');
    await expect(readPrivate(filename)).rejects.toThrow();
    await expect(lstat(dirname(filename))).rejects.toThrow();
  }
});

test('HAR-10 simplified setup discovers endpoints and the exact enabled self account from shared API contracts', () => {
  expect(facts()).toMatchObject({identityUrl: 'https://id.lab.example.test', inferenceUrl: 'https://inference.lab.example.test',
    kubernetesApiUrl: 'https://kubernetes.example.test:6443', accessLevel: 'none', subject: 'subject-id'});
  const both = {...bases, apiBases: [...bases.apiBases!, {scope: 'public', url: 'https://public.example.test/v1'}]};
  expect(setupFacts('https://lab.example.local', 'https://id.lab.example.test', session, access, both, 'appliance-uid').inferenceUrl)
    .toBe('https://inference.lab.example.test');
  expect(setupFacts('https://public.lab.example.test', 'https://id.lab.example.test', session, access, both, 'appliance-uid').inferenceUrl)
    .toBe('https://public.example.test');
});

test('HAR-10 setup rejects ambiguous users, disabled accounts, missing Kubernetes OIDC and unsafe endpoint contracts', () => {
  for(const users of [[], [...access.users, ...access.users], [{...access.users[0]!, enabled: false}],
    [{...access.users[0]!, id: 'foreign-subject'}], [{...access.users[0]!, accessLevel: 'owner'}]]) {
    expect(() => setupFacts('https://lab.example.test', 'https://id.lab.example.test', session, {...access, users}, bases, 'appliance-uid')).toThrow();
  }
  for(const configuration of [{...access.configuration, configured: false}, {...access.configuration, issuerUrl: 'https://foreign.example.test'},
    {...access.configuration, apiServer: 'http://kubernetes.example.test'}, {...access.configuration, apiServer: 'https://user:password@kubernetes.example.test'}]) {
    expect(() => setupFacts('https://lab.example.test', 'https://id.lab.example.test', session, {...access, configuration}, bases, 'appliance-uid')).toThrow();
  }
  for(const url of ['http://inference.example.test/v1', 'https://user:password@inference.example.test/v1',
    'https://inference.example.test/v1?token=synthetic', 'https://inference.example.test/unexpected']) {
    expect(() => setupFacts('https://lab.example.test', 'https://id.lab.example.test', session, access,
      {...bases, apiBases: [{scope: 'local', url}]}, 'appliance-uid')).toThrow();
  }
});

test('HAR-10 bootstrap target cannot change between discovery, consent, token generation and access restoration', () => {
  const reviewed = facts();
  for(const key of ['dashboardUrl', 'identityUrl', 'inferenceUrl', 'kubernetesApiUrl', 'subject', 'username', 'applianceUid', 'accessLevel']) {
    expect(() => sameSetupTarget({...reviewed, [key]: 'foreign'}, reviewed)).toThrow();
  }
  expect(() => sameSetupTarget({...reviewed, accessLevel: 'admin'}, reviewed, false)).not.toThrow();
});

test('HAR-10 temporary setup admin grants require explicit consent and restore before releasing the result', async () => {
  const steps: string[] = [];
  const adapters = {save: async () => {steps.push('save');}, grant: async () => {steps.push('grant');}, restore: async () => {steps.push('restore');}};
  await expect(withSetupAdmin(facts(), false, adapters, async () => 'synthetic-token')).rejects.toThrow();
  expect(steps).toEqual([]);
  const result = await withSetupAdmin(facts(), true, adapters, async () => {steps.push('authorize'); return 'synthetic-token';});
  expect(result).toBe('synthetic-token'); expect(steps).toEqual(['save', 'grant', 'authorize', 'restore']);
  steps.length = 0;
  await withSetupAdmin({...facts(), accessLevel: 'admin'}, false, adapters, async () => 'synthetic-token');
  expect(steps).toEqual([]);
});

test('HAR-10 failed grant or token request always restores access and failed restoration releases no token', async () => {
  for(const failure of ['grant', 'authorize', 'restore']) {
    const steps: string[] = [];
    const step = async (name: string) => {steps.push(name); if(name === failure) throw new Error('synthetic failure');};
    await expect(withSetupAdmin(facts(), true, {save: () => step('save'), grant: () => step('grant'), restore: () => step('restore')},
      async () => {await step('authorize'); return 'synthetic-token';})).rejects.toThrow();
    expect(steps.at(-1)).toBe('restore');
  }
});

test('HAR-10 OIDC setup uses only the configured issuer and registered PKCE endpoints', () => {
  const metadata = {issuer, authorization_endpoint: issuer + '/protocol/openid-connect/auth', token_endpoint: issuer + '/protocol/openid-connect/token',
    jwks_uri: issuer + '/protocol/openid-connect/certs', code_challenge_methods_supported: ['S256']};
  expect(oidcMetadata(metadata, issuer).token).toBe(metadata.token_endpoint);
  for(const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
    expect(() => oidcMetadata({...metadata, [key]: 'https://foreign.example.test'}, issuer)).toThrow();
  }
  expect(() => oidcMetadata({...metadata, code_challenge_methods_supported: ['plain']}, issuer)).toThrow();
});

test('HAR-10 OIDC callback accepts a single exact state and never connects to an open arbitrary loopback endpoint', () => {
  const url = 'http://localhost:8000/?state=synthetic-state&code=synthetic-code';
  expect(callbackCode(new URL(url), 'synthetic-state', issuer)).toBe('synthetic-code');
  for(const changed of [url.replace('8000', '18000'), url.replace('localhost', '127.0.0.1'), url.replace('synthetic-state', 'foreign'),
    url + '&state=synthetic-state', url + '&code=other', url + '&error=access_denied', url + '&iss=https%3A%2F%2Fforeign.example.test', url + '#fragment']) {
    expect(() => callbackCode(new URL(changed), 'synthetic-state', issuer)).toThrow();
  }
});

test('HAR-10 Kubernetes setup ID token validates realm signature, correct audience, nonce, subject, group and short lifetime', () => {
  const token = idToken();
  expect(validateSetupIdToken(token, jwks, issuer, 'subject-id', 'synthetic-nonce', now)).toBe(token);
  for(const changes of [{iss: 'https://foreign.example.test'}, {sub: 'foreign-subject'}, {aud: 'magicstick-dashboard'}, {nonce: 'foreign'},
    {groups: ['/magicstick-admin']}, {exp: now / 1000 + 30}, {exp: now / 1000 + 7200}, {iat: now / 1000 + 60}, {nbf: now / 1000 + 60}]) {
    expect(() => validateSetupIdToken(idToken(changes), jwks, issuer, 'subject-id', 'synthetic-nonce', now)).toThrow();
  }
  expect(() => validateSetupIdToken(idToken({}, {alg: 'none'}), jwks, issuer, 'subject-id', 'synthetic-nonce', now)).toThrow();
  expect(() => validateSetupIdToken(token, {keys: []}, issuer, 'subject-id', 'synthetic-nonce', now)).toThrow();
  expect(() => validateSetupIdToken(token.slice(0, -8) + 'tampered', jwks, issuer, 'subject-id', 'synthetic-nonce', now)).toThrow();
});

test('HAR-10 setup SSO serves the exact loopback callback and exchanges its code through PKCE', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-oidc-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'ca.pem'), '-subj', '/CN=Synthetic Regression CA', '-days', '1', '-addext', 'basicConstraints=critical,CA:TRUE'], {stdio: 'pipe'});
    const ca = await readFile(join(directory, 'ca.pem'), 'utf8');
    let handler: any, authorization: URL, finalUrl = '', continued = false, closed = false;
    const page = {
      route: async (_pattern: string, callback: any) => {handler = callback;},
      goto: async (url: string) => {
        authorization = new URL(url);
        expect(authorization.searchParams.get('prompt')).toBe('none');
        expect(authorization.searchParams.get('code_challenge_method')).toBe('S256');
        expect(authorization.searchParams.get('redirect_uri')).toBe('http://localhost:8000');
        finalUrl = 'http://localhost:8000/?' + new URLSearchParams({code: 'synthetic-code', state: authorization.searchParams.get('state')!});
        await handler({request: () => ({method: () => 'GET', url: () => finalUrl}),
          continue: async () => {continued = true;}, abort: async () => {throw new Error('Synthetic unexpected callback rejection');}});
        expect(await callbackStatus(finalUrl)).toBe(200);
      },
      url: () => finalUrl,
      close: async () => {closed = true;},
    };
    const calls: string[] = [];
    const fetchIssuer = async (url: string, trust: string, body?: URLSearchParams) => {
      calls.push(url); expect(trust).toBe(ca);
      if(url.endsWith('/.well-known/openid-configuration')) return {issuer, code_challenge_methods_supported: ['S256'],
        authorization_endpoint: issuer + '/protocol/openid-connect/auth', token_endpoint: issuer + '/protocol/openid-connect/token',
        jwks_uri: issuer + '/protocol/openid-connect/certs'};
      if(url.endsWith('/token')) {
        expect(body?.get('grant_type')).toBe('authorization_code');
        expect(body?.get('code')).toBe('synthetic-code');
        expect(body?.has('password')).toBe(false); expect(body?.has('client_secret')).toBe(false);
        expect(createHash('sha256').update(body!.get('code_verifier')!).digest('base64url'))
          .toBe(authorization.searchParams.get('code_challenge'));
        const seconds = Math.floor(Date.now() / 1000);
        return {id_token: idToken({nonce: authorization.searchParams.get('nonce'), iat: seconds, exp: seconds + 300})};
      }
      expect(url).toBe(issuer + '/protocol/openid-connect/certs'); return jwks;
    };
    const context = {newPage: async () => page} as unknown as BrowserContext;
    const token = await setupOidcToken(context, {issuer, client: 'magicstick-kubernetes', issuerCa: Buffer.from(ca).toString('base64')},
      'subject-id', ca, fetchIssuer);
    expect(token.split('.')).toHaveLength(3); expect(continued && closed).toBe(true);
    expect(calls).toHaveLength(3);
  } finally {await rm(directory, {recursive: true, force: true});}
});

test('HAR-10 [layer:B] Chromium follows the issuer redirect to a real validated OIDC listener', async ({browser}) => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-oidc-browser-'));
  const context = await browser.newContext();
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
      '-out', join(directory, 'ca.pem'), '-subj', '/CN=Synthetic Regression CA', '-days', '1', '-addext', 'basicConstraints=critical,CA:TRUE'], {stdio: 'pipe'});
    const ca = await readFile(join(directory, 'ca.pem'), 'utf8');
    let authorization: URL | undefined, tokenRequests = 0;
    await context.route(issuer + '/protocol/openid-connect/auth*', async route => {
      authorization = new URL(route.request().url());
      const callback = 'http://localhost:8000/?' + new URLSearchParams({code: 'synthetic-code',
        state: authorization.searchParams.get('state')!, iss: issuer});
      expect(await callbackStatus(callback, 'foreign.example.test')).toBe(400);
      expect(await callbackStatus(callback.replace(authorization.searchParams.get('state')!, 'foreign-state'))).toBe(400);
      expect(tokenRequests).toBe(0);
      await route.fulfill({status: 302, headers: {Location: callback}});
    });
    const fetchIssuer = async (url: string, trust: string, body?: URLSearchParams) => {
      expect(trust).toBe(ca);
      if(url.endsWith('/.well-known/openid-configuration')) return {issuer, code_challenge_methods_supported: ['S256'],
        authorization_endpoint: issuer + '/protocol/openid-connect/auth', token_endpoint: issuer + '/protocol/openid-connect/token',
        jwks_uri: issuer + '/protocol/openid-connect/certs'};
      if(url.endsWith('/token')) {
        tokenRequests++;
        expect(body?.get('grant_type')).toBe('authorization_code');
        expect(body?.get('code')).toBe('synthetic-code');
        expect(createHash('sha256').update(body!.get('code_verifier')!).digest('base64url'))
          .toBe(authorization!.searchParams.get('code_challenge'));
        const seconds = Math.floor(Date.now() / 1000);
        return {id_token: idToken({nonce: authorization!.searchParams.get('nonce'), iat: seconds, exp: seconds + 300})};
      }
      expect(url).toBe(issuer + '/protocol/openid-connect/certs'); return jwks;
    };
    const token = await setupOidcToken(context, {issuer, client: 'magicstick-kubernetes', issuerCa: Buffer.from(ca).toString('base64')},
      'subject-id', ca, fetchIssuer);
    expect(token.split('.')).toHaveLength(3); expect(tokenRequests).toBe(1);
    expect(context.pages()).toHaveLength(0);
    await expect(callbackStatus('http://localhost:8000/')).rejects.toThrow();
  } finally {await context.close(); await rm(directory, {recursive: true, force: true});}
});
