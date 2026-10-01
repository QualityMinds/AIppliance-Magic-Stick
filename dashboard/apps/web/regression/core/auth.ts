import type {Browser, BrowserContext} from '@playwright/test';
import type {LabConfig} from './config.ts';
import {readPrivate} from './private-files.ts';
import {HarnessError, requireSafe} from './errors.ts';
import {readOnlyApi} from './transport.ts';

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

export async function realLogin(browser: Browser, config: LabConfig, options: {
  allowedStopName?: () => string | undefined;
  allowedStopUid?: () => string | undefined;
  inferenceOrigin?: string;
} = {}): Promise<BrowserContext> {
  const username = (await readPrivate(config.usernameFile)).trim(), password = (await readPrivate(config.passwordFile)).trimEnd();
  requireSafe(username.length > 0 && password.length > 0, 'AUTH');
  const context = await browser.newContext({serviceWorkers: 'block', acceptDownloads: false});
  const origins = new Set([config.dashboardUrl, config.identityUrl,
    ...(options.inferenceOrigin ? [options.inferenceOrigin] : [])]);
  // The optional smoke route permits exactly one run-owned Stop click. All
  // other dashboard writes remain blocked even if the page adds an effect.
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    const allowedStopName = options.allowedStopName?.();
    const allowedStopUid = options.allowedStopUid?.();
    let allowedStop = false;
    try { allowedStop = allowedOwnedStop(url, request.method(), request.postDataJSON(),
      config.dashboardUrl, allowedStopName, allowedStopUid); } catch { /* Non-JSON/read-only request. */ }
    if (!origins.has(url.origin) || (url.origin === options.inferenceOrigin &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) || (url.origin === config.dashboardUrl &&
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !allowedStop)) {
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(config.dashboardUrl, {waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs});
    requireSafe(new URL(page.url()).origin === config.identityUrl, 'AUTH');
    await page.locator('#username').fill(username, {timeout: config.loginTimeoutMs});
    await page.locator('#password').fill(password);
    await Promise.all([
      page.waitForURL(url => url.origin === config.dashboardUrl, {timeout: config.loginTimeoutMs, waitUntil: 'domcontentloaded'}),
      page.locator('#kc-login').click(),
    ]);
    const session = await readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs).session();
    requireSafe(session.subject && session.username === username && session.roles.includes(config.expected.role), 'AUTH');
    await page.close();
    return context;
  } catch {
    await context.close(); throw new HarnessError('AUTH');
  }
}
