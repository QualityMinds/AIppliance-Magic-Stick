import {createHash,randomBytes} from 'node:crypto';
import {join} from 'node:path';
import type {HostOperationRequest,ManagedHost,NetworkSettings} from '@magicstick/dashboard-contracts';
import {expect} from '@playwright/test';
import type {LiveFoundation} from './live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from './administration-api.ts';
import {HarnessError,requireProof as requireSafe} from './errors.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {poll} from './poll.ts';
import {InferenceProbe} from './inference.ts';
import {openInferenceSession} from './auth.ts';
import {canonical} from './borrowed-sharing.ts';
import {podSpec} from './gpu-scenario.ts';
import {selectRange} from '../administration/form-checks.ts';
import {materializeHostDrill} from './host-drill-recipes.ts';
import {automaticHostRecipes} from './automatic-fixtures.ts';

const actions:Record<string,string[]>={
  'HOST-04':['prepare-gpu'],'HOST-05':['prepare-gpu'],
  'GPUHOST-05':['configure-gpu-memory'],'GPUHOST-06':['configure-gpu-memory'],'GPUHOST-07':['configure-gpu-memory'],
  'NET-05':['configure-network'],'NET-06':['configure-network'],'NET-07':['configure-network'],
  'UPD-05':['install-updates'],'UPD-07':['configure-updates'],
  'CHANNEL-06':['apply-software-channel'],'CHANNEL-07':['apply-software-channel'],'CHANNEL-08':['apply-software-channel'],
  'CACHE-04':['clear-model-cache'],'CACHE-06':['clear-model-cache'],'BOOT-02':['reboot'],'BOOT-03':['reboot'],'BOOT-04':['reboot'],
};
export interface HostDrill {
  caseId:string; acknowledgeDisruption:true; independentRecoveryAvailable:true;
  /** A reviewed immutable plan from this boot, not a shell command. */
  request:HostOperationRequest;
  expected:{bootChanges:0|1|2;kernel:string;dynamicLimitMi?:number;carveoutMi?:number;ipv4?:string[];
    sourceCommit?:string;freeCacheIds?:string[];terminal:'Succeeded'|'Failed'|'Interrupted'|'RolledBack';
    images?:Array<{namespace:string;deployment:string;container:string;digest:string}>};
}
/** Physical drills are intentionally separate from ordinary suite selection.
 * The private file is data only; arbitrary commands/paths/URLs are rejected. */
export function parseHostDrill(value:unknown,id:string,host:ManagedHost):HostDrill {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value),'CONFIG');
  const fixture=value as HostDrill,request=fixture.request;
  requireSafe(Object.keys(fixture).sort().join(',') === 'acknowledgeDisruption,caseId,expected,independentRecoveryAvailable,request' &&
    fixture.caseId === id && fixture.acknowledgeDisruption === true && fixture.independentRecoveryAvailable === true &&
    request && typeof request === 'object' && actions[id]?.includes(request.action) &&
    request.nodeName === host.name && request.confirmation === host.name && request.nodeUid === host.nodeUid && request.bootId === host.bootId &&
    request.acknowledgeDisruption === true && host.available === true,'PREREQUISITE');
  const allowed=new Set(['action','nodeName','nodeUid','bootId','requestId','confirmation','acknowledgeDisruption','allowExperimental','experimentMode',
    'planId','gpuMemory','network','updatePolicy','updateScope','softwareChannel','softwarePreviewId']);
  requireSafe(Object.keys(request).every(key=>allowed.has(key)) && JSON.stringify(request).length < 8192 &&
    !/"(?:command|path|packages|repository|script|mirror|password)"\s*:/.test(JSON.stringify(request)),'MUTATION');
  requireSafe(fixture.expected && ['Succeeded','Failed','Interrupted','RolledBack'].includes(fixture.expected.terminal) &&
    [0,1,2].includes(fixture.expected.bootChanges) && typeof fixture.expected.kernel === 'string' && fixture.expected.kernel.length < 128,'CONFIG');
  requireSafe(Object.keys(fixture.expected).every(key=>['bootChanges','kernel','dynamicLimitMi','carveoutMi','ipv4','sourceCommit','freeCacheIds','terminal','images'].includes(key)),'CONFIG');
  if(fixture.expected.sourceCommit !== undefined)requireSafe(/^[0-9a-f]{40}$/.test(fixture.expected.sourceCommit),'CONFIG');
  for(const value of [fixture.expected.dynamicLimitMi,fixture.expected.carveoutMi])
    if(value !== undefined)requireSafe(Number.isSafeInteger(value) && value > 0,'CONFIG');
  if(['BOOT-02','BOOT-03','BOOT-04'].includes(id))requireSafe(fixture.expected.bootChanges === 1 && fixture.expected.terminal === 'Succeeded','CONFIG');
  if(id === 'NET-05')requireSafe(fixture.expected.terminal === 'Succeeded' && fixture.expected.bootChanges === 0,'CONFIG');
  if(['NET-06','NET-07'].includes(id))requireSafe(fixture.expected.terminal === 'RolledBack' && fixture.expected.bootChanges === (id === 'NET-07' ? 1 : 0),'CONFIG');
  if(id === 'CHANNEL-07')requireSafe(['Failed','Interrupted'].includes(fixture.expected.terminal),'CONFIG');
  if(id === 'UPD-07')requireSafe(fixture.expected.bootChanges === 1 && request.updatePolicy?.automaticReboot === true,'CONFIG');
  if(id === 'GPUHOST-05') requireSafe(fixture.expected.bootChanges === 1 && Number.isSafeInteger(fixture.expected.dynamicLimitMi) &&
    fixture.expected.carveoutMi === host.gpuMemory?.currentCarveoutMi,'CONFIG');
  if(id === 'GPUHOST-06') requireSafe(fixture.expected.bootChanges >= 1 && Number.isSafeInteger(fixture.expected.dynamicLimitMi) &&
    Number.isSafeInteger(fixture.expected.carveoutMi),'CONFIG');
  if(id.startsWith('NET-')) requireSafe(Array.isArray(fixture.expected.ipv4) && fixture.expected.ipv4.length > 0 &&
    fixture.expected.ipv4.every(address=>/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?$/.test(address)),'CONFIG');
  if(id.startsWith('CHANNEL-') && id !== 'CHANNEL-07') requireSafe(/^[0-9a-f]{40}$/.test(fixture.expected.sourceCommit ?? '') &&
    Array.isArray(fixture.expected.images) && fixture.expected.images.length > 0 && fixture.expected.images.every(image=>/^sha256:[0-9a-f]{64}$/.test(image.digest)),'CONFIG');
  if(['CACHE-04','CACHE-06'].includes(id)) requireSafe(Array.isArray(fixture.expected.freeCacheIds) && fixture.expected.freeCacheIds.length > 0 &&
    fixture.expected.freeCacheIds.every(cache=>['huggingface','ollama'].includes(cache)),'CONFIG');
  return fixture;
}

export async function runHostDrill(live:LiveFoundation,id:string) {
  // No environment variable alone can approve a reboot. A reviewed one-boot
  // plan or installation-bound typed recipe/recovery bundle is also required.
  requireSafe(['phase6-drill','phase6-live'].includes(process.env.REGRESSION_MODE ?? '') && process.env.REGRESSION_HOST_DRILLS === 'approved' && process.env.REGRESSION_HOST_DRILLS_FILE,'PREREQUISITE');
  let json=JSON.parse(await readPrivate(process.env.REGRESSION_HOST_DRILLS_FILE));
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  let host=(await api.api.hostManagement()).nodes.find(item=>item.nodeUid === (json.version === 2 ? json.nodeUid : json.cases[id]?.request?.nodeUid));
  requireSafe(host,'IDENTITY');
  if(live.config.registrationFile && json.version === 2)json=automaticHostRecipes(live.config,host);
  requireSafe([1,2].includes(json?.version) && json.cases && Object.hasOwn(json.cases,id),'PREREQUISITE');
  if(json.version === 2 && id.startsWith('CHANNEL-')) {
    // Reuse the product's bounded preview operation. It checks existing pinned
    // images/source; setup recipes cannot invent a ready preview or change tags.
    const channel=json.cases[id].recipe.softwareChannel;
    const request:HostOperationRequest={action:'check-software-channel',nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,
      requestId:randomBytes(16).toString('hex'),confirmation:host.name,acknowledgeDisruption:true,
      allowExperimental:false,experimentMode:false,planId:host.software?.id,softwareChannel:channel};
    // Materialization fences the physical identity AND the previously verified boot before any preview write.
    materializeHostDrill(json,id,host,live.config);
    await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'channel-preview-'+id.toLowerCase()+'.json'),
      {version:1,nodeUid:host.nodeUid,bootId:host.bootId,requestId:request.requestId,state:'requested'},true);
    await api.write({method:'POST',path:'/api/host-management/operations',body:request},()=>api.api.requestHostOperation(request));
    host=await poll(async()=>{await live.guard();return (await api.api.hostManagement()).nodes.find(item=>item.nodeUid === request.nodeUid);},
      value=>Boolean(value?.operation?.requestId === request.requestId && value.operation.phase === 'Succeeded' && value.software?.preview?.ready &&
        canonical(value.software.preview.channel) === canonical(channel)),{timeoutMs:300_000,intervalMs:2000,stage:'host-readiness'});
    requireSafe(host,'HOST');
  }
  const drill=parseHostDrill(json.version === 2 ? materializeHostDrill(json,id,host,live.config) : json.cases[id],id,host);
  const restoreNetwork=async()=>restoreNetworkBaseline(live,api,host!);
  const unregisterNetwork=id === 'NET-05' && live.config.registrationFile ? live.registerRestoration(restoreNetwork) : undefined;
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'host-plan-'+id.toLowerCase()+'.json'),drill,true);
  if(id.startsWith('CHANNEL-')) {
    const preview=host.software?.preview;
    requireSafe(preview?.ready && preview.id === drill.request.softwarePreviewId && preview.configurationId === host.software?.id &&
      canonical(preview.channel) === canonical(drill.request.softwareChannel) && Date.now()/1000-preview.checkedAtEpoch >= 0 &&
      Date.now()/1000-preview.checkedAtEpoch <= 900,'PREREQUISITE');
    if(drill.expected.sourceCommit)requireSafe(preview.commit === drill.expected.sourceCommit,'REVISION');
  }
  if(drill.expected.images) {
    const key=(item:{namespace:string;deployment:string;container:string})=>`${item.namespace}/${item.deployment}/${item.container}`;
    requireSafe(canonical(drill.expected.images.map(key).sort()) === canonical(live.config.expected.images.map(key).sort()),'CONFIG');
  }
  const request={...drill.request,requestId:randomBytes(16).toString('hex')};
  const filename=join(process.env.REGRESSION_RUN_DIR!,'host-drill-'+id.toLowerCase()+'.json');
  const moduleSpecs=canonical((await live.observer.list('moduleactivations.appliance.magicstick.dev',live.config.expected.applianceNamespace))
    .map(item=>({uid:item.metadata.uid,spec:item.spec})).sort((a,b)=>String(a.uid).localeCompare(String(b.uid))));
  const settings=canonical(await api.api.settings());
  const beforeCacheModels=canonical((await live.api.models()).activations.map(item=>({uid:item.metadata?.uid,spec:item.spec})));
  const smoke:Array<Awaited<ReturnType<LiveFoundation['createModel']>>&{target:string;url:string;claim?:string}>=[];
  let probe:InferenceProbe|undefined;
  if(!id.startsWith('CACHE-')) {
    requireSafe(live.config.inferenceUrl && live.config.smokeModel,'PREREQUISITE');
    await openInferenceSession(live.context,live.config.inferenceUrl,live.config.loginTimeoutMs);
    const key=await live.createKey('drill-key-'+id.toLowerCase());probe=new InferenceProbe(live.context.request,live.config.inferenceUrl,key.secret);
    const candidates=id.startsWith('BOOT-') ? [live.config.smokeModel,live.config.gpu?.models.amdOllama,live.config.gpu?.models.nvidiaVllm] :
      id === 'GPUHOST-07' ? [live.config.smokeModel,live.config.gpu?.models.nvidiaVllm] : [live.config.smokeModel];
    const fixtures=id === 'BOOT-02' ? candidates.filter(Boolean) : candidates;
    requireSafe(fixtures.every(Boolean),'PREREQUISITE');
    for(const [index,fixture] of fixtures.entries()) {
      const created=await live.createModel('drill-'+id.toLowerCase()+'-'+index,live.journal,fixture!);
      const ready=await live.waitReady(created.client,created.uid,created.generation);
      await probe.chat(created.client.name,fixture!.url.split('://')[1]);
      const claim=ready.pods.flatMap(pod=>podSpec(pod).resourceClaims ?? []).map(item=>item.resourceClaimName).find(Boolean);
      smoke.push({...created,target:fixture!.computeTarget,url:fixture!.url,...(claim ? {claim} : {})});
    }
    if(id === 'BOOT-04')requireSafe(smoke.find(item=>item.target === 'amd-gpu')?.claim,'PREREQUISITE');
  }
  // Persist before the one write. A timeout cannot be retried; recovery is
  // manual and re-reviewed. Never store network credentials in this journal.
  await live.lease.reserveOfflineWindow(2100);
  const persistRequest=()=>writePrivate(filename,{version:1,caseId:id,nodeUid:host.nodeUid,bootId:host.bootId,requestId:request.requestId,state:'requested'});
  await writePrivate(filename,{version:1,caseId:id,nodeUid:host.nodeUid,bootId:host.bootId,requestId:request.requestId,state:'requested'},true);
  const receipt=['GPUHOST-05','NET-05','CHANNEL-06','CACHE-04'].includes(id) ? await submitThroughUi(live,id,host,request,persistRequest) :
    await api.write({method:'POST',path:'/api/host-management/operations',body:request},()=>api.api.requestHostOperation(request));
  requireSafe(receipt.accepted === true && receipt.requestId === request.requestId,'API');
  const operationName='host-'+createHash('sha256').update(JSON.stringify(host.nodeUid)).digest('hex').slice(0,24);
  const observed=await poll(async()=>{
    const intents=await observeDuringOutage(()=>live.observer.list('hostoperations.appliance.magicstick.dev',live.config.expected.applianceNamespace));
    if(!intents)return undefined;await live.guard();
    return intents.find(item=>item.metadata.name === operationName && item.spec?.requestId === request.requestId);
  },Boolean,{timeoutMs:240_000,intervalMs:2000,stage:'host-readiness'});
  // API status alone is not privileged-execution evidence. Bind the independent
  // observed intent before following the worker's current request.
  requireSafe(observed?.metadata.uid && observed.spec?.requestId === request.requestId,'OWNERSHIP');
  await writePrivate(filename,{version:1,caseId:id,nodeUid:host.nodeUid,bootId:host.bootId,requestId:request.requestId,uid:observed.metadata.uid,state:'accepted'});
  if(id === 'HOST-04') {
    const page=await live.context.newPage();try{await page.goto(live.config.dashboardUrl+'/#/system/power');await page.reload();}finally{await page.close();}
    await api.write({method:'POST',path:'/api/host-management/operations',body:request},()=>api.api.requestHostOperation(request));
    const replay=await live.observer.get('hostoperations.appliance.magicstick.dev',live.config.expected.applianceNamespace,operationName);
    requireSafe(replay.metadata.uid === observed.metadata.uid && replay.metadata.generation === observed.metadata.generation,'API');
  }
  if(id === 'HOST-05') {
    const busy=await api.api.hostManagement();requireSafe(busy.nodes.some(node=>node.nodeUid === host.nodeUid && node.operation?.requestId === request.requestId &&
      !['Succeeded','Failed','Rejected','Interrupted'].includes(node.operation.phase)),'PREREQUISITE');
    for(const action of ['reboot','clear-model-cache','install-updates','configure-network','configure-gpu-memory'] as const) {
      const conflict={...request,action,requestId:randomBytes(16).toString('hex')};let rejected=false;
      try{await api.write({method:'POST',path:'/api/host-management/operations',body:conflict},()=>api.api.requestHostOperation(conflict));}
      catch(error){rejected=error instanceof AdministrationRejected && error.status === 409;}requireSafe(rejected,'API');
    }
  }
  if(id === 'CACHE-06') {
    const current=await live.observer.get('hostoperations.appliance.magicstick.dev',live.config.expected.applianceNamespace,operationName);
    requireSafe(!['Succeeded','Failed','Rejected'].includes(current.status?.phase ?? ''),'PREREQUISITE');
    const created=await live.createModel('cache-race');
    const state=await poll(()=>live.modelState(created.client,created.uid),value=>/cache|maintenance/i.test(value.item?.status?.message ?? ''),
      {timeoutMs:30_000,intervalMs:1000,stage:'model-ready'});
    requireSafe(state.pods.length === 0 && !state.models.models?.some(model=>model.id === created.client.name) &&
      /cache|maintenance/i.test(state.item?.status?.message ?? ''),'API');
    await live.cleanup(live.journal,{kind:'model',name:created.client.name});
  }
  if(id.startsWith('NET-')) {
    await poll(async()=>{
      const operation=await observeDuringOutage(()=>live.observer.get('hostoperations.appliance.magicstick.dev',live.config.expected.applianceNamespace,operationName));
      if(operation)await live.guard();return operation;
    },operation=>Boolean(operation && operation.metadata.uid === observed.metadata.uid && operation.status?.phase === 'AwaitingConfirmation'),
    {timeoutMs:120_000,intervalMs:1000,stage:'host-readiness'});
    if(id === 'NET-05') {
      const page=await live.context.newPage();try {
        await page.goto(live.config.dashboardUrl+'/#/system/settings/network');
        const payload={nodeUid:host.nodeUid,requestId:request.requestId,confirmation:host.name};
        const handler=async(route:import('@playwright/test').Route)=>{requireSafe(route.request().method() === 'POST' && canonical(route.request().postDataJSON()) === canonical(payload),'MUTATION');await live.guard();await route.continue();};
        await page.route(live.config.dashboardUrl+'/api/host-management/network-confirm',handler);
        await page.getByRole('button',{name:'Keep this network configuration',exact:true}).click();
        await expect(page.getByText('Confirmation sent. Waiting for the host to save the configuration.',{exact:true})).toBeVisible();
      }finally{await page.close();}
    } else if(id === 'NET-07') {
      // This fault is deliberately out-of-band: a network trial holds the host
      // operation lock. Do not bypass it with SSH or another privileged API.
      process.stdout.write('NET-07: restart the approved host through its independent console during this unconfirmed trial. Waiting for the new boot.\n');
      await poll(()=>observeDuringOutage(()=>live.observer.get('nodes',undefined,host.name)),node=>Boolean(node && node.metadata.uid === host.nodeUid && node.status?.nodeInfo?.bootID !== host.bootId),
        {timeoutMs:170_000,intervalMs:2000,stage:'host-boot'});
    }
    // NET-06 intentionally sends no Keep request. The local timeout/recovery is
    // independently observed, rather than manufactured by a test rollback API.
  }
  const boots=new Set([host.bootId]);
  const final=await poll(async()=>{
    const nodes=await observeDuringOutage(()=>live.observer.list('nodes'));
    if(!nodes)return undefined;
    // Once the control plane is reachable, loss/expiry/replacement of the reserved lease is
    // fatal. No outage exception can bypass ownership or renew a lost lease.
    await live.guard();
    const node=nodes.find(item=>item.metadata.uid === host.nodeUid);
    requireSafe(node && node.metadata.name === host.name,'IDENTITY');
    const boot=String(node.status?.nodeInfo?.bootID ?? ''); if(boot) boots.add(boot);
    try {
      const report=(await api.api.hostManagement()).nodes.find(item=>item.nodeUid === host.nodeUid);
      return {node,report};
    } catch {return {node,report:undefined};}
  },value=>value?.report?.operation?.requestId === request.requestId && value.report.operation.phase === drill.expected.terminal,
  {timeoutMs:1_800_000,intervalMs:3000,stage:'host-readiness'});
  requireSafe(final?.report,'HOST');const report=final.report;
  await live.lease.finishOfflineWindow();
  requireSafe(boots.size-1 === drill.expected.bootChanges && report.bootId === final.node.status?.nodeInfo?.bootID &&
    report.kernel === drill.expected.kernel && report.available === true,'HOST');
  if(drill.expected.dynamicLimitMi !== undefined) requireSafe(report.gpuMemory?.currentDynamicLimitMi === drill.expected.dynamicLimitMi,'HOST');
  if(drill.expected.carveoutMi !== undefined) requireSafe(report.gpuMemory?.currentCarveoutMi === drill.expected.carveoutMi,'HOST');
  if(drill.expected.ipv4) requireSafe(drill.expected.ipv4.every(address=>report.network?.interfaces.some(item=>item.addresses.includes(address))),'HOST');
  if(drill.expected.sourceCommit) requireSafe(report.software?.hostCommit === drill.expected.sourceCommit && report.software.observed?.ready === true &&
    report.software.observed.appliedRevision?.endsWith(drill.expected.sourceCommit),'REVISION');
  if(drill.expected.freeCacheIds) requireSafe(drill.expected.freeCacheIds.every(cache=>report.modelCache?.caches.some(item=>item.id === cache && item.usedBytes === 0)),'HOST');
  if(id.startsWith('CACHE-'))requireSafe(canonical((await live.api.models()).activations.map(item=>({uid:item.metadata?.uid,spec:item.spec}))) === beforeCacheModels,'API');
  requireSafe(canonical(await api.api.settings()) === settings,'API');
  if(!['HOST-04','HOST-05','CHANNEL-06','CHANNEL-07','CHANNEL-08'].includes(id))requireSafe(canonical((await live.observer.list('moduleactivations.appliance.magicstick.dev',live.config.expected.applianceNamespace))
    .map(item=>({uid:item.metadata.uid,spec:item.spec})).sort((a,b)=>String(a.uid).localeCompare(String(b.uid)))) === moduleSpecs,'API');
  if(drill.expected.images) {
    for(const image of drill.expected.images) {
      requireSafe(live.config.expected.images.some(item=>item.namespace === image.namespace && item.deployment === image.deployment && item.container === image.container),'CONFIG');
      const deployment=await live.observer.get('deployments.apps',image.namespace,image.deployment),replicas=await live.observer.list('replicasets.apps',image.namespace);
      const owners=new Set(replicas.filter(item=>item.metadata.ownerReferences?.some(ref=>ref.uid === deployment.metadata.uid)).map(item=>item.metadata.uid));
      const pods=(await live.observer.list('pods',image.namespace)).filter(item=>item.metadata.ownerReferences?.some(ref=>owners.has(ref.uid)) && !item.metadata.deletionTimestamp);
      requireSafe(pods.length > 0 && pods.every(pod=>pod.status?.containerStatuses?.some(container=>container.name === image.container && container.ready && container.imageID?.endsWith(image.digest))),'REVISION');
    }
  }
  requireSafe((await api.api.session()).roles.includes('magicstick-admin'),'AUTH');
  if(id === 'BOOT-03' || id === 'GPUHOST-07') {
    requireSafe(Number(final.node.status?.allocatable?.['nvidia.com/gpu']) >= 1,'HOST');
    const devices=(await live.api.status()).hardwareOperators?.['nvidia-gpu']?.devices;
    requireSafe(devices?.some(device=>device.nodeUid === host.nodeUid && device.hostDriverReady && device.resourceRegistered),'HOST');
  }
  for(const model of smoke) {
    const state=await live.waitReady(model.client,model.uid,model.generation);
    if(model.target !== 'cpu')requireSafe(state.pods.every(pod=>podSpec(pod).nodeName === host.name),'HOST');
    if(model.claim) {
      const claim=await live.observer.get('resourceclaims.resource.k8s.io','ai',model.claim);
      const results=(claim.status?.allocation?.devices as {results?:Array<{driver:string;pool:string}>})?.results;
      requireSafe(results?.some(item=>item.driver === 'gpu.amd.com' && item.pool === host.name) &&
        state.pods.some(pod=>podSpec(pod).resourceClaims?.some(item=>item.resourceClaimName === model.claim)),'API');
    }
    await probe!.chat(model.client.name,model.url.split('://')[1]);
  }
  if(unregisterNetwork){await restoreNetwork();unregisterNetwork();}
  await writePrivate(filename,{version:1,caseId:id,nodeUid:host.nodeUid,requestId:request.requestId,uid:observed.metadata.uid,
    bootId:report.bootId,state:'verified',bootChanges:boots.size-1,postInferenceModels:smoke.map(item=>item.client.name)});
  // Save a proposed next-run profile, never edit the owner's input. Any new
  // digest/source pin must have been explicitly reviewed in this drill file.
  const next=structuredClone(live.config);next.expected.nodes=next.expected.nodes.map(node=>node.uid === host.nodeUid ? {...node,bootId:report.bootId} : node);
  if(next.gpu?.nodeUid === host.nodeUid)next.gpu.bootId=report.bootId;
  if(drill.expected.images)next.expected.images=drill.expected.images;
  if(drill.expected.sourceCommit && next.expected.flux)next.expected.flux.revision=report.software!.observed!.appliedRevision!;
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'post-drill-lab.json'),next);
  if(json.version === 2) {
    // Advance only after the exact owned request's terminal result, new boot,
    // image/source/memory/network oracles AND post-operation inference passed.
    // This does not repin any unexplained boot or write the owner's input files.
    Object.assign(live.config,next);
    await live.cleanup();
  }
  return {report,node:final.node};
}

async function restoreNetworkBaseline(live:LiveFoundation,api:AdministrationApi,before:ManagedHost) {
  const selected=before.network?.interfaces.find(item=>item.kind === 'ethernet' && item.editable && item.configuredMode);
  requireSafe(selected,'CLEANUP');
  const settings=(item:typeof selected):NetworkSettings=>({interface:item.name,mode:item.configuredMode!,metric:item.metric ?? 100,dns:item.dns ?? [],
    ...(item.configuredMode === 'static' ? {address:item.configuredAddress,gateway:item.configuredGateway} : {})});
  const baseline=settings(selected);
  const host=await poll(async()=>{await live.guard();return (await api.api.hostManagement()).nodes.find(item=>item.nodeUid === before.nodeUid);},
    item=>Boolean(item?.available && (!item.operation || ['Succeeded','Failed','Cancelled','RolledBack'].includes(item.operation.phase))),
    {timeoutMs:240_000,intervalMs:2000,stage:'cleanup'});
  requireSafe(host && host.bootId === before.bootId && host.network?.id,'CLEANUP');
  const current=host.network.interfaces.find(item=>item.name === selected.name);
  requireSafe(current,'CLEANUP');if(canonical(settings(current)) === canonical(baseline))return;
  const request:HostOperationRequest={action:'configure-network',nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,
    requestId:randomBytes(16).toString('hex'),confirmation:host.name,acknowledgeDisruption:true,allowExperimental:false,experimentMode:false,
    planId:host.network.id,network:baseline};
  await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'network-baseline-restore.json'),{version:1,nodeUid:host.nodeUid,
    bootId:host.bootId,requestId:request.requestId,network:baseline,state:'requested'});
  const receipt=await api.write({method:'POST',path:'/api/host-management/operations',body:request},()=>api.api.requestHostOperation(request));
  requireSafe(receipt.accepted && receipt.requestId === request.requestId,'CLEANUP');
  await poll(async()=>{await live.guard();return (await api.api.hostManagement()).nodes.find(item=>item.nodeUid === host.nodeUid);},
    item=>item?.operation?.requestId === request.requestId && item.operation.phase === 'AwaitingConfirmation',
    {timeoutMs:120_000,intervalMs:1500,stage:'cleanup'});
  const confirmation={nodeUid:host.nodeUid,requestId:request.requestId,confirmation:host.name};
  await api.write({method:'POST',path:'/api/host-management/network-confirm',body:confirmation},()=>api.api.confirmHostNetwork(confirmation));
  const restored=await poll(async()=>{await live.guard();return (await api.api.hostManagement()).nodes.find(item=>item.nodeUid === host.nodeUid);},
    item=>item?.operation?.requestId === request.requestId && item.operation.phase === 'Succeeded',
    {timeoutMs:120_000,intervalMs:1500,stage:'cleanup'});
  requireSafe(restored?.bootId === before.bootId && restored.network?.interfaces.some(item=>item.name === selected.name &&
    canonical(settings(item)) === canonical(baseline)),'CLEANUP');
}

async function observeDuringOutage<T>(read:()=>Promise<T>):Promise<T|undefined> {
  try{return await read();}catch(error){if(error instanceof HarnessError && error.code === 'OBSERVER')return undefined;throw error;}
}
async function submitThroughUi(live:LiveFoundation,id:string,host:ManagedHost,request:HostOperationRequest,persistRequest:()=>Promise<void>) {
  const page=await live.context.newPage();let receipt:any,uses=0;
  const handler=async(route:import('@playwright/test').Route)=>{
    const body=route.request().postDataJSON();
    requireSafe(++uses === 1 && route.request().method() === 'POST' && body.action === request.action && body.nodeUid === request.nodeUid && body.bootId === request.bootId &&
      body.confirmation === host.name && body.acknowledgeDisruption === true &&
      (!request.gpuMemory || canonical(body.gpuMemory) === canonical(request.gpuMemory)) &&
      (!request.network || canonical(body.network) === canonical(request.network)) &&
      (!request.softwareChannel || canonical(body.softwareChannel) === canonical(request.softwareChannel)) &&
      body.planId === request.planId && (!request.softwarePreviewId || body.softwarePreviewId === request.softwarePreviewId),'MUTATION');
    requireSafe(/^[0-9a-f]{32}$/.test(body.requestId),'MUTATION');request.requestId=body.requestId;
    await persistRequest(); // Record the UI-generated ID before the sole write.
    await live.guard();const response=await route.fetch({maxRedirects:0});receipt=await response.json();await route.fulfill({response});
  };
  await page.route(live.config.dashboardUrl+'/api/host-management/operations',handler);
  try {
    if(id === 'GPUHOST-05') {
      await page.goto(live.config.dashboardUrl+'/#/system/hardware');
      const node=page.getByRole('article',{name:`GPU node ${host.name}`,exact:true});
      await node.getByText('GPU Configuration AMD',{exact:true}).click();await node.getByText('Shared GPU memory',{exact:true}).click();
      const index=host.gpuMemory!.options?.findIndex(option=>option.index === request.gpuMemory!.carveoutIndex);requireSafe(index !== undefined && index >= 0,'CONFIG');
      await selectRange(node.getByRole('slider',{name:'Fixed GPU reservation (firmware)',exact:true}),index);
      await selectRange(node.getByRole('slider',{name:'Dynamic GPU memory limit',exact:true}),request.gpuMemory!.dynamicLimitMi);
      await node.getByRole('button',{name:'Review memory configuration',exact:true}).click();
      await page.getByRole('dialog').getByLabel(`Type ${host.name} to confirm`,{exact:true}).fill(host.name);
      await page.getByRole('dialog').getByRole('button',{name:'Apply memory configuration',exact:true}).click();
    }else if(id === 'NET-05') {
      await page.goto(live.config.dashboardUrl+'/#/system/settings/network');
      const device=host.network!.interfaces.find(item=>item.name === request.network!.interface);requireSafe(device && device.kind === 'ethernet','PREREQUISITE');
      const card=page.getByRole('article',{name:'Ethernet '+device.name,exact:true});await card.getByRole('button',{name:'Configure',exact:true}).click();
      await card.getByRole('combobox',{name:'IPv4 configuration',exact:true}).selectOption(request.network!.mode!);
      for(const [label,value] of [['Route metric',request.network!.metric],['DNS servers',request.network!.dns?.join(', ')],
        ...(request.network!.mode === 'static' ? [['IPv4 address / prefix',request.network!.address],['IPv4 gateway',request.network!.gateway]] : [])])
        await card.getByLabel(String(label),{exact:true}).fill(String(value ?? ''));
      await card.getByRole('button',{name:'Review network change',exact:true}).click();
      await page.getByRole('dialog').getByLabel(`Type ${host.name} to confirm`,{exact:true}).fill(host.name);
      await page.getByRole('dialog').getByRole('button',{name:'Apply temporarily',exact:true}).click();
    }else if(id === 'CACHE-04') {
      await page.goto(live.config.dashboardUrl+'/#/system/model-cache');
      const panel=page.locator('section.panel').filter({has:page.getByRole('heading',{name:host.name,exact:true})});
      await panel.getByRole('button',{name:'Clear model cache',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Clear model cache',exact:true});
      await dialog.getByLabel(`Type ${host.name} to confirm`,{exact:true}).fill(host.name);
      await dialog.getByRole('button',{name:'Clear cache',exact:true}).click();
    }else {
      await page.goto(live.config.dashboardUrl+'/#/system/settings/updates');
      const selected=request.softwareChannel!;await page.getByRole('combobox',{name:'Software channel',exact:true}).selectOption(selected.kind === 'branch' && ['main','develop'].includes(selected.value) ? selected.value : selected.kind);
      if(!(selected.kind === 'branch' && ['main','develop'].includes(selected.value)))await page.getByLabel(selected.kind === 'branch' ? 'Branch name' : selected.kind === 'tag' ? 'Tag name' : 'Full commit',{exact:true}).fill(selected.value);
      await page.getByRole('button',{name:'Apply channel',exact:true}).click();
      await page.getByRole('dialog').getByLabel(`Type ${host.name} to confirm`,{exact:true}).fill(host.name);
      await page.getByRole('dialog').getByRole('button',{name:'Apply channel',exact:true}).click();
    }
    await poll(async()=>receipt,Boolean,{timeoutMs:30_000,intervalMs:100,stage:'host-readiness'});return receipt;
  }finally{await page.close();}
}
