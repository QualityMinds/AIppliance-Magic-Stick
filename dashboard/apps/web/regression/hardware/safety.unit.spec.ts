import {test,expect,type APIRequestContext} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseLabConfig,type LabConfig} from '../core/config.ts';
import {ResourceJournal,newRunId,recoveryJournalPath} from '../core/journal.ts';
import {saveReport,type CaseResult} from '../core/report.ts';
import {phase3Requirements,phase4Requirements,gpuCoverage,requireGpuProfile,gpuIds,gpuModeIds,phase3RuntimeCases,phase4SharingCases} from '../profiles/gpu-p0.ts';
import {BorrowedSharing,SharingWriteRejected,sharingSpec,type SharingSnapshot,type SharingAdapter} from '../core/borrowed-sharing.ts';
import {GpuScenario,gpuWorkerJournal,unfinishedJob,runtimePodConverged,type GpuCreated} from '../core/gpu-scenario.ts';
import type {KubeObject} from '../core/observer.ts';
import type {ModelsPayload,ModelActivation} from '@magicstick/dashboard-contracts';
import {freeTokenNodeCapacity} from '../core/freetoken-inventory.ts';
import {freeTokenRegressionEnabled} from '../core/engine-policy.ts';
import {OwnedModelClient,modelContextUpdateReceipt} from '../core/owned-model.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {modelStopped,stopDiagnostic,waitModelStopped,type ModelStopState} from '../core/model-stop.ts';

let directory:string;
test.beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'gpu-safety-'));});
test.afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
function config():LabConfig {
  const classic=(engine:'OLlama'|'VLLM',computeTarget:'amd-gpu'|'nvidia-gpu')=>({engine,computeTarget,
    url:engine === 'OLlama' ? 'ollama://fixture:small' : 'hf://fixture/small',memoryRequiredMi:8200,contextWindow:1024,maxNumSeqs:1 as const,
    kvCacheType:engine === 'OLlama' ? 'q8_0' : 'fp8'});
  return {version:1,profile:'preflight',dashboardUrl:'https://dashboard.example.local',identityUrl:'https://id.example.local',
    inferenceUrl:'https://inference.example.local',caFile:'ca.pem',usernameFile:'username.txt',passwordFile:'password.txt',
    observerKubeconfig:'observer.yaml',modelCleanupKubeconfig:'cleaner.yaml',requestTimeoutMs:1000,loginTimeoutMs:5000,
    lock:{namespace:'magicstick-regression',name:'lab-lock',kubeconfig:'locker.yaml'},
    smokeModel:{engine:'OLlama',computeTarget:'cpu',url:'ollama://fixture:small',memoryRequiredMi:2048,contextWindow:1024,maxNumSeqs:1},
    expected:{applianceUid:'fixture-appliance',applianceNamespace:'ai-system',applianceName:'local',role:'magicstick-admin',
      nodes:[{name:'fixture-node',uid:'fixture-uid',bootId:'fixture-boot'}],capabilities:[{target:'cpu',engines:['OLlama']}],
      flux:{namespace:'flux-system',name:'flux-system',revision:'sha1:'+'a'.repeat(40)},
      images:['web','api'].map(container=>({namespace:'fixture',deployment:container,container,digest:'sha256:'+'b'.repeat(64)}))},
    gpu:{acknowledgeSharingTransitions:true,nodeName:'fixture-node',nodeUid:'fixture-uid',bootId:'fixture-boot',sharedSlots:2,
      devices:{amd:{id:'fixture-uid/0000:01:00.0',pciAddress:'0000:01:00.0'},nvidia:{id:'fixture-uid/0000:02:00.0',pciAddress:'0000:02:00.0'}},
      models:{amdOllama:classic('OLlama','amd-gpu'),amdVllm:classic('VLLM','amd-gpu'),
        nvidiaOllama:classic('OLlama','nvidia-gpu'),nvidiaVllm:classic('VLLM','nvidia-gpu'),
        freetoken:{engine:'FreeToken',computeTarget:'nvidia-gpu',url:'hf://fixture/supported',memoryRequiredMi:32768,
          contextWindow:1024,maxNumSeqs:1,freetoken:{gpuDevice:'node:fixture-node',gpuCount:1,memoryStrategy:'auto',
            gpuMemoryMi:24576,systemMemoryMi:32768,advanced:{cacheType:'radix'}}}}}};
}
test('HAR-02 GPU profile rejects missing consent, stale boot, unbounded fixtures and cross-engine settings',()=>{
  const parsed=parseLabConfig(config(),directory);requireGpuProfile(parsed);
  for(const change of [
    (c:LabConfig)=>{delete c.gpu;},
    (c:LabConfig)=>{(c.gpu!.acknowledgeSharingTransitions as boolean)=false;},
    (c:LabConfig)=>{c.gpu!.bootId='stale-boot';},
    (c:LabConfig)=>{c.gpu!.devices.nvidia=c.gpu!.devices.amd;},
    (c:LabConfig)=>{c.gpu!.models.freetoken!.kvCacheType='fp8';},
    (c:LabConfig)=>{c.gpu!.models.freetoken!.freetoken!.gpuCount=2;},
    (c:LabConfig)=>{c.gpu!.models.freetoken!.freetoken!.gpuMemoryMi=32769;},
    (c:LabConfig)=>{c.gpu!.models.amdOllama!.memoryRequiredMi=32769;},
    (c:LabConfig)=>{c.gpu!.models.nvidiaVllm!.contextWindow=262144;},
    (c:LabConfig)=>{(c.gpu! as unknown as Record<string,unknown>).ignoreBoot=true;},
  ]) {
    const value=config();change(value);
    expect(()=>requireGpuProfile(parseLabConfig(value,directory))).toThrow(value.gpu ? '[CONFIG]' : '[PREREQUISITE]');
  }
});
test('HAR-08 a failed attempt is still an active diagnostic until its Job has a terminal condition',()=>{
  expect(unfinishedJob({metadata:{},status:{failed:1,active:1}})).toBe(true);
  expect(unfinishedJob({metadata:{},status:{succeeded:1}})).toBe(true);
  for(const type of ['Complete','Failed']) {
    expect(unfinishedJob({metadata:{},status:{conditions:[{type,status:'False'}]}})).toBe(true);
    expect(unfinishedJob({metadata:{},status:{conditions:[{type,status:'True'}]}})).toBe(false);
  }
});
test('HAR-10 Stop acceptance retains configuration and separately verifies runtime and catalog withdrawal',()=>{
  const stopped={item:{metadata:{generation:2},spec:{type:'local',enabled:false}},pods:[],models:{models:[]}} as unknown as ModelStopState;
  expect(modelStopped(stopped,'reg-fixture')).toBe(true);
  expect(modelStopped({...stopped,item:undefined},'reg-fixture')).toBe(false);
  expect(modelStopped({...stopped,pods:[{metadata:{deletionTimestamp:'2026-10-06T12:00:00Z'}}]},'reg-fixture')).toBe(false);
  const catalog=structuredClone(stopped);catalog.models.models=[{id:'reg-fixture'}] as ModelsPayload['models'];
  expect(modelStopped(catalog,'reg-fixture')).toBe(false);
});
test('HAR-10 Stop timeout records the unfulfilled predicate without raw Pod or activation secrets',async()=>{
  let now=0;
  const name='reg-fixture',state={item:{metadata:{generation:2},spec:{type:'local',enabled:false,secret:'synthetic-secret'}},
    observed:{metadata:{generation:2},spec:{enabled:false},status:{observedGeneration:2}},
    pods:[{metadata:{name,uid:'fixture-pod',deletionTimestamp:'2026-10-06T12:00:00Z',annotations:{token:'synthetic-secret'}},
      spec:{terminationGracePeriodSeconds:30,containers:[{env:[{name:'TOKEN',value:'synthetic-secret'}]}]},
      status:{phase:'Running',message:'synthetic-secret',containerStatuses:[{name:'server',ready:false,restartCount:0}]}}],
    models:{models:[]}} as unknown as ModelStopState;
  const records:unknown[]=[];
  await expect(waitModelStopped(async()=>state,name,async value=>{records.push(value);},
    {timeoutMs:100,now:()=>now,wait:async value=>{now+=value;}})).rejects.toMatchObject({code:'DEADLINE',stage:'model-stopped'});
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({checks:{intentDisabled:true,runtimePodsGone:false,catalogEntryGone:true},
    pods:[{deleting:true,terminationGracePeriodSeconds:30}]});
  expect(JSON.stringify(records)).not.toContain('synthetic-secret');
  expect(stopDiagnostic(undefined,name)).toMatchObject({sampled:false});
});
test('HAR-10 a missing generated catalog is unknown rather than successful Stop evidence',()=>{
  const state={item:{spec:{enabled:false}},pods:[],models:{}} as unknown as ModelStopState;
  expect(modelStopped(state,'reg-fixture')).toBe(false);
  expect(stopDiagnostic(state,'reg-fixture').checks.catalogEntryGone).toBe(false);
});
test('HAR-10 a Stop diagnostic write failure never masks the actual lifecycle deadline',async()=>{
  let now=0;
  const state={item:{spec:{enabled:false}},pods:[{metadata:{}}],models:{models:[]}} as unknown as ModelStopState;
  await expect(waitModelStopped(async()=>state,'reg-fixture',async()=>{throw new Error('private write failure');},
    {timeoutMs:10,now:()=>now,wait:async value=>{now+=value;}})).rejects.toMatchObject({code:'DEADLINE',stage:'model-stopped'});
});
test('HAR-10 successful Stop records its duration and safe initial Pod/container identity',async()=>{
  let now=0,reads=0;const records:unknown[]=[];
  const initial={item:{spec:{enabled:false}},models:{models:[]},pods:[{
    metadata:{uid:'12345678-1234-1234-1234-123456789abc'},status:{containerStatuses:[{
      name:'server',containerID:'containerd://'+'a'.repeat(64),ready:false,restartCount:0,
    }]},
  }]} as unknown as ModelStopState;
  const stopped={...initial,pods:[]};
  await waitModelStopped(async()=>++reads === 1 ? initial : stopped,'reg-fixture',async value=>{records.push(value);},
    {timeoutMs:5000,now:()=>now,wait:async value=>{now+=value;}});
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({observation:{elapsedMs:1000,completed:true},
    checks:{intentDisabled:true,runtimePodsGone:true,catalogEntryGone:true},initial:{pods:[{
      uid:'12345678-1234-1234-1234-123456789abc',containers:[{containerID:'containerd://'+'a'.repeat(64)}],
    }]}});
});
test('HAR-05 classic fixture names obey KubeAI bounds before any write intent without truncating FreeToken names',async()=>{
  const journal=await ResourceJournal.create(join(directory,'name-bounds.json'),newRunId(),'fixture-appliance');
  const prefix=journal.prefix,name=prefix+'a'.repeat(40-prefix.length);let requests=0,guards=0;
  const request={fetch:async()=>{requests++;throw new Error('No request is allowed.');}} as unknown as APIRequestContext;
  for(const fixture of [config().gpu!.models.amdOllama!,config().gpu!.models.nvidiaVllm!]) {
    expect(new OwnedModelClient(request,'https://dashboard.example.local',1000,name,fixture,prefix,async()=>{}).payload().name).toBe(name);
    expect(()=>new OwnedModelClient(request,'https://dashboard.example.local',1000,name+'a',fixture,prefix,async()=>{})).toThrow('[CONFIG]');
  }
  expect(new OwnedModelClient(request,'https://dashboard.example.local',1000,name+'aa',config().gpu!.models.freetoken!,
    prefix,async()=>{}).payload().name).toBe(name+'aa');
  const live={context:{request},config:config(),guard:async()=>{guards++;}} as unknown as LiveFoundation;
  await expect(LiveFoundation.prototype.createModel.call(live,'a'.repeat(41-prefix.length),journal,
    config().gpu!.models.nvidiaOllama!)).rejects.toMatchObject({code:'CONFIG'});
  expect(requests).toBe(0);expect(guards).toBe(0);expect(journal.entries).toEqual([]);
});
test('HAR-10 rollout readiness rejects old context, terminating replicas and stale restart configuration before inference',()=>{
  const item:ModelActivation={metadata:{uid:'fixture-model',generation:2},spec:{type:'local',enabled:true,
    local:{engine:'OLlama',computeTarget:'amd-gpu',contextWindow:2048,maxNumSeqs:1,kvCacheType:'q8_0'}}};
  const pod:KubeObject={metadata:{uid:'fixture-pod'},status:{phase:'Running',conditions:[{type:'Ready',status:'True'}]},
    spec:{containers:[{name:'server',image:'fixture:local',env:Object.entries({MAGICSTICK_ENGINE:'OLlama',
      MAGICSTICK_COMPUTE_TARGET:'amd-gpu',OLLAMA_CONTEXT_LENGTH:'2048',OLLAMA_NUM_PARALLEL:'1',OLLAMA_KV_CACHE_TYPE:'q8_0'})
      .map(([name,value])=>({name,value}))}]}};
  expect(runtimePodConverged([pod],item)).toBe(true);
  expect(runtimePodConverged([],item)).toBe(false);
  expect(runtimePodConverged([pod],undefined)).toBe(false);
  for(const change of [
    (p:KubeObject)=>{p.metadata.deletionTimestamp='2026-10-05T12:28:19Z';},
    (p:KubeObject)=>{p.status!.phase='Pending';},
    (p:KubeObject)=>{p.status!.conditions![0]!.status='False';},
    (p:KubeObject)=>{((p.spec!.containers as Array<{env:Array<{name:string;value:string}>}>)[0]!.env)
      .find(e=>e.name==='OLLAMA_CONTEXT_LENGTH')!.value='1024';},
  ]){const invalid=structuredClone(pod);change(invalid);expect(runtimePodConverged([invalid],item)).toBe(false);}
  const retiring=structuredClone(pod);retiring.metadata.deletionTimestamp='2026-10-05T12:28:19Z';
  expect(runtimePodConverged([pod,retiring],item)).toBe(false);
  const restart=structuredClone(item);restart.spec!.local!.env={MAGICSTICK_RESTART:'new-nonce'};
  expect(runtimePodConverged([pod],restart)).toBe(false);
  const vllm=structuredClone(item);vllm.spec!.local!.engine='VLLM';vllm.spec!.local!.kvCacheType='fp8';
  const vpod=structuredClone(pod);vpod.spec={containers:[{name:'server',image:'fixture:local',env:[
    {name:'MAGICSTICK_ENGINE',value:'VLLM'},{name:'MAGICSTICK_COMPUTE_TARGET',value:'amd-gpu'}],
    args:['--max-model-len=2048','--max-num-seqs=1','--kv-cache-dtype=fp8']}]};
  expect(runtimePodConverged([vpod],vllm)).toBe(true);
  (vpod.spec.containers as Array<{args:string[]}>)[0]!.args[0]='--max-model-len=1024';
  expect(runtimePodConverged([vpod],vllm)).toBe(false);
  const ft=structuredClone(item);ft.spec!.local!.engine='FreeToken';
  const fpod=structuredClone(pod);fpod.spec={containers:[{name:'freetoken',image:'fixture:local',env:[
    {name:'MAGICSTICK_FREETOKEN_CONTEXT_LENGTH',value:'2048'},{name:'MAGICSTICK_FREETOKEN_MAX_RUNNING_REQUESTS',value:'1'}]}]};
  expect(runtimePodConverged([fpod],ft)).toBe(true);
  (fpod.spec.containers as Array<{env:Array<{name:string;value:string}>}>)[0]!.env[0]!.value='1024';
  expect(runtimePodConverged([fpod],ft)).toBe(false);
});
test('HAR-10 replica readiness requires every current child UID, matching runtime and non-terminating Pod',()=>{
  const item:ModelActivation={metadata:{uid:'parent',generation:1},spec:{type:'local',local:{engine:'OLlama',computeTarget:'nvidia-gpu',
    gpuDeployment:'replicated',gpuDevices:[{uuid:'gpu-a'},{uuid:'gpu-b'}],contextWindow:2048,maxNumSeqs:1}},status:{replication:{desired:2,ready:2,
    instances:['a','b'].map(id=>({name:`copy-${id}`,uuid:`gpu-${id}`,nodeName:'fixture-node',modelUid:`uid-${id}`,phase:'Ready'}))}}};
  const pods:KubeObject[]=['a','b'].map(id=>({metadata:{uid:`pod-${id}`,labels:{'appliance.magicstick.dev/activation-uid':'parent'},
    ownerReferences:[{apiVersion:'kubeai.org/v1',kind:'Model',name:`copy-${id}`,uid:`uid-${id}`,controller:true}]},
    status:{phase:'Running',conditions:[{type:'Ready',status:'True'}]},spec:{containers:[{name:'server',image:'fixture:local',env:[
      {name:'MAGICSTICK_ENGINE',value:'OLlama'},{name:'MAGICSTICK_COMPUTE_TARGET',value:'nvidia-gpu'},
      {name:'OLLAMA_CONTEXT_LENGTH',value:'2048'},{name:'OLLAMA_NUM_PARALLEL',value:'1'}]}]}}));
  expect(runtimePodConverged(pods,item)).toBe(true);
  expect(runtimePodConverged(pods.slice(0,1),item)).toBe(false);
  for(const change of [
    (pod:KubeObject)=>{pod.metadata.ownerReferences![0]!.uid='old-child';},
    (pod:KubeObject)=>{pod.metadata.labels!['appliance.magicstick.dev/activation-uid']='foreign-parent';},
    (pod:KubeObject)=>{pod.metadata.deletionTimestamp='now';},
    (pod:KubeObject)=>{pod.status!.conditions![0]!.status='False';},
  ]) {const invalid=structuredClone(pods);change(invalid[0]!);expect(runtimePodConverged(invalid,item)).toBe(false);}
  const failed=structuredClone(item);failed.status!.replication!.instances![1]!.phase='Degraded';
  expect(runtimePodConverged(pods,failed)).toBe(false);
});
test('HAR-07 a context PUT accepts only the direct same-UID next-generation receipt and journals it before cleanup',async()=>{
  const journal=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'fixture-appliance');
  const name=journal.prefix+'context',uid='fixture-model';
  const current:ModelActivation={metadata:{name,uid,generation:1},spec:{enabled:true,type:'local',
    local:{engine:'OLlama',computeTarget:'amd-gpu',url:'ollama://fixture:small',contextWindow:1024}}};
  const updated:ModelActivation=structuredClone(current);updated.metadata!.generation=2;updated.spec!.local!.contextWindow=2048;
  await journal.requested('model',name);await journal.owned('model',name,uid,1);
  const request={fetch:async(url:string,options:{method:string;data?:string;headers:Record<string,string>})=>{
    expect(new URL(url).pathname).toBe(`/api/models/${name}`);expect(options.method).toBe('PUT');
    expect(options.headers.origin).toBe('https://dashboard.example.local');
    expect(options.headers['x-magicstick-csrf']).toBe('dashboard');
    expect(JSON.parse(options.data!)).toEqual({expectedRevision:`generation:${uid}:1`,local:{contextWindow:2048}});
    return {status:()=>200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(updated))};
  }} as unknown as APIRequestContext;
  const client=new OwnedModelClient(request,'https://dashboard.example.local',1000,name,config().gpu!.models.amdOllama!,journal.prefix,async()=>{});
  client.adopt(uid);const receipt=await client.editContext(current,2048);expect(receipt).toEqual({uid,generation:2});
  await journal.modelGeneration(name,uid,1,receipt.generation);
  expect((await ResourceJournal.resume(journal.filename,'fixture-appliance')).entries[0]!.generation).toBe(2);
  for(const invalid of [{activation:updated},{...updated,metadata:{...updated.metadata,uid:'replacement'}},
    {...updated,metadata:{...updated.metadata,generation:1}},{...updated,metadata:{...updated.metadata,generation:3}},
    {...updated,spec:{...updated.spec,local:{...updated.spec!.local,contextWindow:1024}}},
    {...updated,spec:{...updated.spec,enabled:false}}]) {
    try {modelContextUpdateReceipt(current,invalid,2048);throw new Error('unexpected valid receipt');}
    catch(error) {expect(error).toMatchObject({code:'API',outcome:'Failed',stage:'model-update'});}
  }
});
if(freeTokenRegressionEnabled)test('FT-02 scheduler-only capability inventory resolves independent live VRAM without cross-node or CPU fallback',()=>{
  const data:ModelsPayload={activations:[],models:[],presets:{},computeTargets:{default:'cpu',targets:[
    {id:'nvidia-gpu',kind:'gpu',engines:['FreeToken'],available:true}],freeTokenCapabilities:{available:true,supportedVendors:['nvidia'],
    devices:[{id:'node:fixture-node',node:'fixture-node',supported:true,gpuCount:1,maxGpuCount:1,
      systemMemoryMi:125629,systemAvailableMi:116746}]}},computeMemory:{devices:[
      {id:'nvidia-physical',kind:'gpu',vendor:'nvidia',computeTarget:'nvidia-gpu',nodes:['fixture-node'],metricsAvailable:true,
        totalMi:48540,unreservedMi:42000,freeMi:41000,freeToken:{id:'node:fixture-node',supported:true}}]}};
  expect(freeTokenNodeCapacity(data,'fixture-node')).toMatchObject({gpuPhysicalMi:48540,gpuAvailableMi:41000,
    systemPhysicalMi:125629,systemAvailableMi:116746,maxGpuCount:1});
  const zero=structuredClone(data);zero.computeMemory!.devices![0]!.freeMi=0;
  expect(freeTokenNodeCapacity(zero,'fixture-node').gpuAvailableMi).toBe(0);
  for(const change of [
    (d:ModelsPayload)=>{d.computeMemory!.devices![0]!.freeMi=null;},
    (d:ModelsPayload)=>{d.computeMemory!.devices![0]!.metricsAvailable=false;},
    (d:ModelsPayload)=>{d.computeMemory!.devices![0]!.nodes=['other-node'];},
    (d:ModelsPayload)=>{d.computeMemory!.devices![0]!.kind='cpu';},
    (d:ModelsPayload)=>{d.computeMemory!.devices![0]!.freeToken!.id='node:other-node';},
    (d:ModelsPayload)=>{d.computeTargets.freeTokenCapabilities!.devices![0]!.systemAvailableMi=null;},
  ]) {const invalid=structuredClone(data);change(invalid);expect(()=>freeTokenNodeCapacity(invalid,'fixture-node')).toThrow('[CAPABILITY]');}
});
test('HAR-07 worker replacement cannot overwrite or adopt earlier ownership and restore receipts',async()=>{
  const original=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'fixture-appliance');
  await original.requested('model',original.prefix+'model');
  const first=await gpuWorkerJournal(directory,0,'fixture-appliance');
  expect(first.journal.runId).toBe(original.runId);expect(first.journal.entries).toEqual(original.entries);
  const replacement=await gpuWorkerJournal(directory,1,'fixture-appliance');
  expect(replacement.directory).toBe(join(directory,'worker-1'));
  expect(replacement.journal.runId).not.toBe(original.runId);expect(replacement.journal.entries).toEqual([]);
  await expect(gpuWorkerJournal(directory,1,'fixture-appliance')).rejects.toThrow('[PRIVATE_FILE]');
  expect((await ResourceJournal.resume(join(directory,'journal.json'),'fixture-appliance')).entries).toEqual(original.entries);
  const root='/private/runs/'+original.runId+'/';
  expect(recoveryJournalPath(root+'journal.json')).toBe(true);
  expect(recoveryJournalPath(root+'worker-1/journal.json')).toBe(false);
  for(const index of [1,64]) expect(recoveryJournalPath(root+`worker-${index}/journal.json`,true)).toBe(true);
  for(const path of ['worker-0/journal.json','worker-01/journal.json','worker-65/journal.json',
    'worker-1/../journal.json','worker-1/worker-2/journal.json','journal.json/extra'])
    expect(recoveryJournalPath(root+path,true)).toBe(false);
});
test('HAR-10 a Degraded positive runtime fails early and retains bounded private logs before cleanup',async()=>{
    const scenario=Object.create(GpuScenario.prototype) as GpuScenario;
    Object.defineProperty(scenario,'directory',{value:directory});let reads=0;
    Object.defineProperty(scenario,'live',{value:{journal:{runId:newRunId()},modelState:async()=>{
      reads++;return {item:{metadata:{generation:2},status:{phase:'Degraded',observedGeneration:reads === 1 ? 1 : 2}}};
    }}});
    const model={client:{name:'reg-fixture-model',logs:async()=>({pods:[],tailLines:300})},
      fixture:config().gpu!.models.amdVllm!,uid:'fixture-model',generation:2} as unknown as GpuCreated;
    await expect(scenario.ready(model)).rejects.toMatchObject({code:'CAPABILITY',outcome:'Failed',stage:'model-ready'});
    expect(reads).toBe(2);
    expect(JSON.parse(await readFile(join(directory,'runtime-reg-fixture-model.json'),'utf8')))
      .toMatchObject({engine:'VLLM',target:'amd-gpu',stage:'model-ready',reason:'CAPABILITY'});
    expect(JSON.parse(await readFile(join(directory,'logs-reg-fixture-model.json'),'utf8'))).toEqual({pods:[],tailLines:300});
});
test('HAR-10 GPU acceptance needs every variant-layer tuple and keeps maintenance gates open',async()=>{
  for(const phase of [3,4] as const) {
    const requirements=phase === 3 ? phase3Requirements : phase4Requirements;
    const cases:CaseResult[]=requirements.map(r=>({...r,variant:r.variant as CaseResult['variant'],outcome:'Passed' as const,durationMs:1}));
    expect(gpuCoverage(phase,cases).complete).toBe(true);
    for(let index=0;index<cases.length;index++) expect(gpuCoverage(phase,cases.filter((_,i)=>i!==index)).complete).toBe(false);
    expect(gpuCoverage(phase,cases.map(c=>({...c,layer:'A',environment:'fixture'}))).complete).toBe(false);
    const report=await saveReport(directory,newRunId(),cases,gpuIds(phase),'unknown',`phase${phase}`);
    if(phase === 3) expect(report.fullPhase3Accepted).toBe(true);
    else {expect(report.installedPhase4Accepted).toBe(true);expect(report.fullPhase4Accepted).toBe(false);}
    expect((await saveReport(directory,newRunId(),cases.slice(1),gpuIds(phase),'unknown',`phase${phase}`)).acceptable).toBe(false);
  }
});
test('HAR-10 the fixed sharing diagnostic uses its selected IDs and can never certify canonical Phase 4',async()=>{
  const ids=gpuModeIds('phase4-sharing','remaining')!;
  expect(ids).toEqual(phase4SharingCases.remaining.ids);
  expect(gpuModeIds('phase4')).toEqual(gpuIds(4));
  for(const mode of ['phase3-gpu','phase4','phase4-fast'])
    expect(()=>gpuModeIds(mode,'remaining')).toThrow('[CONFIG]');
  expect(()=>gpuModeIds('phase4-sharing','arbitrary')).toThrow('[CONFIG]');
  const cases:CaseResult[]=phase4Requirements.filter(r=>ids.includes(r.id) && ['A','E','O'].includes(r.layer))
    .map(r=>({...r,variant:r.variant as CaseResult['variant'],outcome:'Passed',durationMs:1}));
  const selected=await saveReport(directory,newRunId(),cases,ids,'unknown','phase4-sharing');
  expect(selected.acceptable).toBe(true);expect(selected.installedPhase4Accepted).toBe(false);
  expect(selected.fullPhase4Accepted).toBe(false);
  const canonical=await saveReport(directory,newRunId(),cases,gpuIds(4),'unknown','phase4');
  expect(canonical.acceptable).toBe(false);expect(canonical.installedPhase4Accepted).toBe(false);
});
test('HAR-10 the bounded vLLM lifecycle diagnostic does not select experimental engines or certify Phase 3',async()=>{
  const ids=gpuModeIds('phase3-gpu','vllm-lifecycle')!;
  expect(ids).toEqual(phase3RuntimeCases['vllm-lifecycle'].ids);
  expect(ids.some(id=>id.startsWith('FT-'))).toBe(false);
  expect(()=>gpuModeIds('phase3','vllm-lifecycle')).toThrow('[CONFIG]');
  expect(()=>gpuModeIds('phase3-gpu','freetoken')).toThrow('[CONFIG]');
  const cases:CaseResult[]=phase3Requirements.filter(r=>ids.includes(r.id) && ['A','E'].includes(r.layer))
    .map(r=>({...r,variant:r.variant as CaseResult['variant'],outcome:'Passed',durationMs:1}));
  const selected=await saveReport(directory,newRunId(),cases,ids,'unknown','phase3-gpu');
  expect(selected.acceptable).toBe(true);expect(selected.fullPhase3Accepted).toBe(false);
});
test('HAR-10 repeated NVIDIA lifecycle diagnosis selects only the two classic NVIDIA runtimes',()=>{
  expect(gpuModeIds('phase3-gpu','nvidia-lifecycle')).toEqual(phase3RuntimeCases['vllm-lifecycle'].ids);
  const selection=new RegExp(phase3RuntimeCases['nvidia-lifecycle'].grep);
  for(const label of ['nvidia-ollama','nvidia-vllm'])expect(selection.test(`${label} actual cycle 1`)).toBe(true);
  for(const label of ['amd-ollama','amd-vllm','freetoken'])expect(selection.test(`${label} actual cycle 1`)).toBe(false);
  for(const mode of ['phase3','phase4-sharing'])expect(()=>gpuModeIds(mode,'nvidia-lifecycle')).toThrow('[CONFIG]');
});
test('HAR-07 concurrent admissions persist all immutable ownership receipts and exact single-model cleanup retains the key',async()=>{
  const filename=join(directory,'journal.json'),journal=await ResourceJournal.create(filename,newRunId(),'fixture-appliance');
  const names=Array.from({length:8},(_,i)=>journal.prefix+'model-'+i);
  await Promise.all(names.map(name=>journal.requested('model',name)));
  await Promise.all(names.map((name,i)=>journal.owned('model',name,'uid-'+i,1)));
  await journal.requested('key',journal.prefix+'key');await journal.owned('key',journal.prefix+'key','fixture-key');
  const resumed=await ResourceJournal.resume(filename,'fixture-appliance');
  expect(resumed.entries).toHaveLength(9);expect(resumed.entries.every(e=>e.state === 'owned' && e.uid)).toBe(true);
  const deleted:string[]=[];
  const adapter={lookup:async(e:{name:string;uid:string|null})=>({uid:e.uid!}),
    removeIfUid:async(e:{name:string},uid:string)=>{expect(uid).toBe('uid-0');deleted.push(e.name);},verifyRemoved:async()=>true};
  await resumed.cleanup({model:adapter,key:adapter,app:adapter,identity:adapter},async()=>{}, {kind:'model',name:names[0]!});
  expect(deleted).toEqual([names[0]]);
  expect((await ResourceJournal.resume(filename,'fixture-appliance')).entries.filter(e=>e.state === 'owned')).toHaveLength(8);
});
test('HAR-08 explicit CAS rejection is retried only after unchanged UID generation and spec proof',async()=>{
  for(const foreign of [false,true]) {
    const state:SharingSnapshot['state']={provider:'nvidia',backend:'time-slicing',mode:'shared',managed:true,experimental:false,
      maxModels:5,nodeName:'fixture-node',nodeUid:'fixture-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
      message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false};
    let value:SharingSnapshot={state,object:{metadata:{uid:'fixture-module',generation:2,resourceVersion:'7'},spec:
      sharingSpec({enabled:true,parameters:{unrelated:'keep'}},{...state,acknowledgeSharing:true,acknowledgeRestart:true})}};
    let reject=false,writes=0;
    const adapter:SharingAdapter={read:async()=>structuredClone(value),apply:async request=>{
      writes++;
      if(reject) {
        reject=false;
        if(foreign) value.object.metadata.generation!++;
        throw new SharingWriteRejected(409);
      }
      value={state:{...value.state,mode:request.mode,maxModels:request.maxModels,expectedRevision:String(writes+7)},
        object:{metadata:{...value.object.metadata,generation:value.object.metadata.generation!+1,resourceVersion:String(writes+7)},
          spec:sharingSpec(value.object.spec!,request)}};
    }};
    const journal=await BorrowedSharing.create(join(directory,foreign+'-sharing.json'),{runId:newRunId(),targetUid:'fixture-appliance',
      nodeName:'fixture-node',nodeUid:'fixture-uid'},adapter,async()=>{});
    await journal.borrow('nvidia');await journal.change('nvidia','exclusive',2);reject=true;
    if(foreign) {await expect(journal.restore()).rejects.toThrow('[CONFLICT]');expect(writes).toBe(2);expect(journal.entries[0]!.state).toBe('pending');}
    else {await journal.restore();expect(writes).toBe(3);expect(journal.entries[0]!.state).toBe('restored');}
  }
});
