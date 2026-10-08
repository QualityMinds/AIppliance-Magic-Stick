import type {APIRequestContext} from '@playwright/test';
import {MagicStickApi} from '@magicstick/dashboard-api-client';
import {HarnessError,requireSafe} from './errors.ts';
import {readOnlyFetch} from './transport.ts';
import {canonicalInput} from './input-preparation.ts';
import type {RuntimeModelFixture} from './config.ts';

export function estimateInput(fixture:RuntimeModelFixture) {
  return {engine:fixture.engine,computeTarget:fixture.computeTarget,url:fixture.url,modelType:'chat',
    contextWindow:fixture.contextWindow,maxNumSeqs:fixture.maxNumSeqs,kvCacheType:fixture.kvCacheType ?? 'auto'};
}

/** Preparation extends the shared client ONLY for read-only discovery and
 * exact CPU-fixture estimator requests. POST is never an intent/write permit. */
export function allowedPreparationRequest(url:URL,method:string,body:unknown,origin:string,estimates:unknown[]) {
  if(url.origin !== origin || url.username || url.password || url.hash)return false;
  if(method === 'POST')return url.pathname === '/api/models/estimate-memory' && !url.search &&
    estimates.some(value=>canonicalInput(value) === canonicalInput(body));
  if(method !== 'GET' || body)return false;
  if(!['/api/model-discovery/search','/api/model-discovery/artifacts'].includes(url.pathname))return false;
  const fields=[...url.searchParams.keys()];
  if(new Set(fields).size !== fields.length || fields.some(key=>!['provider','engine','computeTarget','modelType','q','repo','cursor','limit'].includes(key)))return false;
  if(url.searchParams.get('provider') !== 'huggingface' || url.searchParams.get('engine') !== 'VLLM' ||
    url.searchParams.get('computeTarget') !== 'cpu' || url.searchParams.get('modelType') !== 'chat' || url.searchParams.get('limit') !== '20')return false;
  const query=url.searchParams.get('q'),repo=url.searchParams.get('repo'),cursor=url.searchParams.get('cursor');
  return (url.pathname.endsWith('/search') ? !repo && Boolean(query && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/+-]{1,79}$/.test(query)) :
    !query && Boolean(repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo))) && (!cursor || cursor.length <= 4096);
}

export function preparationApi(request:Pick<APIRequestContext,'fetch'>,origin:string,timeoutMs:number,fixtures:RuntimeModelFixture[]) {
  const base=readOnlyFetch(request,origin,timeoutMs),estimates=fixtures.filter(item=>item.computeTarget === 'cpu').map(estimateInput);
  const transport:typeof fetch=async(input,init={})=>{
    const url=new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method=String(init.method ?? 'GET').toUpperCase();
    if(method === 'GET' && !['/api/model-discovery/search','/api/model-discovery/artifacts'].includes(url.pathname))return base(input,init);
    let body;try {body=init.body ? JSON.parse(String(init.body)) : undefined;}catch {throw new HarnessError('MUTATION');}
    requireSafe(allowedPreparationRequest(url,method,body,origin,estimates),'MUTATION');
    let response;
    try {response=await request.fetch(url.href,{method,headers:{Accept:'application/json',...(method === 'POST' ? {
      'Content-Type':'application/json','X-MagicStick-CSRF':'dashboard',Origin:origin} : {})},
      ...(init.body ? {data:String(init.body)} : {}),timeout:timeoutMs,maxRedirects:0,failOnStatusCode:false});}
    catch {throw new HarnessError('API');}
    requireSafe(response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/json'),'API');
    const bytes=await response.body();requireSafe(bytes.length < 8*1024*1024,'API');
    return new Response(bytes.toString('utf8'),{status:200,headers:{'Content-Type':'application/json'}});
  };
  return new MagicStickApi({baseUrl:origin,fetch:transport});
}
