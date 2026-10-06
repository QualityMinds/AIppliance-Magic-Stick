import {randomBytes} from 'node:crypto';
import type {APIRequestContext} from '@playwright/test';
import {readPrivate,writePrivate} from './private-files.ts';
import {join} from 'node:path';
import {requireSafe} from './errors.ts';

export interface IdentityFixture {origin:string;realm:string;clientId:string;clientSecretFile:string}
/** Test-only Keycloak fixture credential. All calls are scoped to exact owned
 * users; it cannot change realm settings, clients, roles or the recovery user. */
export class IdentityFixtureClient {
  private token='';
  constructor(readonly request:APIRequestContext,readonly fixture:IdentityFixture,readonly guard:()=>Promise<void>,readonly timeout:number) {}
  async authenticate() {
    const url=new URL(this.fixture.origin);requireSafe(url.protocol === 'https:' && url.origin === this.fixture.origin && /^[a-zA-Z0-9_-]{1,64}$/.test(this.fixture.realm),'CONFIG');
    const secret=(await readPrivate(this.fixture.clientSecretFile)).trim();
    const response=await this.request.post(this.fixture.origin+`/realms/${this.fixture.realm}/protocol/openid-connect/token`,
      {form:{grant_type:'client_credentials',client_id:this.fixture.clientId,client_secret:secret},timeout:this.timeout,maxRedirects:0});
    requireSafe(response.status() === 200,'AUTH');const data=await response.json();requireSafe(typeof data.access_token === 'string' && data.access_token.length < 32*1024,'AUTH');this.token=data.access_token;
  }
  private async call(method:string,suffix:string,body?:unknown) {
    await this.guard();requireSafe(this.token && /^\/users(?:\/[a-zA-Z0-9-]{1,64}(?:\/federated-identity)?)?(?:\?username=[a-z0-9-]{1,63}&exact=true)?$/.test(suffix),'MUTATION');
    const response=await this.request.fetch(this.fixture.origin+`/admin/realms/${this.fixture.realm}`+suffix,{method,maxRedirects:0,timeout:this.timeout,
      headers:{Authorization:'Bearer '+this.token,Accept:'application/json'},...(body ? {data:body} : {})});
    requireSafe([200,201,204].includes(response.status()),'API');requireSafe((await response.body()).length < 128*1024,'API');
    return {response,value:response.status() === 204 || !(await response.body()).length ? null : await response.json()};
  }
  async find(username:string) {return (await this.call('GET','/users?username='+username+'&exact=true')).value as Array<{id:string;username:string;attributes?:Record<string,string[]>}>;}
  async create(username:string,runId:string,claim:string,value:string) {
    requireSafe(/^reg-[a-z0-9-]{1,59}$/.test(username) && /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(claim) && (await this.find(username)).length === 0,'OWNERSHIP');
    const password='Reg7!'+randomBytes(24).toString('base64url');
    requireSafe(process.env.REGRESSION_RUN_DIR,'CONFIG');
    const receipt=join(process.env.REGRESSION_RUN_DIR,'upstream-'+username+'.json');
    await writePrivate(receipt,{version:1,username,runId,state:'requested'},true);
    await this.call('POST','/users',{username,enabled:true,email:username+'@example.invalid',emailVerified:true,firstName:'Regression',lastName:'Fixture',
      attributes:{[claim]:[value],regressionRun:[runId]},credentials:[{type:'password',value:password,temporary:false}]});
    const users=await this.find(username);requireSafe(users.length === 1 && users[0]!.attributes?.regressionRun?.[0] === runId,'OWNERSHIP');
    await writePrivate(receipt,{version:1,username,runId,id:users[0]!.id,state:'owned'});return {id:users[0]!.id,username,password};
  }
  async removeCreated(username:string,id:string,runId:string) {
    const current=await this.find(username);requireSafe(current.length === 1 && current[0]!.id === id && current[0]!.attributes?.regressionRun?.[0] === runId,'OWNERSHIP');
    await this.call('DELETE','/users/'+id);requireSafe((await this.find(username)).length === 0,'CLEANUP');
  }
  async removePending(username:string,runId:string,id?:string) {
    const current=await this.find(username);if(!current.length)return;
    requireSafe(current.length === 1 && (!id || current[0]!.id === id) && current[0]!.attributes?.regressionRun?.[0] === runId,'OWNERSHIP');
    await this.removeCreated(username,current[0]!.id,runId);
  }
  async removeBrokered(username:string,alias:string,upstreamId:string) {
    const current=await this.find(username);if(!current.length)return;
    requireSafe(current.length === 1,'OWNERSHIP');const id=current[0]!.id;
    const links=(await this.call('GET','/users/'+id+'/federated-identity')).value;
    requireSafe(Array.isArray(links) && links.length === 1 && links[0].identityProvider === alias && links[0].userId === upstreamId,'OWNERSHIP');
    await this.call('DELETE','/users/'+id);requireSafe((await this.find(username)).length === 0,'CLEANUP');
  }
}
