import {test,expect} from '@playwright/test';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {gpuSlotCapacity,modelLifecycleReceipt,savedGpuBudget,slotFillCount} from '../core/model-ui.ts';
import {parseRuntimeDiagnostic,runtimeDiagnostic} from '../core/runtime-diagnostic.ts';
import type {KubeObject} from '../core/observer.ts';

const model=():ModelActivation=>({metadata:{name:'reg-fixture-model',namespace:'ai-system',uid:'owned-uid',generation:2},
  spec:{enabled:false,targetNamespace:'ai',local:{engine:'OLlama',computeTarget:'nvidia-gpu',url:'ollama://fixture',vram:'1234Mi',
    gpuDeployment:'split',gpuDevices:[{uuid:'GPU-1',nodeUid:'node',nodeName:'ai'},{uuid:'GPU-2',nodeUid:'node',nodeName:'ai'}]}}});

test('HAR-06 HAR-07 LIFE-04 only exact lifecycle acknowledgement advances the generation receipt',()=>{
  const before=model(),after=structuredClone(before);after.metadata!.generation=3;after.spec!.enabled=true;
  expect(modelLifecycleReceipt(before,{activation:after},'start')).toEqual({uid:'owned-uid',generation:3});
  for(const mutate of [(m:ModelActivation)=>{m.metadata!.uid='replacement';},(m:ModelActivation)=>{m.metadata!.generation=4;},
    (m:ModelActivation)=>{m.spec!.local!.url='ollama://changed';},(m:ModelActivation)=>{m.spec!.enabled=false;},
    (m:ModelActivation)=>{m.metadata!.namespace='foreign';}]) {
    const wrong=structuredClone(after);mutate(wrong);expect(()=>modelLifecycleReceipt(before,{activation:wrong},'start')).toThrow('[API]');
  }
  expect(()=>modelLifecycleReceipt(before,after,'start')).toThrow('[API]');
});

test('HAR-11 LIFE-12 runtime diagnostics preserve OOM and restart evidence but discard private identifiers and error text',()=>{
  const item=model();item.status={phase:'Degraded',observedGeneration:2,message:'synthetic-secret'};
  const pod={metadata:{name:'synthetic-secret',uid:'synthetic-secret'},status:{phase:'Running',
    conditions:[{type:'Ready',status:'False'},{type:'PodScheduled',status:'True'}],containerStatuses:[{name:'synthetic-secret',ready:false,
      restartCount:3,state:{waiting:{reason:'CrashLoopBackOff',message:'synthetic-secret'}},
      lastState:{terminated:{reason:'OOMKilled',exitCode:137,message:'synthetic-secret'}}}]}} as KubeObject;
  const data=runtimeDiagnostic(item,[pod],'owned-uid',2);
  expect(data).toMatchObject({engine:'OLlama',deployment:'split',gpuCount:2,currentStatus:true,phase:'Degraded',
    pods:[{ready:false,scheduled:true,containers:[{state:'waiting',cause:'CrashLoopBackOff',lastCause:'OOMKilled',exitCode:137,restarts:3}]}]});
  expect(JSON.stringify(data)).not.toContain('synthetic-secret');
  expect(()=>runtimeDiagnostic(item,[pod],'foreign',2)).toThrow('[OWNERSHIP]');
  const tampered=structuredClone(data);tampered.pods[0]!.containers[0]!.cause='synthetic-secret';
  expect(parseRuntimeDiagnostic({...tampered,message:'synthetic-secret'}).pods[0]!.containers[0]!.cause).toBe('Unknown');
  expect(()=>parseRuntimeDiagnostic({...data,pods:Array(65).fill(pod)})).toThrow('[CONFIG]');
});

test('SLOT-02 node pools count one, two and four physical cards without inventing per-card consumption',()=>{
  for(const cards of [1,2,4]) {
    expect(gpuSlotCapacity(cards,'exclusive',2)).toBe(cards);
    expect(gpuSlotCapacity(cards,'shared',3)).toBe(cards*3);
    const shared=gpuSlotCapacity(cards,'shared',2),fillers=slotFillCount(shared);
    expect(fillers+1).toBe(shared-1);expect(fillers+2).toBe(shared);expect(shared-(fillers+1)).toBe(1);
  }
  for(const cards of [0,NaN,1.5,65])expect(()=>gpuSlotCapacity(cards,'exclusive',2)).toThrow('[CAPABILITY]');
  expect(()=>gpuSlotCapacity(4,'shared',0)).toThrow('[CAPABILITY]');
  expect(()=>slotFillCount(1)).toThrow('[CAPABILITY]');expect(()=>slotFillCount(33)).toThrow('[CAPABILITY]');
});

test('MGPU-01 MGPU-02 split totals and replica budgets use exact saved MiB with identity and generation checks',()=>{
  for(const engine of ['OLlama','VLLM'])for(const count of [2,4])for(const mode of ['split','replicated'] as const) {
    const item=model();item.spec!.local!.engine=engine;item.spec!.local!.gpuDeployment=mode;
    item.spec!.local!.gpuDevices=Array.from({length:count},(_,i)=>({uuid:`GPU-${i}`,nodeUid:'node',nodeName:'ai'}));
    expect(savedGpuBudget(item,'owned-uid',2)).toMatchObject({perCardMi:1234,totalMi:1234*count,
      displayedMi:1234*(mode==='split'?count:1),label:mode==='split'?'Total VRAM budget (MiB)':'VRAM budget (MiB)'});
  }
  const item=model();item.spec!.local!.vramMi=2048;
  expect(savedGpuBudget(item,'owned-uid',2).displayedMi).toBe(4096);
  expect(()=>savedGpuBudget(item,'owned-uid',3)).toThrow('[OWNERSHIP]');
  expect(()=>savedGpuBudget(item,'replacement',2)).toThrow('[OWNERSHIP]');
  item.spec!.local!.vramMi=0;expect(()=>savedGpuBudget(item,'owned-uid',2)).toThrow('[API]');
});
