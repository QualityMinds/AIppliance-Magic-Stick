import type {Browser, BrowserContext} from '@playwright/test';
import type {LabConfig} from './config.ts';
import {readPrivate} from './private-files.ts';
import {HarnessError, requireSafe, type Stage} from './errors.ts';
import {readOnlyApi} from './transport.ts';

export interface ExactDashboardRequest {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  body: unknown;
  /** Estimators and discovery helpers use POST but do not persist intent. */
  mutating?: boolean;
}

function canonicalJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { requireSafe(Number.isFinite(value), 'MUTATION'); return value; }
  if (Array.isArray(value)) return value.map(canonicalJson);
  requireSafe(value && typeof value === 'object', 'MUTATION');
  const source = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonicalJson(source[key])]));
}

export function allowedExactDashboardRequest(url: URL, method: string, body: unknown, dashboardOrigin: string,
  expected: readonly ExactDashboardRequest[]) {
  if (url.origin !== dashboardOrigin || url.search || url.hash) return undefined;
  return expected.find(item => item.method === method && item.path === url.pathname &&
    JSON.stringify(canonicalJson(item.body)) === JSON.stringify(canonicalJson(body)));
}

export function allowedOwnedStop(url: URL, method: string, body: unknown, dashboardOrigin: string,
  name?: string, uid?: string) {
  if (!name || !uid || url.origin !== dashboardOrigin || method !== 'POST' ||
    url.pathname !== `/api/models/${encodeURIComponent(name)}/stop` || url.search || url.hash ||
    !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  return Object.keys(fields).length === 1 && typeof fields.expectedRevision === 'string' &&
    /^generation:[^:]+:[1-9]\d*$/.test(fields.expectedRevision) &&
    fields.expectedRevision.split(':')[1] === uid;
}

function ownedRevision(body: unknown, uid?: string): body is {expectedRevision: string} {
  if (!uid || !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const revision = (body as {expectedRevision?: unknown}).expectedRevision;
  return typeof revision === 'string' && /^generation:[^:]+:[1-9]\d*$/.test(revision) && revision.split(':')[1] === uid;
}

export function allowedOwnedStart(url: URL, method: string, body: unknown, dashboardOrigin: string,
  name?: string, uid?: string) {
  return Boolean(name && url.origin === dashboardOrigin && method === 'POST' &&
    url.pathname === `/api/models/${encodeURIComponent(name)}/start` && !url.search && !url.hash &&
    ownedRevision(body, uid) && Object.keys(body).length === 1);
}

/** UI key writes are allowed only during the exact journal-owned action. */
export function allowedOwnedKeyChange(url: URL, method: string, body: unknown, dashboardOrigin: string,
  name?: string, id?: string) {
  if (url.origin !== dashboardOrigin || url.search || url.hash) return false;
  if (method === 'POST') return Boolean(name && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) &&
    url.pathname === '/api/api-access' && body && typeof body === 'object' && !Array.isArray(body) &&
    Object.keys(body).length === 1 && (body as {name?: unknown}).name === name);
  return Boolean(method === 'DELETE' && id && /^[A-Za-z0-9._:-]{16,256}$/.test(id) &&
    url.pathname === `/api/api-access/${encodeURIComponent(id)}` && body === null);
}

export function allowedOwnedContextEdit(url: URL, method: string, body: unknown, dashboardOrigin: string,
  name?: string, uid?: string, contextWindow?: number) {
  if (!name || !Number.isSafeInteger(contextWindow) || url.origin !== dashboardOrigin || method !== 'PUT' ||
    url.pathname !== `/api/models/${encodeURIComponent(name)}` || url.search || url.hash ||
    !ownedRevision(body, uid) || Object.keys(body).length !== 2) return false;
  const local = (body as {local?: unknown}).local;
  if (!local || typeof local !== 'object' || Array.isArray(local)) return false;
  const fields = local as Record<string, unknown>;
  return fields.contextWindow === contextWindow &&
    (Object.keys(fields).length === 1 ||
      (Object.keys(fields).length === 2 && fields.allowMemoryRisk === true));
}

/** The edit form's estimator is read-only despite using POST; fence its input to the owned CPU model. */
export function allowedOwnedEstimate(url: URL, method: string, body: unknown, dashboardOrigin: string,
  name?: string, uid?: string, memoryMi?: number) {
  if (!name || !uid || !Number.isSafeInteger(memoryMi) || url.origin !== dashboardOrigin || method !== 'POST' ||
    url.pathname !== `/api/models/${encodeURIComponent(name)}/estimate-memory` || url.search || url.hash ||
    !body || typeof body !== 'object' || Array.isArray(body)) return false;
  const fields = body as Record<string, unknown>;
  return Object.keys(fields).sort().join(',') ===
    'contextWindow,cpuOffloading,kvCacheType,maxNumSeqs,maxOutputTokens,memoryRequiredMi,modelType' &&
    fields.modelType === 'chat' && fields.cpuOffloading === false && fields.maxNumSeqs === 1 &&
    fields.memoryRequiredMi === memoryMi && Number.isSafeInteger(fields.contextWindow) &&
    Number(fields.contextWindow) >= 0 && Number(fields.contextWindow) <= 4096 &&
    typeof fields.kvCacheType === 'string' && fields.kvCacheType.length <= 16 &&
    (fields.maxOutputTokens === null || (Number.isSafeInteger(fields.maxOutputTokens) &&
      Number(fields.maxOutputTokens) > 0 && Number(fields.maxOutputTokens) <= 4096));
}

export interface RealLoginOptions {
  allowedStopName?: () => string | undefined;
  allowedStopUid?: () => string | undefined;
  allowedStart?: () => boolean;
  allowedEditContextWindow?: () => number | undefined;
  allowedEstimateMemoryMi?: () => number | undefined;
  allowedKeyName?: () => string | undefined;
  allowedKeyId?: () => string | undefined;
  allowedDashboardRequests?: () => readonly ExactDashboardRequest[];
  onBlockedMutation?: (request: {method: string; path: string}) => void;
  assertMutationAllowed?: () => Promise<void>;
  inferenceOrigin?: string;
}

export async function realLogin(browser: Browser, config: LabConfig, options: RealLoginOptions = {}): Promise<BrowserContext> {
  const username = (await readPrivate(config.usernameFile)).trim(), password = (await readPrivate(config.passwordFile)).trimEnd();
  requireSafe(username.length > 0 && password.length > 0, 'AUTH');
  const context = await browser.newContext({serviceWorkers: 'block', acceptDownloads: false});
  const origins = new Set([config.dashboardUrl, config.identityUrl,
    ...(options.inferenceOrigin ? [options.inferenceOrigin] : [])]);
  // The opt-in live runs permit only exact run-owned lifecycle/edit requests.
  // All other dashboard writes remain blocked even if the page adds an effect.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const allowedStopName = options.allowedStopName?.();
    const allowedStopUid = options.allowedStopUid?.();
    let allowedMutation = false, allowedEstimate = false, exactRequest: ExactDashboardRequest | undefined;
    try {
      const body = request.postData() ? request.postDataJSON() : null;
      allowedMutation = allowedOwnedStop(url, request.method(), body, config.dashboardUrl, allowedStopName, allowedStopUid) ||
        (options.allowedStart?.() === true && allowedOwnedStart(url, request.method(), body,
          config.dashboardUrl, allowedStopName, allowedStopUid)) ||
        allowedOwnedContextEdit(url, request.method(), body, config.dashboardUrl, allowedStopName, allowedStopUid,
          options.allowedEditContextWindow?.()) ||
        allowedOwnedKeyChange(url, request.method(), body, config.dashboardUrl, options.allowedKeyName?.(), options.allowedKeyId?.());
      allowedEstimate = allowedOwnedEstimate(url, request.method(), body, config.dashboardUrl, allowedStopName, allowedStopUid,
        options.allowedEstimateMemoryMi?.());
      exactRequest = allowedExactDashboardRequest(url, request.method(), body, config.dashboardUrl,
        options.allowedDashboardRequests?.() ?? []);
    } catch { /* Non-JSON/read-only request. */ }
    if (!origins.has(url.origin) || (url.origin === options.inferenceOrigin &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) || (url.origin === config.dashboardUrl &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !allowedMutation && !allowedEstimate && !exactRequest)) {
      if (url.origin === config.dashboardUrl && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
        options.onBlockedMutation?.({method: request.method(), path: url.pathname});
      }
      await route.abort('blockedbyclient'); return;
    }
    if (allowedMutation || (exactRequest && exactRequest.mutating !== false)) {
      try { await options.assertMutationAllowed?.(); }
      catch { await route.abort('blockedbyclient'); return; }
    }
    await route.continue();
  });
  const page = await context.newPage();
  let stage: Stage = 'login-form';
  try {
    const loginPage = await page.goto(config.dashboardUrl, {waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs});
    requireSafe(loginPage?.status() === 200, 'AUTH');
    requireSafe(new URL(page.url()).origin === config.identityUrl, 'AUTH');
    await page.locator('#username').fill(username, {timeout: config.loginTimeoutMs});
    await page.locator('#password').fill(password);
    stage = 'login-return';
    await Promise.all([
      page.waitForURL(url => url.origin === config.dashboardUrl, {timeout: config.loginTimeoutMs, waitUntil: 'domcontentloaded'}),
      page.locator('#kc-login').click(),
    ]);
    stage = 'login-session';
    const session = await readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs).session();
    requireSafe(session.subject && session.username === username && session.roles.includes(config.expected.role), 'AUTH');
    await page.close();
    return context;
  } catch {
    await context.close(); throw new HarnessError('AUTH', 'Blocked', stage);
  }
}
