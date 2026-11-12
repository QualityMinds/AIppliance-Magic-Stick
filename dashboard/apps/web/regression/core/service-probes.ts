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

export interface ServiceAccessExpectation {
  mode:'sso'|'public';
  identityOrigin:string;
  dashboardOrigin:string;
}

/** A Dashboard login does not by itself prove this service route's session.
 * Visit it through the normal authenticated browser first so an ordinary IdP
 * callback can establish/refresh that route. Then independently compare the
 * shared browser request context with a fresh anonymous one. No cookies are
 * copied and the no-redirect API checks below remain strict. */
export async function probeServiceAccessAfterNavigation(authenticated:Pick<APIRequestContext,'get'>,anonymous:Pick<APIRequestContext,'get'>,
  links:readonly ResourceLink[],timeoutMs:number,expected:ServiceAccessExpectation,navigate:(link:ResourceLink)=>Promise<void>) {
  if(!links.length)throw new HarnessError('API','Failed','gateway-ready');
  for(const link of links)await navigate(link);
  await probeServiceAccess(authenticated,anonymous,links,timeoutMs,expected);
}

/** Compare fresh unauthenticated access with the existing authenticated session.
 * A generic redirect is not proof of SSO: it must target this appliance's exact
 * IdP and callback origin. No redirect is followed and no cookie is copied. */
export async function probeServiceAccess(authenticated:Pick<APIRequestContext,'get'>,anonymous:Pick<APIRequestContext,'get'>,
  links:readonly ResourceLink[],timeoutMs:number,expected:ServiceAccessExpectation) {
  if(!links.length)throw new HarnessError('API','Failed','gateway-ready');
  for(const origin of [expected.identityOrigin,expected.dashboardOrigin]) {
    let parsed:URL;try{parsed=new URL(origin);}catch{throw new HarnessError('CONFIG','Failed','gateway-ready');}
    if(parsed.protocol!=='https:'||parsed.origin!==origin||parsed.username||parsed.password)
      throw new HarnessError('CONFIG','Failed','gateway-ready');
  }
  for(const link of links)for(const [request,signedIn] of [[anonymous,false],[authenticated,true]] as const) {
    let response;
    try {
      response=await request.get(link.url,{...functionalHttpsRequestOptions,maxRedirects:0,
        timeout:timeoutMs,failOnStatusCode:false});
      if(signedIn||expected.mode==='public') {
        if(response.status()!==200)throw new HarnessError('AUTH','Failed','gateway-ready');
      } else {
        if(![302,303].includes(response.status()))throw new HarnessError('AUTH','Failed','gateway-ready');
        const target=new URL(response.headers().location??'',link.url);
        const callback=new URL(target.searchParams.get('redirect_uri')??'');
        if(target.origin!==expected.identityOrigin||!/^\/realms\/[^/]+\/protocol\/openid-connect\/auth$/.test(target.pathname)||
          callback.origin!==expected.dashboardOrigin||!callback.pathname.startsWith('/oauth2/callback/')||
          target.username||target.password||callback.username||callback.password)
          throw new HarnessError('AUTH','Failed','gateway-ready');
      }
    } catch(error) {
      throw error instanceof HarnessError?error:new HarnessError('API','Failed','gateway-ready');
    } finally {await response?.dispose();}
  }
}
