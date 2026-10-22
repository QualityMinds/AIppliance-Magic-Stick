import {test,expect,type APIRequestContext} from '@playwright/test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseLabConfig,type LabConfig} from '../core/config.ts';
import {ResourceJournal,newRunId,recoveryJournalPath} from '../core/journal.ts';
import {saveReport,type CaseResult} from '../core/report.ts';
import {phase3Requirements,phase4Requirements,gpuCoverage,requireGpuProfile,gpuIds,gpuModeIds,phase3RuntimeCases,phase4SharingCases} from '../profiles/gpu-p0.ts';
import {BorrowedSharing,SharingWriteRejected,sharingSpec,type SharingSnapshot,type SharingAdapter} from '../core/borrowed-sharing.ts';
import {GpuScenario,gpuWorkerJournal,unfinishedJob,runtimePodConverged,requireDefaultGpuBackend,type GpuCreated} from '../core/gpu-scenario.ts';
import type {KubeObject} from '../core/observer.ts';
import type {ModelsPayload,ModelActivation} from '@magicstick/dashboard-contracts';
import {OwnedModelClient,modelContextUpdateReceipt} from '../core/owned-model.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {modelStopped,stopDiagnostic,waitModelStopped,type ModelStopState} from '../core/model-stop.ts';
import {writePrivate} from '../core/private-files.ts';
import {nvidiaValidationBinding,prepareValidation,requestValidationUi,completedValidation} from './validation-workflow.ts';
import {pinnedGpuModules,requireGpuProvider} from './prerequisites.ts';
import type {GpuSharingState,HardwareGpuDevice} from '@magicstick/dashboard-contracts';
import {gpuFixtureEstimateBody,sizedGpuFixture} from '../core/gpu-fixture.ts';
import type {GpuModelFixture} from '../core/config.ts';
import type {MemoryEstimate} from '@magicstick/dashboard-contracts';

let directory:string;
test('HAR-08 fresh GPU defaults require physical exclusive resources, not inherited sharing or stale DRA',()=>{
  for(const provider of ['nvidia','amd'] as const) {
    const state={provider,mode:'exclusive',backend:provider === 'nvidia' ? 'time-slicing' : 'dra',managed:false,available:true} as GpuSharingState;
    const node:KubeObject={metadata:{uid:'fixture-uid',labels:provider === 'nvidia' ? {'nvidia.com/gpu.count':'4'} : {}},
      status:{nodeInfo:{bootID:'fixture-boot'},allocatable:{[provider+'.com/gpu']:provider === 'nvidia' ? '4' : '1'}}};
    expect(()=>requireDefaultGpuBackend(state,node,'fixture-uid','fixture-boot')).not.toThrow();
    expect(()=>requireDefaultGpuBackend(state,node,'replacement','fixture-boot')).toThrow('[IDENTITY]');
    expect(()=>requireDefaultGpuBackend(state,node,'fixture-uid','new-boot')).toThrow('[IDENTITY]');
    expect(()=>requireDefaultGpuBackend({...state,mode:'shared'},node,'fixture-uid','fixture-boot')).toThrow('[CAPABILITY]');
    const busy=structuredClone(node);busy.status!.allocatable={[provider+'.com/gpu']:'8'};
    expect(()=>requireDefaultGpuBackend(state,busy,'fixture-uid','fixture-boot')).toThrow('[CAPABILITY]');
    if(provider === 'nvidia')for(const labels of [{'nvidia.com/device-plugin.config':'custom'},{'nvidia.com/device-plugin.config':'any'},
      {'nvidia.com/gpu.replicas':'2'},{'appliance.magicstick.dev/nvidia-dra-config':'owned'}, {'nvidia.com/dra-kubelet-plugin':'true'}]) {
      const foreign=structuredClone(node);Object.assign(foreign.metadata.labels!,labels);
      expect(()=>requireDefaultGpuBackend(state,foreign,'fixture-uid','fixture-boot')).toThrow('[CAPABILITY]');
    }
  }
});
test('MGPU-01 MGPU-02 GPU estimates replace CPU budgets and preserve per-card and per-copy scope',()=>{
  for(const count of [2,4])for(const gpuDeployment of ['split','replicated'] as const)for(const engine of ['OLlama','VLLM'] as const) {
    const fixture:GpuModelFixture={engine,computeTarget:'nvidia-gpu',gpuDeployment,automaticSizing:true,
      gpuDevices:Array.from({length:count},(_,i)=>({uuid:`GPU-${i}`,nodeUid:'node',nodeName:'ai'})),
      url:engine==='VLLM'?'hf://fixture/small':'ollama://fixture',memoryRequiredMi:4100,contextWindow:1024,maxNumSeqs:1};
    const estimate={minimumMi:1500,recommendedMi:2301,maximumMi:24000,gpuCount:count,memoryBudgetScope:'per-device',
      systemMemory:{scope:gpuDeployment==='replicated'?'per-copy':'per-pod',replicaCount:gpuDeployment==='replicated'?count:1,
        minimumMi:4096,recommendedMi:8201,maximumMi:65000}} as MemoryEstimate;
    expect(sizedGpuFixture(fixture,estimate)).toMatchObject({memoryRequiredMi:2400,systemMemoryMi:8300});
    expect(gpuFixtureEstimateBody(fixture)).not.toHaveProperty('memoryRequiredMi');
    for(const wrong of [{...estimate,gpuCount:1},{...estimate,memoryBudgetScope:undefined},
      {...estimate,systemMemory:{...estimate.systemMemory!,replicaCount:9}}, {...estimate,recommendedMi:NaN}])
      expect(()=>sizedGpuFixture(fixture,wrong)).toThrow('[API]');
    expect(()=>sizedGpuFixture(fixture,{...estimate,maximumMi:2000})).toThrow('[CAPABILITY]');
  }
});
test('HW-06 validation accepts legacy or exact DRA binding and rejects another identical NVIDIA card',()=>{
  const device={vendor:'nvidia',node:'fixture-node',nodeUid:'fixture-uid',pciAddress:'0000:01:00.0'} as HardwareGpuDevice;
  const card={uuid:'GPU-exact',name:'gpu-0',pool:'fixture-node',node:'fixture-node',nodeUid:'fixture-uid',pciAddress:device.pciAddress,claimName:'exact-claim'};
  const state={backend:'dra',devices:[card]} as GpuSharingState;
  const pod:KubeObject={metadata:{},spec:{nodeName:device.node,resourceClaims:[{name:'gpu',resourceClaimName:card.claimName}],
    initContainers:[{name:'engine',resources:{claims:[{name:'gpu'}]}}]}};
  const claim:KubeObject={metadata:{name:card.claimName,namespace:'ai'},status:{allocation:{devices:{results:[{driver:'gpu.nvidia.com',pool:card.pool,device:card.name}]}}}};
  const slices:KubeObject[]=[{metadata:{},spec:{driver:'gpu.nvidia.com',nodeName:card.node,devices:[{name:card.name,attributes:{uuid:{string:card.uuid}}}]}}];
  nvidiaValidationBinding(pod,device,state,claim,slices);
  for(const patch of [{uuid:'GPU-other'},{name:'gpu-other'},{claimName:'other'},{pool:'other-node'},{pciAddress:'0000:02:00.0'}])
    expect(()=>nvidiaValidationBinding(pod,device,{...state,devices:[{...card,...patch}]},claim,slices)).toThrow('[CAPABILITY]');
  expect(()=>nvidiaValidationBinding(pod,device,state,claim,[])).toThrow('[CAPABILITY]');
  const legacy:KubeObject={metadata:{},spec:{nodeName:device.node,initContainers:[{name:'engine',resources:{limits:{'nvidia.com/gpu':'1'}}}]}};
  nvidiaValidationBinding(legacy,device,{...state,backend:'time-slicing'});
  expect(()=>nvidiaValidationBinding(legacy,device,{...state,backend:'time-slicing'},undefined,[],4)).toThrow('[CAPABILITY]');
  expect(()=>nvidiaValidationBinding(legacy,device,state,claim,slices)).toThrow('[CAPABILITY]');
});
test('HW-06 SLOT-03 prepare exact-card DRA through borrowed settings before attempting the Verify UI',async()=>{
  const lab=config();delete lab.gpu!.devices.amd;
  const devices=Array.from({length:4},(_,index)=>({id:index===0?lab.gpu!.devices.nvidia!.id:`card-${index}`,vendor:'nvidia',
    node:lab.gpu!.nodeName,nodeUid:lab.gpu!.nodeUid,bootId:lab.gpu!.bootId,eligible:true,hostDriverReady:true,
    pciAddress:index===0?lab.gpu!.devices.nvidia!.pciAddress:`0000:0${index+2}:00.0`,validationAvailable:false})) as HardwareGpuDevice[];
  let backend='time-slicing',draAvailable=true,transitions:unknown[]=[];
  const scenario={config:lab,inventory:async()=>({devices}),state:async()=>({backend,draAvailable,mode:'shared',maxModels:2}),
    transition:async(...args:unknown[])=>{transitions.push(args);backend='dra';for(const device of devices)device.validationAvailable=true;}} as unknown as GpuScenario;
  expect((await prepareValidation(scenario,'OLlama','nvidia')).map(device=>device.id)).toEqual([lab.gpu!.devices.nvidia!.id]);
  expect(transitions).toEqual([['nvidia','shared',2,'dra']]);
  expect(await prepareValidation(scenario,'VLLM','all')).toHaveLength(4);expect(transitions).toHaveLength(1);
  backend='time-slicing';draAvailable=false;transitions=[];for(const device of devices)device.validationAvailable=false;
  // The request cannot touch the browser, create a verification receipt or
  // mutate the allocator when the exact-card prerequisite does not exist.
  const untouchedPage=new Proxy({},{get:()=>{throw new Error('Browser should not be touched');}});
  await expect(requestValidationUi(scenario,untouchedPage as never,'OLlama','nvidia',0))
    .rejects.toMatchObject({code:'GPU_VALIDATION',outcome:'Blocked',stage:'gpu-validation'});
  expect(transitions).toEqual([]);
  devices.splice(1);backend='time-slicing';devices[0]!.validationAvailable=true;
  expect(await prepareValidation(scenario,'OLlama','nvidia')).toHaveLength(1);expect(transitions).toEqual([]);
  devices[0]!.validation={OLlama:{state:'running'}};
  await expect(prepareValidation(scenario,'OLlama','nvidia')).rejects.toMatchObject({code:'BUSY',stage:'gpu-validation'});
});

test('HW-03 SHR-04 optional-vendor module reads use only registered physical providers',()=>{
  const lab=config();expect(pinnedGpuModules(lab)).toEqual(['amd-gpu','gpu']);delete lab.gpu!.devices.amd;
  expect(pinnedGpuModules(lab)).toEqual(['gpu']);expect(()=>requireGpuProvider(lab,'nvidia')).not.toThrow();
  expect(()=>requireGpuProvider(lab,'amd')).toThrow('[GPU_PROVIDER]');
});
test('HW-06 terminal failed validation stops with a concrete stage before polling stale device success',async()=>{
  const request={requestId:'diagnostic-fixture',deviceIds:['fixture-card'],engine:'OLlama' as const,startedAt:Date.now()};
  const job:KubeObject={metadata:{uid:'validation-uid',annotations:{'appliance.magicstick.dev/validation-request':request.requestId,
    'appliance.magicstick.dev/validation-device':'fixture-card','appliance.magicstick.dev/validation-engine':'OLlama'}},
    status:{conditions:[{type:'Failed',status:'True'}]}};
  const scenario={config:config(),live:{guard:async()=>{},observer:{list:async()=>[job]}},
    inventory:async()=>{throw new Error('A terminal failed Job must not be polled until a deadline');}} as unknown as GpuScenario;
  await expect(completedValidation(scenario,request)).rejects.toMatchObject({code:'CAPABILITY',outcome:'Failed',stage:'gpu-validation'});
});
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
        }}};
}
test('HAR-02 GPU profile rejects missing consent, stale boot, unbounded fixtures and cross-engine settings',()=>{
  const parsed=parseLabConfig(config(),directory);requireGpuProfile(parsed);
  for(const change of [
    (c:LabConfig)=>{delete c.gpu;},
    (c:LabConfig)=>{(c.gpu!.acknowledgeSharingTransitions as boolean)=false;},
    (c:LabConfig)=>{c.gpu!.bootId='stale-boot';},
    (c:LabConfig)=>{c.gpu!.devices.nvidia=c.gpu!.devices.amd;},
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
test('SLOT-02 current node inventory supplies one, two and four NVIDIA pool capacities and refuses conflicting or duplicate cards',async()=>{
  const scenario=Object.create(GpuScenario.prototype) as GpuScenario,lab=config();
  Object.defineProperty(scenario,'config',{value:lab});let size=1,advertised:string|undefined='1',duplicate=false;
  Object.defineProperty(scenario,'inventory',{value:async()=>({devices:Array.from({length:size},(_,index)=>({
    id:`card-${duplicate?0:index}`,vendor:'nvidia',nodeUid:lab.gpu!.nodeUid})),node:{metadata:{labels:advertised===undefined?{}:{'nvidia.com/gpu.count':advertised}}}})});
  Object.defineProperty(scenario,'state',{value:async()=>({mode:'shared',maxModels:2})});
  for(const cards of [1,2,4]){size=cards;advertised=String(cards);expect(await scenario.physicalCount('nvidia')).toBe(cards);expect(await scenario.slotCapacity('nvidia')).toBe(cards*2);}
  advertised=undefined;expect(await scenario.physicalCount('nvidia')).toBe(4);
  advertised='1';await expect(scenario.physicalCount('nvidia')).rejects.toThrow('[IDENTITY]');
  advertised='4';duplicate=true;await expect(scenario.physicalCount('nvidia')).rejects.toThrow('[IDENTITY]');
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
test('HAR-05 classic fixture names obey KubeAI bounds before any write intent',async()=>{
  const journal=await ResourceJournal.create(join(directory,'name-bounds.json'),newRunId(),'fixture-appliance');
  const prefix=journal.prefix,name=prefix+'a'.repeat(40-prefix.length);let requests=0,guards=0;
  const request={fetch:async()=>{requests++;throw new Error('No request is allowed.');}} as unknown as APIRequestContext;
  for(const fixture of [config().gpu!.models.amdOllama!,config().gpu!.models.nvidiaVllm!]) {
    expect(new OwnedModelClient(request,'https://dashboard.example.local',1000,name,fixture,prefix,async()=>{}).payload().name).toBe(name);
    expect(()=>new OwnedModelClient(request,'https://dashboard.example.local',1000,name+'a',fixture,prefix,async()=>{})).toThrow('[CONFIG]');
  }
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
test('MGPU-01 MGPU-02 consecutive successful scenarios in the same worker retain separate recoverable journals',async()=>{
  const root=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'fixture-appliance');
  const scenarios=[];
  for(let caseIndex=0;caseIndex<3;caseIndex++) {
    const next=await gpuWorkerJournal(directory,0,'fixture-appliance',true);
    const name=next.journal.prefix+'model';await next.journal.requested('model',name);
    await next.journal.owned('model',name,'uid-'+caseIndex,1);
    await writePrivate(join(next.directory,'gpu-baseline.json'),{caseIndex},true);
    scenarios.push(next);
  }
  expect(new Set(scenarios.map(item=>item.journal.runId)).size).toBe(3);
  expect(scenarios.map(item=>item.directory)).toEqual([1,2,3].map(index=>join(directory,'worker-'+index)));
  for(const [index,item] of scenarios.entries()) {
    expect((await ResourceJournal.resume(item.journal.filename,'fixture-appliance')).entries[0]!.uid).toBe('uid-'+index);
    expect(JSON.parse(await readFile(join(item.directory,'gpu-baseline.json'),'utf8'))).toEqual({caseIndex:index});
    expect(recoveryJournalPath('/private/runs/'+root.runId+'/worker-'+(index+1)+'/journal.json',true)).toBe(true);
  }
  expect((await ResourceJournal.resume(root.filename,'fixture-appliance')).entries).toEqual([]);
});
test('HAR-10 a Degraded positive runtime fails early and retains bounded private logs before cleanup',async({},info)=>{
    const scenario=Object.create(GpuScenario.prototype) as GpuScenario;
    Object.defineProperty(scenario,'directory',{value:directory});let reads=0;
    Object.defineProperty(scenario,'live',{value:{journal:{runId:newRunId()},modelState:async()=>{
      reads++;return {item:{metadata:{uid:'fixture-model',generation:2},spec:{local:{engine:'VLLM',computeTarget:'amd-gpu'}},
        status:{phase:'Degraded',observedGeneration:reads === 1 ? 1 : 2}},pods:[]};
    }}});
    const model={client:{name:'reg-fixture-model',logs:async()=>({pods:[],tailLines:300})},
      fixture:config().gpu!.models.amdVllm!,uid:'fixture-model',generation:2} as unknown as GpuCreated;
    await expect(scenario.ready(model)).rejects.toMatchObject({code:'CAPABILITY',outcome:'Failed',stage:'model-ready'});
    // Two readiness reads reject the stale observation and fail promptly; a
    // third read captures only structural diagnostics before cleanup.
    expect(reads).toBe(3);
    const attachment=info.attachments.find(item=>item.name==='magicstick-runtime-diagnostic');
    expect(JSON.parse(attachment!.body!.toString())).toMatchObject({engine:'VLLM',target:'amd-gpu',phase:'Degraded',currentStatus:true,pods:[]});
    expect(JSON.parse(await readFile(join(directory,'runtime-reg-fixture-model.json'),'utf8')))
      .toMatchObject({engine:'VLLM',target:'amd-gpu',stage:'model-ready',reason:'CAPABILITY'});
    expect(JSON.parse(await readFile(join(directory,'logs-reg-fixture-model.json'),'utf8'))).toEqual({pods:[],tailLines:300});
});
test('HAR-06 HAR-10 optional runtime diagnostic IO never replaces the original model failure',async()=>{
  const file=join(directory,'not-a-directory');await writePrivate(file,{});
  const scenario=Object.create(GpuScenario.prototype) as GpuScenario;
  Object.defineProperty(scenario,'directory',{value:file});
  Object.defineProperty(scenario,'live',{value:{journal:{runId:newRunId()},modelState:async()=>({
    item:{metadata:{uid:'fixture-model',generation:2},spec:{local:{engine:'VLLM',computeTarget:'amd-gpu'}},
      status:{phase:'Degraded',observedGeneration:2}},pods:[]})}});
  const model={client:{name:'reg-fixture-model',logs:async()=>({pods:[],tailLines:300})},
    fixture:config().gpu!.models.amdVllm!,uid:'fixture-model',generation:2} as unknown as GpuCreated;
  await expect(scenario.ready(model)).rejects.toMatchObject({code:'CAPABILITY',stage:'model-ready',outcome:'Failed'});
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
  expect(ids).toEqual(phase4SharingCases.remaining!.ids);
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
