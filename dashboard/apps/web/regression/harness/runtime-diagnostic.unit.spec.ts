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
