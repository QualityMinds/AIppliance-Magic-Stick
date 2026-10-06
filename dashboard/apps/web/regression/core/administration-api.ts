import type {APIRequestContext} from '@playwright/test';
import {MagicStickApi,ApiError} from '@magicstick/dashboard-api-client';
import {HarnessError,requireSafe} from './errors.ts';
import type {ExactDashboardRequest} from './auth.ts';

const collections=new Set(['/api/session','/api/appliance','/api/modules','/api/instances','/api/my-instances','/api/models','/api/status',
  '/api/host-management','/api/hardware/gpu-sharing','/api/license','/api/license/export','/api/federated-sso','/api/api-access','/api/users','/api/kubernetes-access','/api/mesh','/api/settings','/api/instance-principals']);
export function allowedAdministrationRead(url:URL,origin:string) {
  return url.origin === origin && !url.hash && (collections.has(url.pathname) ||
    /^\/api\/(?:modules|instances)\/[a-z0-9-]{1,63}\/(?:credentials|access)$/.test(url.pathname) ||
    /^\/api\/kubernetes-access\/[a-zA-Z0-9-]{1,64}\/kubeconfig$/.test(url.pathname)) &&
    (url.search === '' || ['/api/users','/api/kubernetes-access','/api/instance-principals'].includes(url.pathname) &&
      [...url.searchParams.keys()].every(key=>['search','first','max',...(url.pathname === '/api/instance-principals' ? ['kind'] : [])].includes(key)));
}
/** HTTP writes require an exact, expiring request permit. No redirect, generic
 * fetch escape hatch, Kubernetes admin credential, raw error or automatic retry. */
export class AdministrationApi {
  readonly api:MagicStickApi;
  readonly request:APIRequestContext;
  readonly origin:string;
  readonly timeoutMs:number;
  readonly guard:()=>Promise<void>;
  private permits:ExactDashboardRequest[]=[];
  constructor(request:APIRequestContext,origin:string,timeoutMs:number,guard:()=>Promise<void>) {
    this.request=request;this.origin=origin;this.timeoutMs=timeoutMs;this.guard=guard;
    const transport:typeof fetch=async(input,init={})=>{
      const url=new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      const method=String(init.method ?? 'GET').toUpperCase();
      const headers=new Headers(init.headers);
      if(method === 'GET') requireSafe(allowedAdministrationRead(url,origin) && !init.body,'MUTATION');
      else {
        const body=init.body ? JSON.parse(String(init.body)) : null;
        const permit=this.permits.find(item=>item.path === url.pathname && item.method === method &&
          JSON.stringify(item.body) === JSON.stringify(body));
        requireSafe(url.origin === origin && !url.search && !url.hash && permit,'MUTATION');
        this.permits.splice(this.permits.indexOf(permit),1);
        await guard(); headers.set('Origin',origin);
      }
      let response;
      try {response=await request.fetch(url.href,{method,headers:Object.fromEntries(headers.entries()),
        ...(init.body ? {data:String(init.body)} : {}),timeout:timeoutMs,maxRedirects:0,failOnStatusCode:false});}
      catch {throw new HarnessError('API');}
      const raw=await response.body();
      requireSafe(raw.length < 2*1024*1024 && (response.headers()['content-type'] ?? '').includes('application/json'),'API');
      return new Response(raw.toString('utf8'),{status:response.status(),headers:response.headers()});
    };
    this.api=new MagicStickApi({baseUrl:origin,fetch:transport});
  }
  async write<T>(permit:ExactDashboardRequest,action:()=>Promise<T>):Promise<T> {
    requireSafe(this.permits.length === 0,'MUTATION'); this.permits.push(permit);
    try {return await action();} catch(error) {
      if(error instanceof ApiError) throw new AdministrationRejected(error.status);
      if(error instanceof HarnessError) throw error;
      throw new HarnessError('API');
    } finally {this.permits=[];}
  }
}
export class AdministrationRejected extends HarnessError {
  readonly status:number;
  constructor(status:number) {super('API');this.status=status;}
}
