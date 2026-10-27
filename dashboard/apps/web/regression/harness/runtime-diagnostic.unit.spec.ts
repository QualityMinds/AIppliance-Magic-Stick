import {test,expect} from '@playwright/test';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {collectiveStartupDiagnostics,parseCollectiveStartupDiagnostic,parseRuntimeDiagnostic,runtimeDiagnostic} from '../core/runtime-diagnostic.ts';
import {GpuScenario,type GpuCreated} from '../core/gpu-scenario.ts';
import {HarnessError} from '../core/errors.ts';
import {readPrivate} from '../core/private-files.ts';
import {parseExecutionTrace} from '../core/execution-trace.ts';
import {junitReport} from '../core/junit.ts';
import {newPreflightDiagnostic,recordPinObservation,parsePreflightDiagnostic,pinFingerprint,pinPod,type PinObservation} from '../core/preflight-diagnostic.ts';
import {collectPreflightFailure,privatePreflightLogReader} from '../core/preflight-capture.ts';
import type {KubeObject} from '../core/observer.ts';
import type {APIRequestContext} from '@playwright/test';
import type {LabConfig} from '../core/config.ts';

const observed={startedAt:'2026-10-27T12:00:00.000Z',finishedAt:'2026-10-27T12:00:00.100Z'};
function pinSample(attempt=1):PinObservation {
  return {...observed,attempt,checks:[{component:'deployment',index:0,condition:'readiness',observed,
    generation:2,observedGeneration:2,desiredReplicas:1,readyReplicas:0,uidFingerprint:pinFingerprint('synthetic-private'),
    pods:[pinPod({metadata:{uid:'synthetic-private',resourceVersion:'42',deletionTimestamp:observed.startedAt},status:{phase:'Running',
      containerStatuses:[{name:'api',ready:false,restartCount:3,imageID:'containerd://sha256:'+'a'.repeat(64),state:{waiting:{reason:'CrashLoopBackOff',message:'synthetic-private'}},
        lastState:{terminated:{exitCode:1,reason:'Error',message:'synthetic-private'}}}]}},'api','sha256:'+'a'.repeat(64))]}]};
}

test('HAR-02 HAR-10 HAR-11 preflight retains the first failed observation and bounded transitions without rewriting recovery',()=>{
  const diagnostic=newPreflightDiagnostic();recordPinObservation(diagnostic,pinSample());
  for(let attempt=2;attempt<=40;attempt++){
    const sample=pinSample(attempt);sample.checks[0]!.readyReplicas=attempt;recordPinObservation(diagnostic,sample);
  }
  const recovered=pinSample(41);recovered.checks[0]!.condition='ready';recordPinObservation(diagnostic,recovered);diagnostic.state='converged';
  expect(diagnostic.firstFailure).toMatchObject({attempt:1,checks:[{condition:'readiness',readyReplicas:0,pods:[{terminating:true,containers:[{restartCount:3,state:'waiting',reason:'CrashLoopBackOff',previousExitCode:1}]}]}]});
  expect(diagnostic.history).toHaveLength(12);expect(diagnostic.history[0]!.attempt).toBe(1);expect(diagnostic.history.at(-1)!.attempt).toBe(41);
  expect(diagnostic.omittedObservations).toBe(29);
  expect(parsePreflightDiagnostic({...diagnostic,url:'https://synthetic-private',rawLogs:'synthetic-private'})).toEqual(diagnostic);
  expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private');
  const unchanged=newPreflightDiagnostic();for(let attempt=1;attempt<=3;attempt++)recordPinObservation(unchanged,pinSample(attempt));
  expect(unchanged.history.map(s=>s.attempt)).toEqual([1,3]);expect(unchanged.attempts).toBe(3);expect(unchanged.omittedObservations).toBe(1);
  expect(()=>parsePreflightDiagnostic({...diagnostic,history:Array(13).fill(pinSample())})).toThrow('[CONFIG]');
  expect(()=>parsePreflightDiagnostic({...diagnostic,history:[{...pinSample(),startedAt:'synthetic-private'}]})).toThrow('[CONFIG]');
  const unknown=pinSample();unknown.checks[0]!.pods![0]!.containers[0]!.reason='synthetic-private';
  expect(parsePreflightDiagnostic({...diagnostic,history:[unknown]}).history[0]!.checks[0]!.pods![0]!.containers[0]!.reason).toBe('Unknown');
  const historical={version:1,runId:'reg-11111111-1111-1111-1111-111111111111',executionId:'a'.repeat(24),outcome:'Failed',durationMs:1,steps:[]};
  expect(parseExecutionTrace(historical)).toEqual(historical);
});

test('HAR-02 HAR-11 preflight events and private current/previous logs bind exact observed owners and do not escape into traces',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'preflight-diagnostic-'));
  try{
    const ns='identity-system',uid='11111111-2222-3333-4444-555555555555',podUid='22222222-2222-3333-4444-555555555555';
    const deployment:KubeObject={metadata:{namespace:ns,name:'ai-appliance-dashboard-api',uid,generation:2}};
    const rs:KubeObject={metadata:{uid:'rs',ownerReferences:[{uid,kind:'Deployment',controller:true}]}};
    const pod:KubeObject={metadata:{uid:podUid,name:'synthetic-private',ownerReferences:[{uid:'rs',kind:'ReplicaSet',controller:true}]}};
    const event=(owner=uid,time=new Date().toISOString())=>({metadata:{},involvedObject:{uid:owner},lastTimestamp:time,type:'Warning',reason:'BackOff',message:'synthetic-private',count:3});
    const now=new Date().toISOString(),sample={...pinSample(),startedAt:now,finishedAt:now};
    const config={expected:{images:[{namespace:ns,deployment:deployment.metadata.name!,container:'api'}]}} as LabConfig;
    const observer={get:async()=>deployment,list:async(resource:string)=>resource==='events'?[event(),event('foreign'),event(uid,'2000-01-01T00:00:00Z')]:resource==='pods'?[pod]:[rs]};
    const references=[{component:'deployment' as const,index:0,kind:'deployment' as const,namespace:ns,name:deployment.metadata.name!,uid,generation:2}];
    let reads=0;
    const captured=await collectPreflightFailure(observer,config,sample,references,directory,async target=>{
      reads++;expect(target).toMatchObject({deploymentUid:uid,podUid,generation:2});
      return {version:1,streams:[{previous:false,text:'synthetic-private-current'},{previous:true,text:'synthetic-private-previous'}]};
    });
    expect(reads).toBe(1);expect(captured).toMatchObject({events:{state:'collected',omitted:0,items:[{reason:'BackOff',count:3}]},logs:{state:'captured',streams:2}});
    expect(captured.events.items).toHaveLength(1);expect(JSON.stringify(captured)).not.toContain(uid);expect(JSON.stringify(captured)).not.toContain('synthetic-private');
    expect(await readPrivate(join(directory,'preflight-events.json'))).toContain('synthetic-private');
    expect(await readPrivate(join(directory,'preflight-private-logs.json'))).toContain('synthetic-private-previous');
    const unavailable=await collectPreflightFailure({...observer,list:async()=>{throw new Error('synthetic-private');}},config,sample,references,directory);
    expect(unavailable).toMatchObject({events:{state:'unavailable'},logs:{state:'unavailable',reason:'not-native'}});
    const changed=await collectPreflightFailure({...observer,get:async()=>({...deployment,metadata:{...deployment.metadata,uid:'foreign'}})},config,sample,references,directory,async()=>{throw new Error('must-not-read');});
    expect(changed.logs).toMatchObject({state:'unavailable',reason:'identity-changed',streams:0});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-11 private preflight transport is native-run-only bounded and cannot return arbitrary response fields',async()=>{
  const uid='11111111-2222-3333-4444-555555555555',target={namespace:'identity-system',deployment:'ai-appliance-dashboard-api',container:'api',deploymentUid:uid,generation:2,podUid:uid};
  expect(privatePreflightLogReader({} as APIRequestContext,'https://example.local','')).toBeUndefined();
  for(const mode of ['ok','forbidden','redirect','oversize','schema']as const){
    let disposed=false;
    const read=privatePreflightLogReader({fetch:async(url:string,options:Record<string,unknown>)=>{
      expect(String(url)).toContain('/api/regression/preflight-logs?');expect(new URL(String(url)).searchParams.get('runUid')).toBe(uid);
      expect(options).toMatchObject({method:'GET',timeout:5000,maxRedirects:0});
      return {status:()=>mode==='forbidden'?403:mode==='redirect'?302:200,headers:()=>({'content-type':'application/json'}),dispose:async()=>{disposed=true;},
        body:async()=>Buffer.from(mode==='oversize'?'x'.repeat(81*1024):JSON.stringify({version:1,password:'synthetic-private',streams:mode==='schema'?[{previous:false,text:1}]:[{previous:false,text:'private-log'}]}))};
    }} as unknown as Pick<APIRequestContext,'fetch'>,'https://example.local',uid)!;
    if(mode==='ok')expect(await read(target)).toEqual({version:1,streams:[{previous:false,text:'private-log'}]});
    else await expect(read(target)).rejects.toThrow(mode==='forbidden'?'not-authorized':mode==='redirect'?'endpoint-unavailable':'collection-failed');
    expect(disposed).toBe(true);
  }
});

const prefix='[magicstick-vllm-wrapper] MAGICSTICK_STARTUP_DIAGNOSTIC=';
const record=()=>({version:1,stage:'collective-preflight',reason:'COLLECTIVE_PROBE_TIMEOUT',transport:'configured',exitCode:null,cleanupConfirmed:true});
const marker=(data:unknown)=>prefix+JSON.stringify(data)+'\n';
const logs=(text:string)=>({model:'owned-runtime',namespace:'synthetic-private',pods:[{name:'synthetic-private',containers:[{
  name:'synthetic-private',logs:[{previous:false,text},{previous:true,text}]}]}]});
const item=():ModelActivation=>({metadata:{name:'owned-runtime',uid:'owned-uid',generation:2},spec:{enabled:true,
  targetNamespace:'ai',local:{engine:'VLLM',computeTarget:'nvidia-gpu',url:'hf://synthetic-private',gpuDeployment:'split',
    gpuDevices:[{uuid:'GPU-private-1',nodeName:'synthetic-private',nodeUid:'synthetic-private'},
      {uuid:'GPU-private-2',nodeName:'synthetic-private',nodeUid:'synthetic-private'}]}},status:{observedGeneration:2,phase:'Degraded'}});

test('MGPU-01 LOG-01 fixed startup diagnostics survive current/previous log capture without leaking native output',()=>{
  const fallback={...record(),transport:'host-mediated',reason:'COLLECTIVE_PROBE_FAILED',exitCode:-9};
  const text='synthetic-private-native-error\n'+marker({...record(),message:'synthetic-private',path:'/synthetic-private'})+marker(fallback);
  const parsed=collectiveStartupDiagnostics(logs(text));
  expect(parsed).toEqual([record(),fallback]);
  expect(JSON.stringify(parsed)).not.toContain('synthetic-private');
  const diagnostic=runtimeDiagnostic(item(),[],'owned-uid',2,logs(text));
  expect(diagnostic.startup).toEqual(parsed);
  expect(parseRuntimeDiagnostic(JSON.parse(JSON.stringify({...diagnostic,rawLogs:text})))).toEqual(diagnostic);
  expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private');
  const trace=parseExecutionTrace({version:1,runId:'reg-11111111-1111-1111-1111-111111111111',executionId:'a'.repeat(24),
    outcome:'Failed',durationMs:1,steps:[],runtimeDiagnostics:[{...diagnostic,rawLogs:text}]});
  const junit=junitReport([],[{trace,path:'report-artifacts/fixture/traces/filtered.json'}]);
  expect(trace.runtimeDiagnostics?.[0]?.startup).toEqual(parsed);
  expect(junit).toContain('COLLECTIVE_PROBE_TIMEOUT');
  expect(junit).not.toContain('synthetic-private');
  expect(()=>runtimeDiagnostic(item(),[],'foreign',2,logs(text))).toThrow('[OWNERSHIP]');
  expect(()=>runtimeDiagnostic(item(),[],'owned-uid',2,{...logs(text),model:'foreign'})).toThrow('[OWNERSHIP]');
});

test('MGPU-01 HAR-11 startup evidence rejects unknown schema values rather than publishing log text',()=>{
  for(const change of [{version:2},{stage:'synthetic-private'},{reason:'synthetic-private'},{transport:'synthetic-private'},
    {exitCode:'1'},{exitCode:256},{exitCode:-256},{exitCode:1.5},{cleanupConfirmed:'true'}]) {
    const data={...record(),...change};
    expect(()=>parseCollectiveStartupDiagnostic(data)).toThrow('[CONFIG]');
    expect(collectiveStartupDiagnostics(logs(marker(data)))).toEqual([]);
  }
  expect(collectiveStartupDiagnostics(logs(prefix+'{malformed synthetic-private}\n'))).toEqual([]);
  expect(collectiveStartupDiagnostics({pods:'synthetic-private'})).toEqual([]);
  expect(collectiveStartupDiagnostics(logs(prefix+'synthetic-private'.repeat(10000)))).toEqual([]);
  const diagnostic=runtimeDiagnostic(item(),[],'owned-uid',2);
  expect(diagnostic).not.toHaveProperty('startup');
  expect(parseRuntimeDiagnostic(diagnostic)).toEqual(diagnostic); // Historical reports keep their original shape.
  expect(()=>parseRuntimeDiagnostic({...diagnostic,startup:[{...record(),reason:'synthetic-private'}]})).toThrow('[CONFIG]');
  expect(()=>parseRuntimeDiagnostic({...diagnostic,startup:Array(9).fill(record())})).toThrow('[CONFIG]');
  expect(()=>parseRuntimeDiagnostic({...diagnostic,engine:'OLlama',startup:[record()]})).toThrow('[CONFIG]');
});

test('MGPU-01 HAR-11 stalled rank milestones survive reports without native names or error output',()=>{
  const progress=[{rank:0,stage:'all-reduce'},{rank:1,stage:'init'}];
  const parsed=collectiveStartupDiagnostics(logs(marker({...record(),progress:progress.map(value=>({...value,uuid:'synthetic-private',error:'synthetic-private'}))})));
  expect(parsed).toEqual([{...record(),progress}]);expect(JSON.stringify(parsed)).not.toContain('synthetic-private');
  const diagnostic=runtimeDiagnostic(item(),[],'owned-uid',2,logs(marker({...record(),progress})));
  const trace=parseExecutionTrace({version:1,runId:'reg-11111111-1111-1111-1111-111111111111',executionId:'a'.repeat(24),
    outcome:'Failed',durationMs:1,steps:[],runtimeDiagnostics:[diagnostic]});
  expect(junitReport([],[{trace,path:'report-artifacts/fixture/traces/filtered.json'}])).toContain('all-reduce');
  for(const invalid of [[],[{rank:16,stage:'init'}],[{rank:0,stage:'synthetic-private'}],
    [{rank:0,stage:'init'},{rank:0,stage:'complete'}],[{rank:'1',stage:'init'}]])
    expect(()=>parseCollectiveStartupDiagnostic({...record(),progress:invalid})).toThrow('[CONFIG]');
});

test('HAR-11 wrapper extraction bounds records and input and does not accept success from raw native text',()=>{
  const many=Array.from({length:20},(_,exitCode)=>marker({...record(),exitCode})).join('');
  expect(collectiveStartupDiagnostics(logs(many))).toHaveLength(8);
  expect(collectiveStartupDiagnostics(logs('MAGICSTICK_COLLECTIVE_OK\nsynthetic-private'))).toEqual([]);
  expect(collectiveStartupDiagnostics(logs(marker(record())+'x'.repeat(70_000)))).toEqual([]);
  for(const reason of ['COLLECTIVE_PROBE_FAILED','COLLECTIVE_PROBE_TIMEOUT','COLLECTIVE_PROBE_LAUNCH_FAILED','COLLECTIVE_PROBE_CLEANUP_UNCONFIRMED']) {
    expect(collectiveStartupDiagnostics(logs(marker({...record(),reason,cleanupConfirmed:false})))).toEqual([{...record(),reason,cleanupConfirmed:false}]);
  }
});

test('MGPU-01 readiness preserves safe startup evidence and private logs before cleanup without replacing the original failure',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'gpu-startup-evidence-'));
  try {
    const primary=new HarnessError('CAPABILITY','Failed','model-ready'),text='synthetic-private-native-error\n'+marker(record());
    for(const logsUnavailable of [false,true]) {
      let calls=0;
      const scenario=Object.create(GpuScenario.prototype) as GpuScenario;
      Object.assign(scenario,{directory,live:{journal:{runId:'fixture-run'},modelState:async()=>{
        if(calls++===0)throw primary;
        return {item:item(),pods:[]};
      }}});
      const model={uid:'owned-uid',generation:2,fixture:{engine:'VLLM',computeTarget:'nvidia-gpu'},
        client:{name:'owned-runtime',logs:async()=>{if(logsUnavailable)throw new Error('synthetic-private-api-error');return logs(text);}}} as unknown as GpuCreated;
      const attachments=test.info().attachments.length;
      await expect(scenario.ready(model)).rejects.toBe(primary);
      const attachment=test.info().attachments.slice(attachments).find(a=>a.name==='magicstick-runtime-diagnostic');
      expect(attachment?.body).toBeDefined();
      const diagnostic=JSON.parse(attachment!.body!.toString('utf8'));
      expect(diagnostic.startup).toEqual(logsUnavailable?undefined:[record()]);
      expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private');
      expect(JSON.parse(await readPrivate(join(directory,'runtime-owned-runtime.json')))).toMatchObject({stage:'model-ready',reason:'CAPABILITY'});
      if(!logsUnavailable)expect(JSON.parse(await readPrivate(join(directory,'logs-owned-runtime.json')))).toEqual(logs(text));
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
