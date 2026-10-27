import type {APIRequestContext} from '@playwright/test';
import type {RegressionPreflightLogs,RegressionPreflightLogTarget} from '@magicstick/dashboard-contracts';
import type {LabConfig} from './config.ts';
import type {KubeObject,KubectlObserver} from './observer.ts';
import {pinFingerprint,safePinReason,type PinObservation,type PinReference,type PreflightDiagnostic} from './preflight-diagnostic.ts';
import {writePrivate} from './private-files.ts';
import {join} from 'node:path';

type Observer=Pick<KubectlObserver,'get'|'list'>;
export type PreflightLogRead=(target:RegressionPreflightLogTarget)=>Promise<RegressionPreflightLogs>;
/** This separate transport cannot broaden the normal read-only API allowlist.
 * The server binds it to the generated identity of this active native run. */
export function privatePreflightLogReader(request:Pick<APIRequestContext,'fetch'>,baseUrl:string,runUid=process.env.REGRESSION_RUN_UID):PreflightLogRead|undefined {
  if(!runUid||!/^[a-f0-9-]{36}$/.test(runUid))return;
  return async target=>{
    const url=new URL('/api/regression/preflight-logs',baseUrl);
    for(const [key,value]of Object.entries({...target,runUid}))url.searchParams.set(key,String(value));
    const response=await request.fetch(url.href,{method:'GET',headers:{Accept:'application/json'},timeout:5000,maxRedirects:0,failOnStatusCode:false});
    try {
      if(response.status()!==200)throw new Error(response.status()===403?'not-authorized':response.status()===409?'identity-changed':'endpoint-unavailable');
      if(!(response.headers()['content-type']??'').includes('application/json'))throw new Error('collection-failed');
      const body=await response.body();if(body.length>80*1024)throw new Error('collection-failed');
      const value=JSON.parse(body.toString('utf8')) as RegressionPreflightLogs;
      if(value.version!==1||!Array.isArray(value.streams)||value.streams.length>4||value.streams.some(s=>typeof s.previous!=='boolean'||typeof s.text!=='string'||Buffer.byteLength(s.text)>16*1024))throw new Error('collection-failed');
      return {version:1,streams:value.streams.map(s=>({previous:s.previous,text:s.text}))};
    }finally{await response.dispose();}
  };
}
const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():undefined;
/** First-failure only. Diagnostic reads are optional, bounded and never infer
 * ownership, retry mutations, elevate the observer or replace a primary error. */
export async function collectPreflightFailure(observer:Observer,config:LabConfig,sample:PinObservation,references:PinReference[],
  directory:string,readLogs?:PreflightLogRead):Promise<Pick<PreflightDiagnostic,'events'|'logs'>> {
  const failed=new Set(sample.checks.filter(c=>c.condition!=='ready').map(c=>`${c.component}/${c.index}`));
  const relevant=references.filter(r=>failed.has(`${r.component}/${r.index}`));
  const selected=[...relevant.filter(r=>r.kind!=='replicaset'),...relevant.filter(r=>r.kind==='replicaset')].slice(0,64);
  const events:PreflightDiagnostic['events']={state:'unavailable',items:[],omitted:0};
  const logs:PreflightDiagnostic['logs']={state:'unavailable',streams:0,reason:readLogs?'collection-failed':'not-native'};
  // Persist exact lookup identities even if events/logs are unavailable. This
  // private sidecar is never used as an ownership or cleanup receipt.
  try{await writePrivate(join(directory,'preflight-objects.json'),{version:1,references:selected,omitted:Math.max(0,relevant.length-64)});}catch{/* optional diagnostic */}
  await Promise.all([
    (async()=>{
      if(!selected.length)return;
      try {
        const raw:Array<Record<string,unknown>>=[];
        for(const ns of [...new Set(selected.map(r=>r.namespace))].slice(0,3)){
          const observedAt=new Date().toISOString();
          for(const item of await observer.list('events',ns)){
            const event=item as KubeObject&{involvedObject?:{uid?:string};type?:string;reason?:string;message?:string;count?:number;
              firstTimestamp?:string;lastTimestamp?:string;eventTime?:string;series?:{lastObservedTime?:string;count?:number}};
            const ref=selected.find(r=>r.namespace===ns&&r.uid===event.involvedObject?.uid);if(!ref)continue;
            const occurredAt=date(event.series?.lastObservedTime??event.lastTimestamp??event.eventTime??event.firstTimestamp);
            // Old history is not the cause of a fresh transition. Keep only a
            // bounded nearby window, and mark absent event time as unknown.
            if(occurredAt&&(Date.parse(occurredAt)<Date.parse(sample.startedAt)-120_000||Date.parse(occurredAt)>Date.parse(observedAt)+5000))continue;
            if(events.items.length>=32){events.omitted++;continue;}
            const count=event.series?.count??event.count;
            events.items.push({component:ref.component,index:ref.index,objectFingerprint:pinFingerprint(ref.uid),observedAt,
              ...(occurredAt?{occurredAt}:{}),type:event.type==='Normal'||event.type==='Warning'?event.type:'Unknown',reason:safePinReason(event.reason),
              ...(Number.isSafeInteger(count)&&count!>=0?{count}:{})});
            raw.push({reference:ref,observedAt,occurredAt,type:event.type,reason:event.reason,
              message:typeof event.message==='string'?event.message.slice(0,2048):undefined,count});
          }
        }
        await writePrivate(join(directory,'preflight-events.json'),{version:1,events:raw,omitted:events.omitted});events.state='collected';
      }catch{/* absence/permission/network errors are not an empty event history */}
    })(),
    (async()=>{
      if(!readLogs)return;
      try {
        const targets:RegressionPreflightLogTarget[]=[];
        for(const check of sample.checks.filter(c=>c.condition!=='ready').slice(0,2)){
          let expected=check.component==='deployment'?config.expected.images[check.index]:undefined;
          if(check.component==='flux')expected={namespace:'flux-system',deployment:'kustomize-controller',container:'manager',digest:''};
          if(!expected)continue;
          const deployment=await observer.get('deployments.apps',expected.namespace,expected.deployment);
          const pinned=selected.find(r=>r.kind==='deployment'&&r.index===check.index&&r.component===check.component);
          if(pinned&&(deployment.metadata.uid!==pinned.uid||deployment.metadata.generation!==pinned.generation))throw new Error('identity-changed');
          const sets=await observer.list('replicasets.apps',expected.namespace);
          const owners=new Set(sets.filter(rs=>rs.metadata.ownerReferences?.some(o=>o.uid===deployment.metadata.uid)).map(rs=>rs.metadata.uid));
          const pods=await observer.list('pods',expected.namespace);
          for(const pod of pods.filter(p=>p.metadata.ownerReferences?.some(o=>owners.has(o.uid))).slice(0,2-targets.length)){
            if(deployment.metadata.uid&&Number.isSafeInteger(deployment.metadata.generation)&&pod.metadata.uid)targets.push({namespace:expected.namespace,
              deployment:expected.deployment,container:expected.container,deploymentUid:deployment.metadata.uid,generation:deployment.metadata.generation!,podUid:pod.metadata.uid});
          }
          if(targets.length===2)break;
        }
        if(!targets.length)return;
        const streams=[];
        for(const target of targets){const result=await readLogs(target);streams.push({target,...result});logs.streams+=result.streams.length;}
        await writePrivate(join(directory,'preflight-private-logs.json'),{version:1,capturedAt:new Date().toISOString(),streams});
        logs.state='captured';delete logs.reason;
      }catch(error){logs.streams=0;logs.reason=error instanceof Error&&['not-authorized','endpoint-unavailable','identity-changed'].includes(error.message)?error.message as 'not-authorized'|'endpoint-unavailable'|'identity-changed':'collection-failed';}
    })(),
  ]);
  return {events,logs};
}
