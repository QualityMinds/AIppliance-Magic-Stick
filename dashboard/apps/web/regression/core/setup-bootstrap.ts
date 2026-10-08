import {createHash, createPublicKey, randomBytes, verify, X509Certificate} from 'node:crypto';
import {request} from 'node:https';
import {createServer} from 'node:http';
import type {BrowserContext} from '@playwright/test';
import type {ApiAccessPayload, KubernetesAccessPayload, Session} from '@magicstick/dashboard-contracts';
import {HarnessError, requireSafe} from './errors.ts';

export interface SetupFacts {
  version: 1;
  dashboardUrl: string;
  identityUrl: string;
  inferenceUrl: string;
  kubernetesApiUrl: string;
  subject: string;
  username: string;
  accessLevel: 'none' | 'viewer' | 'operator' | 'admin';
  applianceUid: string;
}

/** Discovery comes from existing authenticated contracts, never hostname guesses. */
export function setupFacts(dashboardUrl: string, identityUrl: string, session: Session,
  access: KubernetesAccessPayload, bases: ApiAccessPayload, applianceUid: string): SetupFacts {
  const self = access.users.filter(user => user.id === session.subject && user.username === session.username);
  requireSafe(session.roles.includes('magicstick-admin') && self.length === 1 && self[0]?.enabled === true &&
    ['none', 'viewer', 'operator', 'admin'].includes(self[0]?.accessLevel ?? '') &&
    /^[a-zA-Z0-9-]{1,64}$/.test(session.subject) && /^[a-zA-Z0-9-]{1,64}$/.test(applianceUid), 'AUTH');
  const configuration = access.configuration;
  requireSafe(configuration?.configured === true && configuration.issuerUrl === identityUrl + '/realms/magicstick' &&
    configuration.clientId === 'magicstick-kubernetes', 'PREREQUISITE');
  requireSafe(typeof configuration.apiServer === 'string', 'API');
  const kube = new URL(configuration.apiServer);
  requireSafe(kube.protocol === 'https:' && !kube.username && !kube.password && !kube.search && !kube.hash && kube.pathname === '/', 'API');
  const preferredScope = new URL(dashboardUrl).hostname.endsWith('.local') ? 'local' : 'public';
  const candidates = bases.apiBases?.filter(base => base.scope === preferredScope) ?? [];
  // A single advertised endpoint is unambiguous even for a non-mDNS lab URL.
  const selected = candidates.length === 1 ? candidates[0] : bases.apiBases?.length === 1 ? bases.apiBases[0] : undefined;
  requireSafe(selected && typeof selected.url === 'string', 'API');
  const url = new URL(selected.url);
  requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
    ['/v1', '/v1/', '/'].includes(url.pathname), 'API');
  return {version: 1, dashboardUrl, identityUrl, inferenceUrl: url.origin, kubernetesApiUrl: kube.origin, subject: session.subject,
    username: session.username, accessLevel: self[0]!.accessLevel as SetupFacts['accessLevel'], applianceUid};
}

export function sameSetupTarget(current: SetupFacts, reviewed: SetupFacts, includeAccess = true) {
  requireSafe(['dashboardUrl', 'identityUrl', 'inferenceUrl', 'kubernetesApiUrl', 'subject', 'username', 'applianceUid']
    .every(key => current[key as keyof SetupFacts] === reviewed[key as keyof SetupFacts]) &&
    (!includeAccess || current.accessLevel === reviewed.accessLevel), 'IDENTITY');
}

/** The result is not returned until prior access is independently restored.
 * Save-before-grant enables explicit recovery even if the process is killed. */
export async function withSetupAdmin<T>(facts: SetupFacts, approved: boolean, steps: {
  save: () => Promise<void>; grant: () => Promise<void>; restore: () => Promise<void>;
}, action: () => Promise<T>): Promise<T> {
  if(facts.accessLevel === 'admin') return action();
  requireSafe(approved === true, 'PREREQUISITE');
  await steps.save();
  try {await steps.grant(); return await action();}
  finally {await steps.restore();}
}

export async function issuerJson(url: string, ca: string, body?: URLSearchParams): Promise<Record<string, any>> {
  requireSafe(new URL(url).protocol === 'https:' && !new URL(url).username && !new URL(url).password, 'TLS');
  return new Promise((resolve, reject) => {
    const req = request(url, {ca, rejectUnauthorized: true, method: body ? 'POST' : 'GET', headers: {Accept: 'application/json',
      ...(body ? {'Content-Type': 'application/x-www-form-urlencoded'} : {})}}, response => {
      let raw = Buffer.alloc(0);
      response.on('data', (chunk: Buffer) => {raw = Buffer.concat([raw, chunk]); if (raw.length > 256 * 1024) req.destroy();});
      response.on('end', () => {
        try {
          requireSafe(response.statusCode === 200 && (response.headers['content-type'] ?? '').includes('application/json'), 'AUTH');
          resolve(JSON.parse(raw.toString()));
        } catch {reject(new HarnessError('AUTH'));}
      });
    });
    req.setTimeout(15_000, () => req.destroy());
    req.on('error', () => reject(new HarnessError('AUTH')));
    req.end(body?.toString());
  });
}

export function oidcMetadata(value: Record<string, any>, issuer: string) {
  requireSafe(value.issuer === issuer, 'AUTH');
  for (const [key, suffix] of [['authorization_endpoint', 'auth'], ['token_endpoint', 'token'], ['jwks_uri', 'certs']]) {
    requireSafe(value[key!] === issuer + '/protocol/openid-connect/' + suffix, 'AUTH');
  }
  requireSafe(value.code_challenge_methods_supported?.includes('S256'), 'AUTH');
  return {authorization: String(value.authorization_endpoint), token: String(value.token_endpoint), jwks: String(value.jwks_uri)};
}

export function callbackCode(url: URL, state: string, issuer: string) {
  requireSafe(url.origin === 'http://localhost:8000' && url.pathname === '/' && !url.hash && !url.username && !url.password &&
    [...url.searchParams.keys()].every(key => ['code', 'state', 'session_state', 'iss'].includes(key)) &&
    url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state &&
    url.searchParams.getAll('code').length === 1 && (!url.searchParams.has('iss') ||
      url.searchParams.getAll('iss').length === 1 && url.searchParams.get('iss') === issuer), 'AUTH');
  const code = url.searchParams.get('code');
  requireSafe(code && code.length < 8192 && !/[\s\0]/.test(code), 'AUTH');
  return code;
}

/** Kubernetes accepts the ID token, not a Dashboard/CLI access token. Verify
 * the realm signature, nonce, audience, lifetime, subject and admin group. */
export function validateSetupIdToken(token: unknown, jwks: Record<string, any>, issuer: string,
  subject: string, nonce: string, now = Date.now()) {
  requireSafe(typeof token === 'string' && token.length < 32 * 1024, 'AUTH');
  const pieces = token.split('.');
  requireSafe(pieces.length === 3 && pieces.every(piece => /^[A-Za-z0-9_-]+$/.test(piece)), 'AUTH');
  let header: Record<string, any>, claims: Record<string, any>;
  try {
    header = JSON.parse(Buffer.from(pieces[0]!, 'base64url').toString());
    claims = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString());
    requireSafe(header.alg === 'RS256' && typeof header.kid === 'string' && !header.jku && !header.jwk && !header.x5u && !header.crit, 'AUTH');
    const keys = jwks.keys?.filter((key: Record<string, any>) => key.kid === header.kid && key.kty === 'RSA' &&
      (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
    requireSafe(keys?.length === 1, 'AUTH');
    const key = createPublicKey({key: keys[0], format: 'jwk'});
    requireSafe(verify('RSA-SHA256', Buffer.from(pieces[0] + '.' + pieces[1]), key,
      Buffer.from(pieces[2]!, 'base64url')), 'AUTH');
  } catch {throw new HarnessError('AUTH');}
  const seconds = now / 1000;
  requireSafe(claims.iss === issuer && claims.sub === subject && claims.nonce === nonce &&
    (claims.aud === 'magicstick-kubernetes' || Array.isArray(claims.aud) && claims.aud.includes('magicstick-kubernetes') &&
      claims.azp === 'magicstick-kubernetes') &&
    Number.isSafeInteger(claims.exp) && Number.isSafeInteger(claims.iat) && claims.exp > seconds + 120 &&
    claims.iat <= seconds + 30 && claims.iat >= seconds - 300 && claims.exp - claims.iat <= 3600 &&
    (!claims.nbf || Number.isSafeInteger(claims.nbf) && claims.nbf <= seconds) &&
    Array.isArray(claims.groups) && claims.groups.includes('/magicstick-kubernetes-admin'), 'AUTH');
  return token;
}

export function publicIssuerCa(encoded: string) {
  const bundle = Buffer.from(encoded, 'base64').toString();
  const certificates = bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  requireSafe(bundle.length < 256 * 1024 && certificates.length > 0 && certificates.length < 20 && !bundle.includes('PRIVATE KEY'), 'TLS');
  for (const pem of certificates) {
    const cert = new X509Certificate(pem);
    requireSafe(cert.ca && Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now(), 'TLS');
  }
  return bundle;
}

/** Same existing Keycloak SSO session. The registered callback is served only
 * on IPv4 loopback: Chromium redirects can bypass Playwright route handlers.
 * State, issuer and PKCE still bind its one-time authorization code. */
export async function setupOidcToken(context: BrowserContext,
  oidc: {issuer: string; client: string; issuerCa: string}, subject: string, approvedCa?: string,
  fetchIssuer: typeof issuerJson = issuerJson) {
  requireSafe(oidc.client === 'magicstick-kubernetes', 'AUTH');
  const ca = publicIssuerCa(oidc.issuerCa);
  // The downloaded CA is allowed only after verified Dashboard authentication;
  // it must also be valid for the independently trusted issuer connection.
  const metadata = oidcMetadata(await fetchIssuer(oidc.issuer + '/.well-known/openid-configuration', approvedCa ?? ca), oidc.issuer);
  const state = randomBytes(32).toString('base64url'), nonce = randomBytes(32).toString('base64url'),
    verifier = randomBytes(48).toString('base64url');
  const authorization = new URL(metadata.authorization);
  authorization.search = new URLSearchParams({client_id: oidc.client, response_type: 'code', scope: 'openid',
    redirect_uri: 'http://localhost:8000', state, nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), prompt: 'none'}).toString();
  const page = await context.newPage();
  let code: string | undefined;
  const callback = createServer((incoming, response) => {
    try {
      const path = incoming.url;
      requireSafe(incoming.method === 'GET' && incoming.headers.host === 'localhost:8000' && !code &&
        typeof path === 'string' && path.startsWith('/') && path.length < 16 * 1024, 'AUTH');
      code = callbackCode(new URL(path, 'http://localhost:8000'), state, oidc.issuer);
      response.writeHead(200, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'", 'Connection': 'close'});
      response.end('Authentication complete.');
    } catch {
      response.writeHead(400, {'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Connection': 'close'});
      response.end('Authentication callback rejected.');
    }
  });
  callback.requestTimeout = 5000; callback.headersTimeout = 5000; callback.maxHeadersCount = 32;
  try {
    await new Promise<void>((resolve, reject) => {
      callback.once('error', () => reject(new HarnessError('AUTH')));
      callback.listen(8000, '127.0.0.1', resolve);
    });
    await page.route(url => url.origin === 'http://localhost:8000' && url.pathname === '/', async route => {
      try {
        requireSafe(route.request().method() === 'GET' && !code, 'AUTH');
        callbackCode(new URL(route.request().url()), state, oidc.issuer);
        await route.continue();
      } catch {await route.abort('blockedbyclient');}
    });
    await page.goto(authorization.href, {waitUntil: 'domcontentloaded', timeout: 45_000});
    requireSafe(code && new URL(page.url()).origin === 'http://localhost:8000', 'AUTH');
    const tokens = await fetchIssuer(metadata.token, approvedCa ?? ca, new URLSearchParams({grant_type: 'authorization_code',
      client_id: oidc.client, redirect_uri: 'http://localhost:8000', code, code_verifier: verifier}));
    return validateSetupIdToken(tokens.id_token, await fetchIssuer(metadata.jwks, approvedCa ?? ca), oidc.issuer, subject, nonce);
  } catch(error) {
    if(error instanceof HarnessError)throw error;
    throw new HarnessError('AUTH', 'Failed', 'login-return');
  } finally {
    callback.closeAllConnections();
    await new Promise<void>(resolve => callback.close(() => resolve()));
    await page.close();
  }
}
