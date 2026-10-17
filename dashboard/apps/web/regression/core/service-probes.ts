import type {APIRequestContext} from '@playwright/test';
import type {ResourceLink} from '@magicstick/dashboard-core';
import {isIP} from 'node:net';
import {HarnessError} from './errors.ts';
import {functionalHttpsRequestOptions} from './https-policy.ts';

/** A ready module may advertise both LAN and public routes, including an
 * unconfigured public placeholder. Test the registered connection's scope,
 * never every advertised exposure or an unrelated appliance's local name.
 */
export function moduleProbeLinks(links: readonly ResourceLink[], dashboardOrigin: string): ResourceLink[] {
  let dashboard: URL;
  try { dashboard = new URL(dashboardOrigin); }
  catch { throw new HarnessError('CONFIG', 'Failed', 'module-ready'); }
  if (dashboard.protocol !== 'https:' || dashboard.origin !== dashboardOrigin || dashboard.username || dashboard.password)
    throw new HarnessError('CONFIG', 'Failed', 'module-ready');
  const scope = dashboard.hostname.endsWith('.local') ? 'local' :
    isIP(dashboard.hostname.replace(/^\[|\]$/g, '')) || dashboard.hostname === 'localhost' ? 'direct' : 'public';
  const selected = links.filter(link => {
    if (link.scope !== scope) return false;
    let url: URL;
    try { url = new URL(link.url); }
    catch { throw new HarnessError('CONFIG', 'Failed', 'module-ready'); }
    if (url.protocol !== 'https:' || url.username || url.password)
      throw new HarnessError('CONFIG', 'Failed', 'module-ready');
    const suffix = '.' + dashboard.hostname;
    return scope === 'local' ? url.hostname.endsWith(suffix) && /^[^.]+$/.test(url.hostname.slice(0, -suffix.length)) :
      scope === 'direct' ? url.hostname === dashboard.hostname : true;
  });
  // No fallback to a public placeholder when the expected local route is absent.
  if (!selected.length) throw new HarnessError('API', 'Failed', 'module-ready');
  return [...new Map(selected.map(link => [link.url, link])).values()];
}

/** Certificate validity is not a module activation postcondition. DNS, bounded
 * connectivity and the actual service/authentication HTTP response still are.
 * Do not follow a redirect to an unreviewed public endpoint or forward credentials.
 */
export async function probeModuleServices(request: Pick<APIRequestContext, 'get'>,
  links: readonly ResourceLink[], timeoutMs: number): Promise<void> {
  if (!links.length) throw new HarnessError('API', 'Failed', 'module-ready');
  for (const link of links) {
    try {
      const response = await request.get(link.url, {...functionalHttpsRequestOptions,
        maxRedirects: 0, timeout: timeoutMs, failOnStatusCode: false});
      try {
        if (![200, 302, 303].includes(response.status())) throw new HarnessError('API', 'Failed', 'module-ready');
      } finally { await response.dispose(); }
    } catch { throw new HarnessError('API', 'Failed', 'module-ready'); }
  }
}
