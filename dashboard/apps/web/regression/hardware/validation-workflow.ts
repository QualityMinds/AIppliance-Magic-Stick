import {expect,type Page} from '@playwright/test';
import type {GpuValidationRequest,GpuSharingState,HardwareGpuDevice} from '@magicstick/dashboard-contracts';
import {GpuScenario,podSpec} from '../core/gpu-scenario.ts';
import type {KubeObject} from '../core/observer.ts';
import {writePrivate} from '../core/private-files.ts';
import {requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {join} from 'node:path';

export async function validationJobs(s:GpuScenario) {
  return [...await s.live.observer.list('jobs','ai'),...await s.live.observer.list('jobs',s.config.expected.applianceNamespace)];
}

/** A DRA validation must consume the exact inventoried physical card, not a
 * node-wide extended-resource token. Check both the Pod reference and the
 * independently observed allocation; sharing does not relax UUID identity. */
export function nvidiaValidationBinding(pod:KubeObject,device:HardwareGpuDevice,sharing:GpuSharingState,
  claim?:KubeObject,slices:KubeObject[]=[]) {
  const spec=podSpec(pod) as ReturnType<typeof podSpec>&{initContainers?:Array<{name:string;resources?:{
    limits?:Record<string,string>;claims?:Array<{name:string}>}}>};
  const engine=spec.initContainers?.find(c=>c.name==='engine');
  requireSafe(engine && (!spec.nodeName||spec.nodeName===device.node),'CAPABILITY');
  if(sharing.backend!=='dra') {
    requireSafe(Number(engine.resources?.limits?.['nvidia.com/gpu'])===1&&!spec.resourceClaims?.length,'CAPABILITY');return;
  }
  const card=sharing.devices?.find(d=>d.nodeUid===device.nodeUid&&d.node===device.node&&d.pciAddress===device.pciAddress);
  requireSafe(card&&spec.resourceClaims?.length===1&&spec.resourceClaims[0]?.resourceClaimName===card.claimName&&
    engine.resources?.claims?.length===1&&engine.resources.claims[0]?.name===spec.resourceClaims[0].name&&
    !engine.resources.limits?.['nvidia.com/gpu']&&claim?.metadata.name===card.claimName&&claim.metadata.namespace==='ai','CAPABILITY');
  const results=(claim.status?.allocation?.devices as {results?:Array<{driver:string;pool:string;device:string}>})?.results;
  requireSafe(results?.length===1&&results[0]!.driver==='gpu.nvidia.com'&&results[0]!.pool===card.pool&&results[0]!.device===card.name,'CAPABILITY');
  const matches=slices.flatMap(slice=>{
    const value=slice.spec as {driver?:string;nodeName?:string;devices?:Array<{name:string;attributes?:Record<string,{string?:string}>}>};
    return value.driver==='gpu.nvidia.com'&&value.nodeName===card.node ? (value.devices??[]).filter(d=>d.name===card.name) : [];
  });
  requireSafe(matches.length===1&&matches[0]?.attributes?.uuid?.string===card.uuid,'CAPABILITY');
}
/** Deterministic *request identity only*: the browser still uses the real
 * confirmation, authenticated API, controller and GPU diagnostic. No result,
 * hardware fact, token, routing or health response is mocked. */
export async function requestValidationUi(s:GpuScenario,page:Page,engine:'OLlama'|'VLLM',scope:'all'|'nvidia',index:number) {
  const now=Date.now()+index,uuid=s.live.journal.runId.slice(4),requestId=`dashboard-${now}-${uuid}`;
  const devices=(await s.inventory()).devices.filter(d=>d.nodeUid === s.config.gpu!.nodeUid);
  requireSafe(scope === 'all' || s.config.gpu!.devices.nvidia,'PREREQUISITE');
  const deviceIds=scope === 'all' ? devices.map(d=>d.id) : [s.config.gpu!.devices.nvidia!.id];
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
  await region.getByRole('button',{name:engine === 'OLlama' ? 'Verify Ollama' : 'Verify vLLM'}).click();
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
  const result=await poll(async ()=>{
    await s.live.guard();const jobs=await validationJobs(s);
    for (const job of jobs.filter(j=>j.metadata.annotations?.['appliance.magicstick.dev/validation-request'] === request.requestId)) {
      requireSafe(job.metadata.uid && request.deviceIds.includes(job.metadata.annotations!['appliance.magicstick.dev/validation-device']!) &&
        job.metadata.annotations!['appliance.magicstick.dev/validation-engine'] === request.engine,'OWNERSHIP');captured.set(job.metadata.uid,job);
    }
    const inventory=await s.inventory();
    const pods=[...await s.live.observer.list('pods','ai'),...await s.live.observer.list('pods',s.config.expected.applianceNamespace)];
    for (const job of captured.values()) {
      const deviceId=job.metadata.annotations!['appliance.magicstick.dev/validation-device'],device=inventory.devices.find(d=>d.id === deviceId)!;
      for (const pod of pods.filter(p=>p.metadata.ownerReferences?.some(o=>o.kind === 'Job' && o.uid === job.metadata.uid))) {
        const spec=podSpec(pod) as ReturnType<typeof podSpec>&{initContainers?:Array<{name:string;image:string;resources?:{limits?:Record<string,string>;claims?:Array<{name:string}>}}>};
        if (spec.nodeName) requireSafe(spec.nodeName === s.config.gpu!.nodeName,'CAPABILITY');
        const engine=spec.initContainers?.find(c=>c.name === 'engine');requireSafe(engine,'CAPABILITY');
        if (device.vendor === 'nvidia') {
          const sharing=await s.state('nvidia'),card=sharing.devices?.find(d=>d.nodeUid===device.nodeUid&&d.pciAddress===device.pciAddress);
          // Allocation is asynchronous. Before scheduling, check at the next
          // observation instead of failing a legitimately pending DRA claim.
          if(sharing.backend==='dra'&&!spec.nodeName)continue;
          nvidiaValidationBinding(pod,device,sharing,sharing.backend==='dra'&&card?
            await s.live.observer.get('resourceclaims.resource.k8s.io','ai',card.claimName):undefined,
            sharing.backend==='dra'?await s.live.observer.list('resourceslices.resource.k8s.io'):[]);
        }
        else {
          const sharing=await s.state('amd');
          requireSafe(sharing.mode === 'shared' ? spec.resourceClaims?.some(c=>c.resourceClaimName === sharing.claimName) &&
            engine.resources?.claims?.some(c=>c.name === 'gpu') : Number(engine.resources?.limits?.['amd.com/gpu']) === 1,'CAPABILITY');
        }
        const imageId=pod.status?.initContainerStatuses?.find(c=>c.name === 'engine')?.imageID;
        if (pod.status?.phase === 'Succeeded') {
          requireSafe(pod.metadata.uid && imageId && /sha256:[a-f0-9]{64}$/.test(imageId),'CAPABILITY');
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
  }),{timeoutMs:2_700_000,intervalMs:1000,stage:'gpu-validation'});
  await writePrivate(join(s.directory,`verification-${request.requestId}-result.json`),{
    version:1,runId:s.live.journal.runId,engine:request.engine,
    bindings:[...bindings].map(([jobUid,proof])=>({jobUid,...proof})),completed:true});
  return result;
}
