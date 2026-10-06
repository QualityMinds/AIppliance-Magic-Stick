import type {Browser,Page} from '@playwright/test';
import type {GpuSharingRequest,GpuSharingState,HardwareGpuDevice,ModelsPayload,ModelActivation} from '@magicstick/dashboard-contracts';
import {MagicStickApi} from '@magicstick/dashboard-api-client';
import {join,dirname} from 'node:path';
import {loadLabConfig,type GpuModelFixture,type RuntimeModelFixture} from './config.ts';
import {LiveFoundation} from './live-foundation.ts';
import {ResourceJournal,newRunId} from './journal.ts';
import {BorrowedSharing,canonical,SharingWriteRejected,type Provider,type SharingAdapter} from './borrowed-sharing.ts';
import {requireGpuProfile} from '../profiles/gpu-p0.ts';
import {HarnessError,requireSafe} from './errors.ts';
import {poll,currentReady} from './poll.ts';
import {InferenceProbe} from './inference.ts';
import {activation,fixtureIsAdvertised,OwnedModelClient} from './owned-model.ts';
import type {KubeObject} from './observer.ts';
import {openInferenceSession,type ExactDashboardRequest} from './auth.ts';
import {privateDirectory,readPrivate,writePrivate} from './private-files.ts';

export interface GpuCreated {client:OwnedModelClient;fixture:RuntimeModelFixture;uid:string;generation:number}
type Container = {name:string;image:string;args?:string[];env?:Array<{name:string;value?:string}>;
  resources?:{requests?:Record<string,string>;limits?:Record<string,string>;claims?:Array<{name:string}>}};
export const podSpec = (pod:KubeObject) => pod.spec as {nodeName?:string;runtimeClassName?:string;nodeSelector?:Record<string,string>;
  containers?:Container[];resourceClaims?:Array<{name:string;resourceClaimName?:string}>};
export const unfinishedJob = (job:KubeObject) => !job.status?.conditions?.some(condition=>
  ['Complete','Failed'].includes(condition.type ?? '') && condition.status === 'True');

/** KubeAI replica counters can still describe an old Ready Pod during a
 * parameter rollout. Accept only one non-terminating Ready runtime whose
 * observed configuration matches the current saved intent. Keep terminating
 * Pods in the ownership inventory so teardown and convergence cannot mistake
 * their continued presence for completed deletion. These mappings assert the
 * existing Magic Stick runtime contract; they are not a new launch policy. */
export function runtimePodConverged(pods:KubeObject[],item:ModelActivation|undefined) {
  if(pods.length !== 1 || !item?.spec?.local) return false;
  const pod=pods[0]!,local=item.spec.local;
  if(pod.metadata.deletionTimestamp || pod.status?.phase !== 'Running' ||
    !pod.status.conditions?.some(c=>c.type === 'Ready' && c.status === 'True')) return false;
  const engine=local.engine,runtime=podSpec(pod).containers?.find(c=>c.name === (engine === 'FreeToken' ? 'freetoken' : 'server'));
  if(!runtime) return false;
  const env=Object.fromEntries((runtime.env ?? []).map(e=>[e.name,e.value]));
  const nonce=(local.freetoken as {restartNonce?:string}|undefined)?.restartNonce;
  if(engine === 'FreeToken') return env.MAGICSTICK_FREETOKEN_CONTEXT_LENGTH === String(local.contextWindow) &&
    env.MAGICSTICK_FREETOKEN_MAX_RUNNING_REQUESTS === String(local.maxNumSeqs) &&
    (!nonce || pod.metadata.annotations?.['appliance.magicstick.dev/restart-nonce'] === nonce);
  if(env.MAGICSTICK_ENGINE !== engine || env.MAGICSTICK_COMPUTE_TARGET !== local.computeTarget ||
    Object.entries(local.env ?? {}).some(([name,value])=>env[name] !== value)) return false;
  if(engine === 'OLlama') return env.OLLAMA_CONTEXT_LENGTH === String(local.contextWindow) &&
    env.OLLAMA_NUM_PARALLEL === String(local.maxNumSeqs) && (!local.kvCacheType || env.OLLAMA_KV_CACHE_TYPE === local.kvCacheType);
  if(engine === 'VLLM') return runtime.args?.includes(`--max-model-len=${local.contextWindow}`) === true &&
    runtime.args.includes(`--max-num-seqs=${local.maxNumSeqs}`) && (!local.kvCacheType || runtime.args.includes(`--kv-cache-dtype=${local.kvCacheType}`));
  return false;
}

/** Playwright starts a new worker after a failed test, even with retries=0.
 * Never overwrite the previous worker's ownership or restore receipts. A new
 * worker gets a separate journal; a surviving Lease/resource still blocks it. */
export async function gpuWorkerJournal(root:string,workerIndex:number,targetUid:string) {
  requireSafe(Number.isSafeInteger(workerIndex) && workerIndex >= 0 && workerIndex <= 64,'CONFIG');
  const directory=workerIndex === 0 ? root : join(root,`worker-${workerIndex}`);
  await privateDirectory(directory);
  const journal=workerIndex === 0 ? await ResourceJournal.resume(join(directory,'journal.json'),targetUid) :
    await ResourceJournal.create(join(directory,'journal.json'),newRunId(),targetUid);
  return {directory,journal};
}

/** Read-only, independently observed backend evidence; Ready intent alone is
 * never sufficient. No exec/log permission is needed by the observer. */
export class GpuScenario {
  readonly config;
  readonly inference:InferenceProbe;
  readonly sharing:BorrowedSharing;
  readonly originalModels:Array<{name:string;uid:string;generation:number;spec:unknown}>;
  private constructor(readonly live:LiveFoundation,sharing:BorrowedSharing,inference:InferenceProbe,
    readonly allowed:ExactDashboardRequest[],readonly directory:string) {
    this.config = live.config; this.sharing = sharing; this.inference = inference;
    this.originalModels = live.snapshot.models.activations.map(item => ({name:item.metadata!.name!,uid:item.metadata!.uid!,
      generation:item.metadata!.generation!,spec:structuredClone(item.spec)}));
  }
  static async open(browser:Browser,workerIndex=0) {
    requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR,'CONFIG');
    const config = await loadLabConfig(process.env.REGRESSION_CONFIG); requireGpuProfile(config);
    const {directory,journal} = await gpuWorkerJournal(process.env.REGRESSION_RUN_DIR,workerIndex,config.expected.applianceUid);
    const allowed:ExactDashboardRequest[] = []; let live:LiveFoundation | undefined;
    live = await LiveFoundation.open(browser,config,journal,{inferenceOrigin:config.inferenceUrl,
      allowedDashboardRequests:()=>allowed,assertMutationAllowed:async () => {
      requireSafe(live,'LOCK_LOST'); await live.guard();
    }});
    try {
      // Like the CPU workflow, establish the real LiteLLM edge SSO session
      // before creating a key or borrowing settings. A dashboard session alone
      // is not proof of authenticated access to the separate inference route.
      await openInferenceSession(live.context,config.inferenceUrl!,config.loginTimeoutMs);
      const sharing = await BorrowedSharing.create(join(directory,'gpu-sharing.json'),{
        runId:journal.runId,targetUid:config.expected.applianceUid,nodeName:config.gpu!.nodeName,nodeUid:config.gpu!.nodeUid,
      },sharingAdapter(live),live.guard);
      const key = await live.createKey('gpu-key');
      const scenario = new GpuScenario(live,sharing,new InferenceProbe(live.context.request,config.inferenceUrl!,key.secret,120_000),allowed,directory);
      await scenario.inventory();
      const activeJobs = [...await live.observer.list('jobs','ai'),...await live.observer.list('jobs',config.expected.applianceNamespace)];
      requireSafe(!activeJobs.some(unfinishedJob),'BUSY');
      await writePrivate(join(directory,'gpu-baseline.json'),{version:1,runId:journal.runId,
        applianceUid:config.expected.applianceUid,nodeUid:config.gpu!.nodeUid,bootId:config.gpu!.bootId,models:scenario.originalModels},true);
      for (const provider of ['amd','nvidia'] as const) if(config.gpu!.devices[provider])await sharing.borrow(provider);
      return scenario;
    } catch (error) {await live.close(); throw error;}
  }
  static async recover(browser:Browser,journalPath:string) {
    requireSafe(process.env.REGRESSION_CONFIG,'CONFIG');const config=await loadLabConfig(process.env.REGRESSION_CONFIG);requireGpuProfile(config);
    const journal=await ResourceJournal.resume(journalPath,config.expected.applianceUid),directory=dirname(journalPath);
    const baseline=JSON.parse(await readPrivate(join(directory,'gpu-baseline.json'))) as {version:number;runId:string;applianceUid:string;
      nodeUid:string;bootId:string;models:Array<{name:string;uid:string;generation:number;spec:unknown}>};
    requireSafe(baseline.version === 1 && baseline.runId === journal.runId && baseline.applianceUid === config.expected.applianceUid &&
      baseline.nodeUid === config.gpu!.nodeUid && baseline.bootId === config.gpu!.bootId && Array.isArray(baseline.models) && baseline.models.length <= 64 &&
      baseline.models.every(m=>typeof m.name === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(m.name) && typeof m.uid === 'string' &&
        Number.isSafeInteger(m.generation) && m.generation > 0 && m.spec && typeof m.spec === 'object'),'OWNERSHIP');
    const live=await LiveFoundation.recover(browser,config,journal);
    try {
      const sharing=await BorrowedSharing.resume(join(directory,'gpu-sharing.json'),{runId:journal.runId,targetUid:config.expected.applianceUid,
        nodeName:config.gpu!.nodeName,nodeUid:config.gpu!.nodeUid},sharingAdapter(live),live.guard);
      // No inference credential is needed for recovery; it can only clean and
      // restore. The dummy key never leaves memory or performs a request.
      const result=new GpuScenario(live,sharing,new InferenceProbe(live.context.request,config.inferenceUrl!,'sk-recovery-unused'),[],directory);
      result.originalModels.splice(0,result.originalModels.length,...baseline.models);
      await result.inventory();return result;
    } catch(error) {await live.context.close();throw error;}
  }
  async inventory() {
    await this.live.guard();
    const [status,nodes] = await Promise.all([this.live.api.status(),this.live.observer.list('nodes')]);
    const gpu = this.config.gpu!,node = nodes.find(item=>item.metadata.uid === gpu.nodeUid);
    requireSafe(node?.metadata.name === gpu.nodeName && node.status?.nodeInfo?.bootID === gpu.bootId,'IDENTITY');
    const devices = Object.values(status.hardwareOperators ?? {}).flatMap(operator=>operator.devices ?? []);
    for (const provider of ['amd','nvidia'] as const) {
      const pinned = gpu.devices[provider];if(!pinned)continue;
      const matches = devices.filter(device=>device.id === pinned.id);
      requireSafe(matches.length === 1 && matches[0]!.vendor === provider && matches[0]!.pciAddress === pinned.pciAddress &&
        matches[0]!.nodeUid === gpu.nodeUid && matches[0]!.node === gpu.nodeName && matches[0]!.bootId === gpu.bootId,'IDENTITY');
    }
    return {status,node,devices};
  }
  async state(provider:Provider) {
    requireSafe(this.config.gpu?.devices[provider],'PREREQUISITE');
    const states = (await this.live.api.gpuSharing()).providers.filter(item=>item.provider === provider);
    requireSafe(states.length === 1 && states[0]!.nodeUid === this.config.gpu!.nodeUid,'IDENTITY'); return states[0]!;
  }
  async transition(provider:Provider,mode:GpuSharingState['mode'],count=2) {
    await this.inventory();
    for (let attempt=0;attempt<3;attempt++) {
      try {await this.sharing.change(provider,mode,count); break;}
      catch (error) {if (!(error instanceof SharingWriteRejected) || error.httpStatus !== 409 || attempt === 2) throw error;}
    }
    return this.waitBackend(provider,mode,count);
  }
  async waitBackend(provider:Provider,mode:GpuSharingState['mode'],count=2) {
    const state = await poll(async () => {
      await this.live.guard(); const current = await this.state(provider);
      const node = await this.live.observer.get('nodes',undefined,this.config.gpu!.nodeName);
      requireSafe(node.metadata.uid === this.config.gpu!.nodeUid && node.status?.nodeInfo?.bootID === this.config.gpu!.bootId,'IDENTITY');
      const expected = mode === 'exclusive' ? 1 : count;
      let backend = false;
      if (provider === 'nvidia') backend = Number(node.status?.allocatable?.['nvidia.com/gpu']) === expected &&
        node.metadata.labels?.['nvidia.com/device-plugin.config'] === (mode === 'exclusive' ? 'magicstick-exclusive' : `magicstick-shared-${count}`) &&
        Number(node.metadata.labels?.['nvidia.com/gpu.replicas'] ?? 1) === expected;
      else if (mode === 'exclusive') backend = Number(node.status?.allocatable?.['amd.com/gpu']) === 1;
      else {
        const [slices,claims] = await Promise.all([this.live.observer.list('resourceslices.resource.k8s.io'),
          this.live.observer.list('resourceclaims.resource.k8s.io','ai')]);
        const claim = claims.find(item=>item.metadata.name === current.claimName);
        backend = Boolean(current.device?.pciAddress === this.config.gpu!.devices.amd!.pciAddress && claim?.metadata.uid &&
          claim.metadata.annotations?.['appliance.magicstick.dev/node-uid'] === this.config.gpu!.nodeUid &&
          claim.metadata.annotations?.['appliance.magicstick.dev/gpu-identity'] && slices.some(slice => {
            const spec = slice.spec as {driver?:string;pool?:{name?:string};devices?:Array<{name:string;attributes?:Record<string,{string?:string}>}>};
            return spec?.driver === 'gpu.amd.com' && spec.pool?.name === this.config.gpu!.nodeName && spec.devices?.some(device =>
              device.name === current.device?.name && device.attributes?.['resource.kubernetes.io/pciBusID']?.string === this.config.gpu!.devices.amd!.pciAddress);
          }));
      }
      const models = await this.live.api.models();
      const target = models.computeTargets.targets.find(item=>item.id === `${provider}-gpu`);
      return {current,backend,slots:target?.slots};
    },value => value.current.phase === 'Ready' && value.current.mode === mode && value.current.maxModels === count &&
      value.backend && value.slots?.total === (mode === 'exclusive' ? 1 : count),
    {timeoutMs:600_000,intervalMs:1000,stage:'gpu-backend'});
    return state.current;
  }
  async create(label:string,fixture:RuntimeModelFixture,allowMemoryRisk=false) {
    await this.inventory(); fixtureIsAdvertised(await this.live.api.models(),fixture);
    const created = await this.live.createModel(label,this.live.journal,fixture,{allowMemoryRisk});
    return {...created,fixture};
  }
  async ready(model:GpuCreated) {
    let state:Awaited<ReturnType<LiveFoundation['modelState']>>;
    try {state = await poll(async()=>{
      const value=await this.live.modelState(model.client,model.uid);
      if(value.item?.metadata?.generation === model.generation && value.item.status?.observedGeneration === model.generation &&
        ['Degraded','Failed'].includes(value.item.status.phase ?? '')) throw new HarnessError('CAPABILITY','Failed','model-ready');
      return value;
    },value => value.item?.metadata?.generation === model.generation &&
      value.item.spec?.enabled === true && value.item.status?.phase === 'Ready' && value.item.status.observedGeneration === model.generation &&
      currentReady(value.observed ?? {},model.uid,model.generation) &&
      runtimePodConverged(value.pods,value.item) &&
      value.models.models?.some(item=>item.id === model.client.name) === true,
    {timeoutMs:model.fixture.engine === 'FreeToken' ? 2_700_000 : 900_000,intervalMs:1000,stage:'model-ready'});}
    catch(error) {await this.runtimeFailure(model,'model-ready',error);throw error;}
    const filename=join(this.directory,`runtime-${model.client.name}.json`);
    await writePrivate(filename,{version:1,runId:this.live.journal.runId,engine:model.fixture.engine,
      target:model.fixture.computeTarget,generation:model.generation,phase:state.item?.status?.phase,stage:'ready-observed'});
    try {await this.binding(model,state.pods);}
    catch(error) {
      await this.runtimeFailure(model,'gpu-binding',error);
      if(error instanceof HarnessError && error.code === 'CAPABILITY') throw new HarnessError('CAPABILITY','Failed','gpu-binding');throw error;
    }
    await writePrivate(filename,{version:1,runId:this.live.journal.runId,engine:model.fixture.engine,
      target:model.fixture.computeTarget,generation:model.generation,stage:'binding-observed'});
    try {await this.inference.chat(model.client.name,undefined,model.fixture.engine === 'FreeToken' ? 256 : 8,
      async result=>writePrivate(filename,{version:1,runId:this.live.journal.runId,engine:model.fixture.engine,
        target:model.fixture.computeTarget,generation:model.generation,stage:'inference-response',...result}));}
    catch(error) {
      // Bounded product logs stay private; no prompts, bodies or credentials are
      // serialized by the safe reporter. Capture before owned-resource teardown.
      await this.runtimeFailure(model,'model-inference',error,false);
      if(error instanceof HarnessError && error.code === 'API') throw new HarnessError('API','Failed','model-inference');throw error;
    }
    await writePrivate(filename,{version:1,runId:this.live.journal.runId,engine:model.fixture.engine,
      target:model.fixture.computeTarget,generation:model.generation,stage:'inference-passed'});
    return state;
  }
  private async runtimeFailure(model:GpuCreated,stage:'model-ready'|'gpu-binding'|'model-inference',error:unknown,recordStage=true) {
    if(recordStage) await writePrivate(join(this.directory,`runtime-${model.client.name}.json`),{
      version:1,runId:this.live.journal.runId,engine:model.fixture.engine,target:model.fixture.computeTarget,
      generation:model.generation,stage,reason:error instanceof HarnessError ? error.code : 'UNEXPECTED'});
    // Logs use the bounded authenticated product API, never Pod exec or broad
    // cluster log permission. Preserve them before failure-safe owned cleanup.
    try {await writePrivate(join(this.directory,`logs-${model.client.name}.json`),await model.client.logs());}catch{}
  }
  async binding(model:GpuCreated,pods:KubeObject[]) {
    const ready = pods.filter(pod=>!pod.metadata.deletionTimestamp && pod.status?.phase === 'Running' &&
      pod.status.conditions?.some(condition=>condition.type === 'Ready' && condition.status === 'True'));
    requireSafe(ready.length === 1,'CAPABILITY'); const pod = ready[0]!,spec = podSpec(pod);
    requireSafe(spec.nodeName === this.config.gpu!.nodeName && Array.isArray(spec.containers),'CAPABILITY');
    const gpu = model.fixture.computeTarget !== 'cpu';
    if (!gpu) {requireSafe(spec.containers.every(c=>!c.resources?.limits?.['amd.com/gpu'] && !c.resources?.limits?.['nvidia.com/gpu']) &&
      !spec.resourceClaims?.length,'CAPABILITY'); return;}
    const provider = model.fixture.computeTarget === 'amd-gpu' ? 'amd' : 'nvidia',sharing = await this.state(provider);
    const limits = spec.containers.map(container=>container.resources?.limits ?? {});
    requireSafe(limits.every(value=>!value[`${provider === 'amd' ? 'nvidia' : 'amd'}.com/gpu`]),'CAPABILITY');
    if (provider === 'amd' && sharing.mode === 'shared') {
      requireSafe(spec.resourceClaims?.some(claim=>claim.resourceClaimName === sharing.claimName) &&
        spec.containers.some(container=>container.resources?.claims?.some(claim=>claim.name === 'gpu')) &&
        limits.every(value=>!value['amd.com/gpu'] && !value['appliance.magicstick.dev/amd-dra']),'CAPABILITY');
      const claim = await this.live.observer.get('resourceclaims.resource.k8s.io','ai',sharing.claimName);
      const results = (claim.status?.allocation?.devices as {results?:Array<{driver:string;pool:string;device:string}>})?.results;
      requireSafe(results?.length === 1 && results[0]!.driver === 'gpu.amd.com' && results[0]!.pool === this.config.gpu!.nodeName &&
        results[0]!.device === sharing.device?.name,'CAPABILITY');
    } else requireSafe(limits.some(value=>Number(value[`${provider}.com/gpu`]) === 1) && !spec.resourceClaims?.length,'CAPABILITY');
    const item = activation(await model.client.models(),model.client.name);
    requireSafe(item?.metadata?.uid === model.uid && item.spec?.local?.computeTarget === model.fixture.computeTarget &&
      item.spec.local.engine === model.fixture.engine,'CAPABILITY');
    if (model.fixture.engine === 'FreeToken') {
      const owner = pod.metadata.ownerReferences?.find(ref=>ref.kind === 'ReplicaSet' && ref.controller);
      requireSafe(owner?.name && owner.uid,'OWNERSHIP');
      const rs = await this.live.observer.get('replicasets.apps','ai',owner.name);
      requireSafe(rs.metadata.uid === owner.uid,'OWNERSHIP');
      const deploymentOwner = rs.metadata.ownerReferences?.find(ref=>ref.kind === 'Deployment' && ref.controller);
      requireSafe(deploymentOwner?.name && deploymentOwner.uid,'OWNERSHIP');
      const deployment = await this.live.observer.get('deployments.apps','ai',deploymentOwner.name);
      requireSafe(deployment.metadata.uid === deploymentOwner.uid && deployment.metadata.name === `${model.client.name}-freetoken` &&
        deployment.metadata.labels?.['appliance.magicstick.dev/modelactivation'] === model.client.name &&
        deployment.metadata.labels?.['app.kubernetes.io/managed-by'] === 'magicstick-operator','OWNERSHIP');
      const runtime = spec.containers.find(container=>container.name === 'freetoken');
      requireSafe(sharing.mode === 'exclusive' && spec.runtimeClassName === 'nvidia' && runtime &&
        runtime.resources?.requests?.memory === `${(model.fixture as GpuModelFixture).freetoken!.systemMemoryMi}Mi` &&
        runtime.resources?.limits?.memory === runtime.resources?.requests?.memory && /@sha256:[a-f0-9]{64}$/.test(runtime.image),'CAPABILITY');
      const logs = await model.client.logs();
      const text = logs.pods.flatMap(p=>p.containers.flatMap(c=>c.logs.map(log=>log.text ?? ''))).join('\n');
      requireSafe(text.includes('[magicstick-freetoken] validated 1 whole NVIDIA GPU') && !text.includes('no CUDA-visible GPU was assigned'),'CAPABILITY');
    }
  }
  async lifecycle(model:GpuCreated,action:'start'|'stop'|'restart'|'edit') {
    await this.inventory(); const current = activation(await model.client.models(),model.client.name); requireSafe(current,'OWNERSHIP');
    const previous = model.generation;
    const after = action === 'edit' ? await model.client.editContext(current,Number(current.spec?.local?.contextWindow) === 1024 ? 2048 : 1024) :
      await model.client[action](current);
    await this.live.journal.modelGeneration(model.client.name,model.uid,previous,after.generation); model.generation = after.generation;
    if (action === 'stop') {
      await poll(() => this.live.modelState(model.client,model.uid),state => state.item?.spec?.enabled === false &&
        state.pods.length === 0 && !state.models.models?.some(item=>item.id === model.client.name),
      {timeoutMs:300_000,intervalMs:1000,stage:'model-stopped'});
      requireSafe(!(await this.inference.advertised(model.client.name)),'API'); await this.inference.refusesStopped(model.client.name);
    } else await this.ready(model);
  }
  async remove(model:GpuCreated) {
    await this.live.cleanup(this.live.journal,{kind:'model',name:model.client.name});
    requireSafe(!(await this.inference.advertised(model.client.name)),'CLEANUP');
  }
  async slots(target:'amd-gpu'|'nvidia-gpu',used:number,total:number) {
    return poll(() => this.live.api.models(),models => {
      const slots = models.computeTargets.targets.find(item=>item.id === target)?.slots;
      return slots?.total === total && slots.used === used && slots.free === total-used;
    },{timeoutMs:120_000,intervalMs:1000,stage:'gpu-slots'});
  }
  async openModels(page:Page) {await page.goto(this.config.dashboardUrl+'/#/models',{waitUntil:'domcontentloaded'});}
  async close() {
    // Delete only recorded models before restoring backends; leave their cache
    // alone. Restoration is forbidden after any ambiguous or foreign spec write.
    for (const entry of this.live.journal.entries.filter(entry=>entry.kind === 'model' && entry.state !== 'removed'))
      await this.live.cleanup(this.live.journal,{kind:'model',name:entry.name});
    await this.inventory();
    const jobs=[...await this.live.observer.list('jobs','ai'),...await this.live.observer.list('jobs',this.config.expected.applianceNamespace)];
    requireSafe(!jobs.some(unfinishedJob),'BUSY');
    await this.sharing.restore();
    for (const entry of this.sharing.entries) await this.waitBackend(entry.provider,entry.originalMode,entry.originalCount);
    const current = await this.live.api.models();
    for (const original of this.originalModels) {
      const item = activation(current,original.name);
      requireSafe(item?.metadata?.uid === original.uid && item.metadata.generation === original.generation &&
        canonical(item.spec) === canonical(original.spec),'CLEANUP');
    }
    await this.live.close();
  }
}

export function sharingAdapter(live:LiveFoundation):SharingAdapter {
  return {
    read:async provider => {
      for (let attempt=0;attempt<5;attempt++) {
        await live.guard();
        const states = await live.api.gpuSharing(),object = await live.observer.get('moduleactivations.appliance.magicstick.dev',
          live.config.expected.applianceNamespace,provider === 'amd' ? 'amd-gpu' : 'gpu');
        const state = states.providers.find(item=>item.provider === provider);
        requireSafe(state,'CAPABILITY');
        if (state.expectedRevision === object.metadata.resourceVersion) return {state,object};
      }
      throw new HarnessError('CONFLICT');
    },
    apply:async (request:GpuSharingRequest) => {
      requireSafe(live.config.gpu?.acknowledgeSharingTransitions && request.nodeName === live.config.gpu.nodeName &&
        request.nodeUid === live.config.gpu.nodeUid && request.acknowledgeRestart === true &&
        request.acknowledgeSharing === (request.mode === 'shared') && request.maxModels >= 2 && request.maxModels <= 16,'MUTATION');
      const transport:typeof fetch = async (input,init={}) => {
        const url = new URL(String(input));
        requireSafe(url.origin === live.config.dashboardUrl && url.pathname === '/api/hardware/gpu-sharing' && !url.search && !url.hash &&
          init.method === 'POST' && canonical(JSON.parse(String(init.body))) === canonical(request),'MUTATION');
        await live.guard();
        const response = await live.context.request.fetch(url.href,{method:'POST',headers:{Origin:live.config.dashboardUrl,
          'Content-Type':'application/json','X-MagicStick-CSRF':'dashboard'},data:String(init.body),timeout:live.config.requestTimeoutMs,
        maxRedirects:0,failOnStatusCode:false});
        if ([400,401,403,404,409,422].includes(response.status()) &&
          (response.headers()['content-type'] ?? '').includes('application/json')) throw new SharingWriteRejected(response.status());
        requireSafe(response.status() === 202 && (response.headers()['content-type'] ?? '').includes('application/json'),'API');
        return new Response(await response.text(),{status:202,headers:{'Content-Type':'application/json'}});
      };
      const result = await new MagicStickApi({baseUrl:live.config.dashboardUrl,fetch:transport}).configureGpuSharing(request);
      requireSafe(result.accepted === true && result.mode === request.mode,'API');
    },
  };
}

export function physicalDevice(devices:HardwareGpuDevice[],provider:Provider) {return devices.find(device=>device.vendor === provider)!;}
export function providerModels(models:ModelsPayload,provider:Provider) {return models.activations.filter(item=>item.spec?.enabled &&
  item.spec.local?.computeTarget === `${provider}-gpu`);}
