import {expect,type Page} from '@playwright/test';
import type {GpuValidationRequest,GpuSharingState,HardwareGpuDevice} from '@magicstick/dashboard-contracts';
import {GpuScenario,podSpec} from '../core/gpu-scenario.ts';
import type {KubeObject} from '../core/observer.ts';
import {writePrivate} from '../core/private-files.ts';
import {HarnessError,requireSafe,atStage} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {join} from 'node:path';
import {requireGpuProvider} from './prerequisites.ts';
import {canonical} from '../core/borrowed-sharing.ts';

export async function validationJobs(s:GpuScenario) {
  return [...await s.live.observer.list('jobs','ai'),...await s.live.observer.list('jobs',s.config.expected.applianceNamespace)];
}

type ValidationBindingCheck='engine-node'|'legacy-resource'|'pod-claim'|'claim-allocation'|'slice-uuid'|'runtime-image';
class ValidationBindingError extends HarnessError {
  readonly check:ValidationBindingCheck;
  constructor(check:ValidationBindingCheck) {super('CAPABILITY','Failed','gpu-binding');this.check=check;}
}
function bindingProof(condition:unknown,check:ValidationBindingCheck):asserts condition {
  if(!condition)throw new ValidationBindingError(check);
}

/** ResourceClaim is a native resource with immutable spec. Unlike our CRDs,
 * Kubernetes does not maintain its metadata.generation. Require an observed
 * UID/resourceVersion and preserve the exact spec plus any supplied generation;
 * status changes may legitimately advance resourceVersion during deallocation. */
function identifiedValidationClaim(claim:KubeObject) {
  const {uid,resourceVersion,generation,deletionTimestamp}=claim.metadata;
  return Boolean(typeof uid==='string'&&uid.length>0&&typeof resourceVersion==='string'&&resourceVersion.length>0&&
    claim.spec&&!deletionTimestamp&&(generation===undefined||Number.isSafeInteger(generation)&&generation>=0));
}

/** References are already checkable before the scheduler's allocation becomes
 * visible. This is not allocation or physical-device acceptance. */
function nvidiaValidationClaimReference(pod:KubeObject,device:HardwareGpuDevice,sharing:GpuSharingState,claim?:KubeObject) {
  const spec=podSpec(pod) as ReturnType<typeof podSpec>&{initContainers?:Array<{name:string;resources?:{
    limits?:Record<string,string>;claims?:Array<{name:string}>}}>};
  const engine=spec.initContainers?.find(c=>c.name==='engine');
  bindingProof(engine && (!spec.nodeName||spec.nodeName===device.node),'engine-node');
  const card=sharing.devices?.find(d=>d.nodeUid===device.nodeUid&&d.node===device.node&&d.pciAddress===device.pciAddress);
  bindingProof(card&&spec.resourceClaims?.length===1&&spec.resourceClaims[0]?.resourceClaimName===card.claimName&&
    engine.resources?.claims?.length===1&&engine.resources.claims[0]?.name===spec.resourceClaims[0].name&&
    !engine.resources.limits?.['nvidia.com/gpu']&&claim?.metadata.name===card.claimName&&claim.metadata.namespace==='ai','pod-claim');
  return card;
}

/** A DRA validation must consume the exact inventoried physical card, not a
 * node-wide extended-resource token. Check both the Pod reference and the
 * independently observed allocation; sharing does not relax UUID identity. */
export function nvidiaValidationBinding(pod:KubeObject,device:HardwareGpuDevice,sharing:GpuSharingState,
  claim?:KubeObject,slices:KubeObject[]=[],physicalCount=1) {
  const spec=podSpec(pod) as ReturnType<typeof podSpec>&{initContainers?:Array<{name:string;resources?:{
    limits?:Record<string,string>;claims?:Array<{name:string}>}}>};
  const engine=spec.initContainers?.find(c=>c.name==='engine');
  bindingProof(engine && (!spec.nodeName||spec.nodeName===device.node),'engine-node');
  if(sharing.backend!=='dra') {
    bindingProof(physicalCount===1 && Number(engine.resources?.limits?.['nvidia.com/gpu'])===1&&!spec.resourceClaims?.length,'legacy-resource');return;
  }
  const card=nvidiaValidationClaimReference(pod,device,sharing,claim);
  const results=(claim?.status?.allocation?.devices as {results?:Array<{driver:string;pool:string;device:string}>})?.results;
  bindingProof(results?.length===1&&results[0]!.driver==='gpu.nvidia.com'&&results[0]!.pool===card.pool&&results[0]!.device===card.name,'claim-allocation');
  const pool=slices.map(slice=>slice.spec as {driver?:string;nodeName?:string;
    pool?:{name?:string;generation?:number;resourceSliceCount?:number};
    devices?:Array<{name:string;attributes?:Record<string,{string?:string}>}>})
    .filter(value=>value?.driver==='gpu.nvidia.com'&&value.nodeName===card.node&&value.pool?.name===card.pool);
  bindingProof(pool.length>0&&pool.every(value=>Number.isSafeInteger(value.pool?.generation)&&value.pool!.generation!>=0),'slice-uuid');
  // Kubernetes identifies a device by driver/pool/name. Old generations and
  // another pool's same-named device cannot establish or disprove this claim.
  const generation=Math.max(...pool.map(value=>value.pool!.generation!));
  const current=pool.filter(value=>value.pool!.generation===generation);
  bindingProof(current.every(value=>value.pool!.resourceSliceCount===current.length),'slice-uuid');
  const matches=current.flatMap(value=>(value.devices??[]).filter(device=>device.name===card.name));
  bindingProof(matches.length===1&&matches[0]?.attributes?.uuid?.string===card.uuid,'slice-uuid');
}

function validationDevices(s:GpuScenario,devices:HardwareGpuDevice[],scope:'all'|'nvidia') {
  const gpu=s.config.gpu!;
  if(scope==='nvidia')requireGpuProvider(s.config,'nvidia');
  const selected=devices.filter(device=>device.nodeUid===gpu.nodeUid && (scope==='all' || device.id===gpu.devices.nvidia?.id));
  requireSafe(selected.length>0 && selected.every(device=>device.node===gpu.nodeName && device.bootId===gpu.bootId),'IDENTITY');
  return selected;
}

/** Borrow the real allocator through the existing UID/revision-bound sharing
 * journal. Legacy extended resources cannot select one of several same-node
 * cards; never wait on a deliberately disabled Verify button or accept an
 * arbitrary NVIDIA allocation as proof of exact-card verification. */
export async function prepareValidation(s:GpuScenario,engine:'OLlama'|'VLLM',scope:'all'|'nvidia') {
  return atStage('gpu-validation',async()=>{
    let inventory=await s.inventory(),selected=validationDevices(s,inventory.devices,scope),changed=false;
    if(selected.some(device=>!['amd','nvidia'].includes(device.vendor) || device.eligible===false || device.hostDriverReady===false))
      throw new HarnessError('GPU_VALIDATION','Blocked','gpu-validation');
    if(selected.some(device=>device.vendor==='nvidia')) {
      const count=inventory.devices.filter(device=>device.vendor==='nvidia' && device.nodeUid===s.config.gpu!.nodeUid).length;
      const state=await s.state('nvidia');
      if(count>1 && state.backend!=='dra') {
        if(!state.draAvailable)throw new HarnessError('GPU_VALIDATION','Blocked','gpu-validation');
        await s.transition('nvidia',state.mode,state.maxModels,'dra');changed=true;
      }
    }
    if(changed) {
      inventory=await poll(()=>s.inventory(),value=>validationDevices(s,value.devices,scope).every(device=>device.validationAvailable===true),
        {timeoutMs:60_000,intervalMs:1000,stage:'gpu-validation'});
      selected=validationDevices(s,inventory.devices,scope);
    }
    if(selected.some(device=>device.validationAvailable!==true))throw new HarnessError('GPU_VALIDATION','Blocked','gpu-validation');
    if(selected.some(device=>['queued','running'].includes(device.validation?.[engine]?.state ?? '')))
      throw new HarnessError('BUSY','Blocked','gpu-validation');
    return selected;
  });
}
/** Deterministic *request identity only*: the browser still uses the real
 * confirmation, authenticated API, controller and GPU diagnostic. No result,
 * hardware fact, token, routing or health response is mocked. */
export async function requestValidationUi(s:GpuScenario,page:Page,engine:'OLlama'|'VLLM',scope:'all'|'nvidia',index:number) {
  const devices=await prepareValidation(s,engine,scope);
  const now=Date.now()+index,uuid=s.live.journal.runId.slice(4),requestId=`dashboard-${now}-${uuid}`;
  const deviceIds=devices.map(device=>device.id);
  const body:GpuValidationRequest={nodeName:s.config.gpu!.nodeName,nodeUid:s.config.gpu!.nodeUid,engine,deviceIds,requestId,acknowledgeResourceUse:true};
  const filename=join(s.directory,`verification-${index}.json`);
  await writePrivate(filename,{version:1,runId:s.live.journal.runId,request:body,requestedAt:new Date(now-index).toISOString()},true);
  await page.clock.setFixedTime(now);
  await page.evaluate(id=>Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>id}),uuid);
  await page.goto(s.config.dashboardUrl+'/#/system/hardware');
  // Navigation reloads the document. Reapply the test-owned identifier before
  // clicking; all selected PCI identities still come from real live inventory.
  await page.evaluate(id=>Object.defineProperty(window.crypto,'randomUUID',{configurable:true,value:()=>id}),uuid);
  const region=page.getByRole('region',{name:`Engine validation on ${s.config.gpu!.nodeName}`});
  await region.getByLabel('GPUs to verify').selectOption(scope === 'all' ? 'all' : deviceIds[0]!);
  const verify=region.getByRole('button',{name:engine === 'OLlama' ? 'Verify Ollama' : 'Verify vLLM'});
  await expect(verify).toBeEnabled({timeout:15_000});await verify.click({timeout:15_000});
  const dialog=page.getByRole('dialog'); await expect(dialog).toContainText(/GPU|verification/);
  s.allowed.splice(0,s.allowed.length,{method:'POST',path:'/api/hardware/validation',body});
  const response=page.waitForResponse(r=>new URL(r.url()).pathname === '/api/hardware/validation' && r.request().method() === 'POST');
  await s.live.guard(); await dialog.getByRole('button',{name:'Run verification'}).click();
  const http=await response;requireSafe(http.status() === 202,'API');
  const result=await http.json() as {accepted?:boolean;requestId?:string;deviceIds?:string[]};
  requireSafe(result.accepted && result.requestId === requestId && result.deviceIds?.length === deviceIds.length &&
    result.deviceIds.every(id=>deviceIds.includes(id)),'API');s.allowed.length=0;
  return {requestId,deviceIds,engine,startedAt:now-index};
}

export async function completedValidation(s:GpuScenario,request:Awaited<ReturnType<typeof requestValidationUi>>) {
  const captured=new Map<string,KubeObject>();
  const bindings=new Map<string,{deviceId:string;podUid:string;imageId:string}>();
  const allocatedClaims=new Map<string,KubeObject>();
  const pendingAllocations=new Map<string,{since:number;claim:KubeObject}>();
  let lastAllocation:{podPhase?:string;engineStarted:boolean;claimAllocationPresent:boolean;previousAllocationObserved:boolean;
    allocationResultCount:number|null;allocationMatchesRequestedCard:boolean;claimUidPresent:boolean;
    claimResourceVersionPresent:boolean;claimGeneration:number|null;claimSpecPresent:boolean}|undefined;
  const result=await poll(async ()=>{
    await s.live.guard();const jobs=await validationJobs(s);
    for (const job of jobs.filter(j=>j.metadata.annotations?.['appliance.magicstick.dev/validation-request'] === request.requestId)) {
      requireSafe(job.metadata.uid && request.deviceIds.includes(job.metadata.annotations!['appliance.magicstick.dev/validation-device']!) &&
        job.metadata.annotations!['appliance.magicstick.dev/validation-engine'] === request.engine,'OWNERSHIP');captured.set(job.metadata.uid,job);
      if(job.status?.conditions?.some(condition=>condition.type==='Failed' && condition.status==='True'))
        throw new HarnessError('CAPABILITY','Failed','gpu-validation');
    }
    const inventory=await s.inventory();
    const pods=[...await s.live.observer.list('pods','ai'),...await s.live.observer.list('pods',s.config.expected.applianceNamespace)];
    for (const job of captured.values()) {
      const deviceId=job.metadata.annotations!['appliance.magicstick.dev/validation-device'],device=inventory.devices.find(d=>d.id === deviceId)!;
      requireSafe(device && device.nodeUid===s.config.gpu!.nodeUid && device.bootId===s.config.gpu!.bootId,'IDENTITY');
      for (let pod of pods.filter(p=>p.metadata.ownerReferences?.some(o=>o.kind === 'Job' && o.uid === job.metadata.uid))) {
        const spec=podSpec(pod) as ReturnType<typeof podSpec>&{initContainers?:Array<{name:string;image:string;resources?:{limits?:Record<string,string>;claims?:Array<{name:string}>}}>};
        if (spec.nodeName) bindingProof(spec.nodeName === s.config.gpu!.nodeName,'engine-node');
        const engine=spec.initContainers?.find(c=>c.name === 'engine');bindingProof(engine,'engine-node');
        if (device.vendor === 'nvidia') {
          const sharing=await s.state('nvidia'),card=sharing.devices?.find(d=>d.nodeUid===device.nodeUid&&d.pciAddress===device.pciAddress);
          // Allocation is asynchronous. Before scheduling, check at the next
          // observation instead of failing a legitimately pending DRA claim.
          if(sharing.backend==='dra'&&!spec.nodeName)continue;
          const claim=sharing.backend==='dra'&&card?
            await s.live.observer.get('resourceclaims.resource.k8s.io','ai',card.claimName):undefined;
          const engineStatus=pod.status?.initContainerStatuses?.find(c=>c.name==='engine');
          const engineStarted=Boolean(engineStatus?.containerID||engineStatus?.state?.running||engineStatus?.state?.terminated||
            engineStatus?.lastState?.terminated||(engineStatus?.restartCount??0)>0);
          const allocationResults=(claim?.status?.allocation?.devices as {results?:Array<{driver:string;pool:string;device:string}>}|undefined)?.results;
          lastAllocation={podPhase:['Pending','Running','Succeeded','Failed','Unknown'].includes(pod.status?.phase??'')?pod.status!.phase:undefined,
            engineStarted,claimAllocationPresent:claim?.status?.allocation!==undefined,previousAllocationObserved:allocatedClaims.has(pod.metadata.uid??''),
            allocationResultCount:Array.isArray(allocationResults)?allocationResults.length:null,
            allocationMatchesRequestedCard:allocationResults?.length===1&&allocationResults[0]?.driver==='gpu.nvidia.com'&&
              allocationResults[0]?.pool===card?.pool&&allocationResults[0]?.device===card?.name,
            claimUidPresent:Boolean(claim?.metadata.uid),claimResourceVersionPresent:Boolean(claim?.metadata.resourceVersion),
            claimGeneration:Number.isSafeInteger(claim?.metadata.generation)?claim!.metadata.generation!:null,
            claimSpecPresent:Boolean(claim?.spec)};
          const pending=pendingAllocations.get(pod.metadata.uid??'');
          if(pending)bindingProof(claim?.metadata.uid===pending.claim.metadata.uid&&claim?.metadata.generation===pending.claim.metadata.generation&&
            canonical(claim?.spec)===canonical(pending.claim.spec)&&!claim?.metadata.deletionTimestamp,'claim-allocation');
          if(sharing.backend==='dra'&&claim&&claim.status?.allocation===undefined&&pod.status?.phase==='Pending'&&
            !engineStarted&&!allocatedClaims.has(pod.metadata.uid??'')) {
            nvidiaValidationClaimReference(pod,device,sharing,claim);
            bindingProof(pod.metadata.uid&&identifiedValidationClaim(claim)&&!pod.metadata.deletionTimestamp,'claim-allocation');
            const since=pending?.since??Date.now();
            if(!pending)pendingAllocations.set(pod.metadata.uid,{since,claim:structuredClone(claim)});
            // A scheduled but not started Pod is not proof of a bad device.
            // Wait only for this bounded allocation window; no binding is
            // credited and an already running/deallocated engine still fails.
            bindingProof(Date.now()-since<60_000,'claim-allocation');
            continue;
          }
          if(pod.metadata.uid&&claim?.status?.allocation!==undefined)pendingAllocations.delete(pod.metadata.uid);
          let proof=claim;
          if(sharing.backend==='dra'&&claim&&claim.status?.allocation===undefined&&
            allocatedClaims.has(pod.metadata.uid??'')&&pod.status?.phase!=='Succeeded') {
            // The Pod list and Claim GET are not an atomic snapshot. Confirm
            // the same Pod completed if deallocation raced these two reads.
            bindingProof(pod.metadata.name&&pod.metadata.namespace==='ai','claim-allocation');
            const current=await s.live.observer.get('pods','ai',pod.metadata.name);
            bindingProof(current.metadata.uid===pod.metadata.uid&&current.status?.phase==='Succeeded'&&
              canonical(current.spec)===canonical(pod.spec),'claim-allocation');
            pod=current;
          }
          if(sharing.backend==='dra'&&claim&&claim.status?.allocation===undefined&&pod.status?.phase==='Succeeded') {
            // Kubernetes v1.36 clears allocation/reservedFor as soon as the
            // last consumer completes, before deleting its successful Pod.
            // Reuse only an allocation actually verified for this exact Pod,
            // on the same undeleted Claim UID and unchanged intent generation.
            // Completion alone, a same-named replacement or an unseen claim
            // cannot invent the earlier physical-device proof.
            const previous=allocatedClaims.get(pod.metadata.uid??'');
            const reserved=(claim.status as {reservedFor?:unknown}|undefined)?.reservedFor;
            bindingProof(previous&&identifiedValidationClaim(claim)&&claim.metadata.uid===previous.metadata.uid&&
              claim.metadata.generation===previous.metadata.generation&&!claim.metadata.deletionTimestamp&&
              !pod.metadata.deletionTimestamp&&canonical(claim.spec)===canonical(previous.spec)&&
              (reserved===undefined||Array.isArray(reserved)&&reserved.length===0),'claim-allocation');
            proof=previous;
          }
          nvidiaValidationBinding(pod,device,sharing,proof,
            sharing.backend==='dra'?await s.live.observer.list('resourceslices.resource.k8s.io'):[],
            inventory.devices.filter(candidate=>candidate.vendor==='nvidia' && candidate.nodeUid===device.nodeUid).length);
          if(sharing.backend==='dra'&&pod.status?.phase!=='Succeeded') {
            bindingProof(pod.metadata.uid&&claim&&identifiedValidationClaim(claim)&&!pod.metadata.deletionTimestamp,'claim-allocation');
            const previous=allocatedClaims.get(pod.metadata.uid);
            bindingProof(!previous||claim.metadata.uid===previous.metadata.uid&&
              claim.metadata.generation===previous.metadata.generation&&canonical(claim.spec)===canonical(previous.spec),'claim-allocation');
            if(!previous)allocatedClaims.set(pod.metadata.uid,structuredClone(claim));
          }
        }
        else {
          const sharing=await s.state('amd');
          bindingProof(sharing.mode === 'shared' ? spec.resourceClaims?.some(c=>c.resourceClaimName === sharing.claimName) &&
            engine.resources?.claims?.some(c=>c.name === 'gpu') : Number(engine.resources?.limits?.['amd.com/gpu']) === 1,'pod-claim');
        }
        const imageId=pod.status?.initContainerStatuses?.find(c=>c.name === 'engine')?.imageID;
        if (pod.status?.phase === 'Succeeded') {
          bindingProof(pod.metadata.uid && imageId && /sha256:[a-f0-9]{64}$/.test(imageId),'runtime-image');
          bindings.set(job.metadata.uid!,{deviceId:deviceId!,podUid:pod.metadata.uid,imageId});
        }
      }
    }
    return {inventory,captured};
  },value=>request.deviceIds.every(id=>{
    const result=value.inventory.devices.find(d=>d.id === id)?.validation?.[request.engine];
    return result?.state === 'passed' && Date.parse(result.validatedAt ?? '') >= request.startedAt &&
      /sha256:[a-f0-9]{64}$/.test(result.imageId ?? '') && [...value.captured.values()].some(j=>
        j.metadata.annotations?.['appliance.magicstick.dev/validation-device'] === id && bindings.get(j.metadata.uid!)?.deviceId === id &&
        bindings.get(j.metadata.uid!)?.imageId === result.imageId &&
        j.status?.conditions?.some(c=>c.type === 'Complete' && c.status === 'True'));
  }),{timeoutMs:2_700_000,intervalMs:1000,stage:'gpu-validation'}).catch(async(error:unknown)=>{
    if(error instanceof ValidationBindingError) {
      // Fixed detail codes only: no selectors, requests, Secrets or runtime
      // output. Preserve the original failed proof if diagnostic storage fails.
      await writePrivate(join(s.directory,'verification-binding-failure.json'),{
        version:1,runId:s.live.journal.runId,requestId:request.requestId,engine:request.engine,check:error.check,
        ...(error.check==='claim-allocation'&&lastAllocation?{allocationObservation:lastAllocation}:{}),
      }).catch(()=>{});
    }
    throw error;
  });
  await writePrivate(join(s.directory,`verification-${request.requestId}-result.json`),{
    version:1,runId:s.live.journal.runId,engine:request.engine,
    bindings:[...bindings].map(([jobUid,proof])=>({jobUid,...proof})),completed:true});
  return result;
}
