import {createHash,randomBytes} from 'node:crypto';
import type {APIRequestContext} from '@playwright/test';
import {HarnessError,requireSafe} from './errors.ts';

export interface UnmanagedKeyIdentity {id:string;alias:string;runId:string;applianceUid:string}
export function disposableUnmanagedKey(runId:string,applianceUid:string) {
  requireSafe(/^reg-[a-f0-9-]{36}$/.test(runId) && /^[A-Za-z0-9-]{1,64}$/.test(applianceUid),'IDENTITY');
  const secret='sk-'+randomBytes(32).toString('hex');
  const identity={id:createHash('sha256').update(secret).digest('hex'),alias:runId+'-unmanaged',runId,applianceUid};
  return {identity,body:{key:secret,key_alias:identity.alias,key_type:'llm_api',duration:'1h',max_budget:0,
    models:['regression-no-inference-'+runId],metadata:{regressionRun:runId,regressionAppliance:applianceUid}}};
}
export function verifyUnmanagedKey(value:any,identity?:UnmanagedKeyIdentity) {
  const info=value?.info;
  requireSafe(info && typeof info === 'object' && !info.metadata?.magicstick_source,'OWNERSHIP');
  if(identity)requireSafe(info.key_alias === identity.alias && info.metadata?.regressionRun === identity.runId &&
    info.metadata?.regressionAppliance === identity.applianceUid && info.models?.length === 1 &&
    info.models[0] === 'regression-no-inference-'+identity.runId && info.max_budget === 0,'OWNERSHIP');
  return info;
}
/** Explicitly approved disposable-fixture adapter, not a general management
 * client. Master/key material stays in memory; only hashes enter URLs/receipts.
 * The supported upstream endpoints are /key/generate, /key/info and /key/delete.
 */
export class UnmanagedKeyFixtureClient {
  constructor(readonly request:APIRequestContext,readonly origin:string,private master:string,
    readonly guard:()=>Promise<void>,readonly timeout:number) {
    requireSafe(new URL(origin).origin === origin && new URL(origin).protocol === 'https:' && master.startsWith('sk-'),'CONFIG');
  }
  private async call(path:string,method:'GET'|'POST',body?:unknown,missing=false) {
    await this.guard();
    requireSafe(path === '/key/generate' || path === '/key/delete' || /^\/key\/info\?key=[a-f0-9]{64}$/.test(path),'MUTATION');
    try {
      const response=await this.request.fetch(this.origin+path,{method,headers:{Authorization:'Bearer '+this.master,Accept:'application/json'},
        ...(body ? {data:body} : {}),timeout:this.timeout,maxRedirects:0,failOnStatusCode:false});
      requireSafe((await response.body()).length < 128*1024,'API');
      if(missing && response.status() === 404)return null;
      requireSafe(response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/json'),'API');
      return await response.json();
    }catch(error){if(error instanceof HarnessError)throw error;throw new HarnessError('API');}
  }
  async inspect(id:string) {requireSafe(/^[a-f0-9]{64}$/.test(id),'CONFIG');return this.call('/key/info?key='+id,'GET',undefined,true);}
  async create(fixture:ReturnType<typeof disposableUnmanagedKey>) {
    requireSafe(await this.inspect(fixture.identity.id) === null,'OWNERSHIP');
    const result=await this.call('/key/generate','POST',fixture.body);
    requireSafe(result.key === fixture.body.key,'API');
    verifyUnmanagedKey(await this.inspect(fixture.identity.id),fixture.identity);
  }
  async removeOwned(identity:UnmanagedKeyIdentity) {
    const current=await this.inspect(identity.id);
    if(current) {
      verifyUnmanagedKey(current,identity);
      await this.call('/key/delete','POST',{keys:[identity.id]});
    }
    requireSafe(await this.inspect(identity.id) === null,'CLEANUP');
  }
}
