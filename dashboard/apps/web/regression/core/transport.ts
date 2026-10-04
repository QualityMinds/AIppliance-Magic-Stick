import type {APIRequestContext} from '@playwright/test';
import {MagicStickApi} from '@magicstick/dashboard-api-client';
import {HarnessError, requireSafe} from './errors.ts';

const reads = new Set(['/api/session', '/api/appliance', '/api/models', '/api/modules', '/api/instances', '/api/settings', '/api/status', '/api/host-management']);

export function readOnlyFetch(request: Pick<APIRequestContext, 'fetch'>, baseUrl: string, timeoutMs: number): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    requireSafe(url.origin === origin && reads.has(url.pathname) && !url.search && !url.hash &&
      String(init.method ?? 'GET').toUpperCase() === 'GET' && !init.body, 'MUTATION');
    try {
      const response = await request.fetch(url.href, {method: 'GET', headers: {'Accept': 'application/json'},
        timeout: timeoutMs, maxRedirects: 0, failOnStatusCode: false});
      requireSafe(response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/json'), 'API');
      const body = await response.body();
      requireSafe(body.length < 8 * 1024 * 1024, 'API');
      return new Response(body.toString('utf8'), {status: 200, headers: {'Content-Type': 'application/json'}});
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError('API');
    }
  };
}

/** Reuses shared DTOs/client behavior, with a phase-0 read-only transport fence. */
export function readOnlyApi(request: Pick<APIRequestContext, 'fetch'>, baseUrl: string, timeoutMs: number) {
  return new MagicStickApi({baseUrl, fetch: readOnlyFetch(request, baseUrl, timeoutMs)});
}
