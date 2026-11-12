import {test, expect, type APIRequestContext} from '@playwright/test';
import {moduleResourceLinks, type ResourceLink} from '@magicstick/dashboard-core';
import {moduleProbeLinks, probeModuleServices,probeServiceAccess,probeServiceAccessAfterNavigation} from '../core/service-probes.ts';
import {moduleRuntimeInventory,moduleRemovalObserved,moduleInstallationObserved,modulePodTemplateMatches,type ModuleRuntimeObject} from '../core/module-lifecycle.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {AppRuntimeProof,appRuntimeInventory,appRuntimeRemovalObserved,appRuntimeResourceKinds,appRuntimeResources,type AppRuntimeObject,type AppRuntimeReceipt} from '../core/app-lifecycle.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readPrivate} from '../core/private-files.ts';
import {spawnSync} from 'node:child_process';

const annotation = evidenceAnnotations({id: 'HAR-10', layer: 'U'});
const link = (url: string, scope: ResourceLink['scope']): ResourceLink => ({url, scope, label: 'Synthetic service'});
const local = link('https://anythingllm.fixture.local/', 'local');
const publicLink = link('https://anythingllm.magicstick.example.com/', 'public');

test('HAR-02 service preparation and recovery entrypoints import in plain Node without TypeScript transformation',annotation,()=>{
  const files=['app-lifecycle.ts','module-runtime-proof.ts','input-preparation.ts','recovery-adapters.ts'];
  const code=files.map(file=>`await import(${JSON.stringify(new URL('../core/'+file,import.meta.url).href)});`).join('\n');
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15_000,
    env:{...process.env,NODE_OPTIONS:''},maxBuffer:1024*1024});
  expect(result.error).toBeUndefined();expect(result.status,result.stderr).toBe(0);
});
test('MOD-03 local service readiness does not probe the advertised public placeholder', annotation, async () => {
  const links = moduleResourceLinks('anythingllm', undefined, {httpRoutes: [
    {name: 'anythingllm-local', namespace: 'ai', accepted: true, hostnames: ['anythingllm.fixture.local']},
    {name: 'anythingllm-public', namespace: 'ai', accepted: true, hostnames: ['anythingllm.magicstick.example.com']},
    {name: 'anythingllm-not-ready', namespace: 'ai', accepted: false, hostnames: ['unready.fixture.local']},
  ]});
  expect(links.map(item => item.scope)).toEqual(['local', 'public']);
  const selected = moduleProbeLinks(links, 'https://fixture.local'), calls: string[] = [];
  const request = {get: async (url: string, options: Record<string, unknown>) => {
    calls.push(url);
    if (new URL(url).hostname.endsWith('.example.com')) throw new Error('getaddrinfo ENOTFOUND synthetic-public-host');
    expect(options).toMatchObject({ignoreHTTPSErrors: true, maxRedirects: 0, timeout: 1234, failOnStatusCode: false});
    return {status: () => 200, dispose: async () => {}};
  }} as unknown as APIRequestContext;
  expect(selected.map(item => new URL(item.url).hostname)).toEqual(['anythingllm.fixture.local']);
  await probeModuleServices(request, selected, 1234);
  expect(calls).toEqual([selected[0]!.url]);
  // Counterproof: the former all-links loop reaches the bogus public route.
  await expect(probeModuleServices(request, links, 1234)).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
});

test('MOD-03 missing local routes fail without public fallback or borrowing a peer route', annotation, () => {
  const peer = link('https://anythingllm.monster.fixture.local/', 'local');
  const appliance = 'https://monster.fixture.local';
  for (const links of [[], [publicLink], [local], [link('https://monster.fixture.local/', 'local')]])
    expect(() => moduleProbeLinks(links, appliance)).toThrow('[API]');
  expect(moduleProbeLinks([local, peer, publicLink], appliance)).toEqual([peer]);
  expect(moduleProbeLinks([local, peer, publicLink], 'https://fixture.local')).toEqual([local]);
  expect(moduleProbeLinks([local, local, publicLink], 'https://fixture.local')).toEqual([local]);
});

test('MOD-03 public and direct connections retain their own advertised route checks', annotation, () => {
  expect(moduleProbeLinks([local, publicLink], 'https://dashboard.example.com')).toEqual([publicLink]);
  const direct = link('https://192.0.2.1:8443/', 'direct');
  expect(moduleProbeLinks([direct, local, publicLink], 'https://192.0.2.1')).toEqual([direct]);
  expect(() => moduleProbeLinks([direct], 'https://192.0.2.2')).toThrow('[API]');
  for (const url of ['http://anythingllm.fixture.local/', 'https://user:synthetic@anythingllm.fixture.local/', 'invalid'])
    expect(() => moduleProbeLinks([link(url, 'local')], 'https://fixture.local')).toThrow('[CONFIG]');
  for (const dashboard of ['http://fixture.local', 'https://fixture.local/path', 'invalid'])
    expect(() => moduleProbeLinks([local], dashboard)).toThrow('[CONFIG]');
});

test('MOD-03 functional TLS policy never accepts a failed HTTP response, DNS failure or timeout', annotation, async () => {
  await expect(probeModuleServices({get: async () => {throw new Error('No request expected');}} as unknown as APIRequestContext, [], 1000))
    .rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
  for (const status of [200, 302, 303, 401, 403, 404, 500, 503]) {
    let disposed = 0;
    const request = {get: async () => ({status: () => status, dispose: async () => {disposed++;}})} as unknown as APIRequestContext;
    const probe = probeModuleServices(request, [local], 1000);
    if ([200, 302, 303].includes(status)) await probe;
    else await expect(probe).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
    expect(disposed).toBe(1);
  }
  for (const message of ['getaddrinfo ENOTFOUND service.fixture.local', 'Timeout 1000ms exceeded', 'ECONNREFUSED']) {
    const request = {get: async () => {throw new Error(message);}} as unknown as APIRequestContext;
    await expect(probeModuleServices(request, [local], 1000)).rejects.toMatchObject({code: 'API', outcome: 'Failed', stage: 'module-ready'});
  }
});

test('MOD-03 service access proves exact local SSO and rejects redirects to unrelated identities or callbacks',annotation,async()=>{
  const expected={mode:'sso' as const,identityOrigin:'https://id.fixture.local',dashboardOrigin:'https://fixture.local'};
  const response=(status:number,location='')=>({get:async()=>({status:()=>status,headers:()=>({location}),dispose:async()=>{}})}) as unknown as APIRequestContext;
  const auth=(issuer='https://id.fixture.local',callback='https://fixture.local/oauth2/callback/static-service-local')=>
    issuer+'/realms/magicstick/protocol/openid-connect/auth?redirect_uri='+encodeURIComponent(callback);
  await probeServiceAccess(response(200),response(302,auth()),[local],1000,expected);
  for(const [status,location] of [[200,''],[500,''],[302,'/app-login'],[302,auth('https://foreign.example.com')],
    [302,auth(undefined,'https://foreign.example.com/oauth2/callback/static-service-local')],
    [302,auth(undefined,'https://fixture.local/not-a-callback')]] as const)
    await expect(probeServiceAccess(response(200),response(status,location),[local],1000,expected)).rejects.toBeDefined();
  await expect(probeServiceAccess(response(302,auth()),response(302,auth()),[local],1000,expected)).rejects.toMatchObject({code:'AUTH'});
  // Public access is an explicit different contract, not an accepted SSO bypass.
  await probeServiceAccess(response(200),response(200),[local],1000,{...expected,mode:'public'});
  await expect(probeServiceAccess(response(200),response(302,auth()),[local],1000,{...expected,mode:'public'})).rejects.toMatchObject({code:'AUTH'});
});

test('MOD-03 service route uses normal browser navigation before requiring its authenticated API session',annotation,async()=>{
  const expected={mode:'sso' as const,identityOrigin:'https://id.fixture.local',dashboardOrigin:'https://fixture.local'},events:string[]=[];
  let serviceSession=false;
  const location=expected.identityOrigin+'/realms/magicstick/protocol/openid-connect/auth?redirect_uri='+
    encodeURIComponent(expected.dashboardOrigin+'/oauth2/callback/static-service-local');
  const response=(status:number)=>({status:()=>status,headers:()=>({location}),dispose:async()=>{}});
  const authenticated={get:async()=>{events.push('signed-in request');return response(serviceSession?200:302);}} as unknown as APIRequestContext;
  const anonymous={get:async()=>{events.push('anonymous request');return response(302);}} as unknown as APIRequestContext;
  // A valid Dashboard login can still need a normal service-route callback.
  await expect(probeServiceAccess(authenticated,anonymous,[local],1000,expected)).rejects.toMatchObject({code:'AUTH'});
  events.length=0;
  await probeServiceAccessAfterNavigation(authenticated,anonymous,[local],1000,expected,async link=>{
    expect(link).toEqual(local);events.push('normal browser navigation');serviceSession=true;
  });
  expect(events).toEqual(['normal browser navigation','anonymous request','signed-in request']);
  events.length=0;
  await expect(probeServiceAccessAfterNavigation(authenticated,anonymous,[local],1000,expected,async()=>{
    events.push('failed browser navigation');throw new Error('Synthetic navigation failure');
  })).rejects.toThrow('Synthetic navigation failure');
  expect(events).toEqual(['failed browser navigation']);
});

test('MOD-04 module removal checks exact Flux ownership and descendant runtime independently of Disabled',annotation,()=>{
  const root=(resource:ModuleRuntimeObject['resource'],name:string,uid:string,owners:string[]=[],owned=true):ModuleRuntimeObject=>
    ({resource,object:{metadata:{name,uid,namespace:'ai',...(owned?{labels:{'kustomize.toolkit.fluxcd.io/name':'app-synthetic',
      'kustomize.toolkit.fluxcd.io/namespace':'flux-system'}}:{}),ownerReferences:owners.map(uid=>({uid,kind:'Synthetic'}))}}});
  const deployment=root('deployments.apps','service','deployment-uid');
  const rs=root('replicasets.apps','service-rollout','rs-uid',['deployment-uid'],false);
  const pod=root('pods','service-pod','pod-uid',['rs-uid'],false);
  const pvc=root('persistentvolumeclaims','service-storage','pvc-uid');
  const foreign=root('pods','same-prefix-other','foreign-uid',[],false);
  const before=moduleRuntimeInventory([pod,rs,deployment,pvc,foreign],'app-synthetic');
  expect(before.runtime.map(item=>item.object.metadata.uid).sort()).toEqual(['deployment-uid','pod-uid','rs-uid']);
  expect(moduleRemovalObserved(before,[pvc,foreign],'app-synthetic',true)).toBe(true);
  expect(moduleRemovalObserved(before,[pod,pvc,foreign],'app-synthetic',true)).toBe(false);
  expect(()=>moduleRemovalObserved(before,[foreign],'app-synthetic',true)).toThrow('[CLEANUP]');
  expect(()=>moduleRemovalObserved(before,[{...pvc,object:{metadata:{...pvc.object.metadata,deletionTimestamp:new Date().toISOString()}}}],
    'app-synthetic',true)).toThrow('[CLEANUP]');
  expect(()=>moduleRemovalObserved(before,[root('deployments.apps','service','replacement-uid'),pvc],'app-synthetic',true)).toThrow('[OWNERSHIP]');
  expect(moduleRemovalObserved(before,[foreign],'app-synthetic',false)).toBe(true);
  expect(moduleRemovalObserved(before,[pvc,foreign],'app-synthetic',false)).toBe(false);
  // A retained original UID cannot disappear from the check by losing labels.
  expect(moduleRemovalObserved(before,[{...pvc,object:{metadata:{...pvc.object.metadata,labels:{}}}},foreign],
    'app-synthetic',false)).toBe(false);
  // Merely sharing an application prefix does not create cleanup ownership.
  expect(moduleRuntimeInventory([foreign],'app-synthetic').runtime).toEqual([]);
  const template={containers:[{name:'service',image:'registry.invalid/owned:v2'}]},readyPod={...pod,object:{...pod.object,spec:template,
    status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:[{name:'service',ready:true,imageID:'synthetic-image-id'}]}}};
  const status={observedGeneration:2,replicas:1,updatedReplicas:1,readyReplicas:1,availableReplicas:1};
  const ready={...deployment,object:{...deployment.object,metadata:{...deployment.object.metadata,generation:2},spec:{replicas:1,template:{spec:template}},status}};
  expect(moduleInstallationObserved(moduleRuntimeInventory([ready,rs,readyPod],'app-synthetic'))).toBe(true);
  for(const changed of [{...status,observedGeneration:1},{...status,readyReplicas:0},{...status,updatedReplicas:0},
    {...status,availableReplicas:0},{...status,replicas:2}])
    expect(moduleInstallationObserved(moduleRuntimeInventory([{...ready,object:{...ready.object,status:changed}},rs,readyPod],'app-synthetic'))).toBe(false);
  expect(moduleInstallationObserved(moduleRuntimeInventory([ready,rs,{...readyPod,object:{...readyPod.object,
    spec:{containers:[{name:'service',image:'registry.invalid/old:v1'}]}}}],'app-synthetic'))).toBe(false);
  expect(moduleInstallationObserved(moduleRuntimeInventory([ready,rs],'app-synthetic'))).toBe(false);
  const stateful={...ready,resource:'statefulsets.apps' as const,object:{...ready.object,
    status:{...status,currentReplicas:1,currentRevision:'revision2',updateRevision:'revision2'}}},statefulPod={...readyPod,object:{...readyPod.object,
      metadata:{...readyPod.object.metadata,labels:{'controller-revision-hash':'revision2'},ownerReferences:[{uid:'deployment-uid',kind:'StatefulSet'}]}}};
  expect(moduleInstallationObserved(moduleRuntimeInventory([stateful,statefulPod],'app-synthetic'))).toBe(true);
  for(const changed of [{...stateful.object.status,currentRevision:'revision1'},{...stateful.object.status,updatedReplicas:0}])
    expect(moduleInstallationObserved(moduleRuntimeInventory([{...stateful,object:{...stateful.object,status:changed}},statefulPod],'app-synthetic'))).toBe(false);
  expect(moduleInstallationObserved(moduleRuntimeInventory([stateful,{...statefulPod,object:{...statefulPod.object,
    metadata:{...statefulPod.object.metadata,labels:{'controller-revision-hash':'revision1'}}}}],'app-synthetic'))).toBe(false);
  // A new descendant created after the installed snapshot is still a remaining
  // runtime, even when the original Deployment is already gone.
  const newRs=root('replicasets.apps','service-new-rollout','new-rs-uid',['deployment-uid'],false);
  const newPod=root('pods','service-new-pod','new-pod-uid',['new-rs-uid'],false);
  expect(moduleRemovalObserved(moduleRuntimeInventory([deployment],'app-synthetic'),[newRs,newPod],'app-synthetic',false)).toBe(false);
});

test('MOD-03 module installation requires current DaemonSet health and completed exact-template Job Pods',annotation,()=>{
  const metadata={name:'work',namespace:'ai',uid:'work-uid',generation:3,labels:{'kustomize.toolkit.fluxcd.io/name':'app-synthetic',
    'kustomize.toolkit.fluxcd.io/namespace':'flux-system'}};
  const daemon:ModuleRuntimeObject={resource:'daemonsets.apps',object:{metadata,status:{observedGeneration:3,desiredNumberScheduled:2,
    currentNumberScheduled:2,updatedNumberScheduled:2,numberReady:2,numberAvailable:2,numberUnavailable:0} as any}};
  const inventory=(objects:ModuleRuntimeObject[])=>moduleRuntimeInventory(objects,'app-synthetic');
  expect(moduleInstallationObserved(inventory([daemon]))).toBe(true);
  for(const status of [{...daemon.object.status,observedGeneration:2},{...daemon.object.status,numberReady:1},
    {...daemon.object.status,updatedNumberScheduled:1},{...daemon.object.status,numberAvailable:1}])
    expect(moduleInstallationObserved(inventory([{...daemon,object:{metadata,status}}]))).toBe(false);
  const template={restartPolicy:'Never',containers:[{name:'seed',image:'registry.invalid/seed@sha256:'+'a'.repeat(64)}]};
  const job:ModuleRuntimeObject={resource:'jobs.batch',object:{metadata,spec:{completions:1,template:{spec:template}},
    status:{active:0,succeeded:1,conditions:[{type:'Complete',status:'True'}]}}};
  const pod:ModuleRuntimeObject={resource:'pods',object:{metadata:{name:'work-pod',namespace:'ai',uid:'pod-uid',
    ownerReferences:[{kind:'Job',uid:metadata.uid}]},spec:template,status:{phase:'Succeeded',
    containerStatuses:[{name:'seed',state:{terminated:{exitCode:0}}}]}}};
  expect(moduleInstallationObserved(inventory([job,pod]))).toBe(true);
  expect(moduleInstallationObserved(inventory([job]))).toBe(false);
  for(const status of [{active:1,succeeded:0},{active:0,succeeded:0,conditions:[{type:'Failed',status:'True'}]},
    {active:0,succeeded:1,conditions:[{type:'Complete',status:'True'},{type:'FailureTarget',status:'True'}]}])
    expect(moduleInstallationObserved(inventory([{...job,object:{...job.object,status}},pod]))).toBe(false);
  const replacement={...pod,object:{...pod.object,metadata:{...pod.object.metadata,ownerReferences:[{kind:'Job',uid:'foreign-uid'}]}}};
  expect(moduleInstallationObserved(inventory([job,replacement]))).toBe(false);
  expect(moduleInstallationObserved(inventory([job,{...pod,object:{...pod.object,spec:{...template,containers:[{name:'seed',image:'foreign'}]}}}]))).toBe(false);
});

test('MOD-03 current Flux inventories must contain every declared workload and nested Helm workload before installation passes',annotation,()=>{
  const source={metadata:{name:'app-synthetic',namespace:'flux-system',uid:'source-uid',generation:2},status:{observedGeneration:2,
    conditions:[{type:'Ready',status:'True'}],inventory:{entries:[{id:'ai_service_apps_Deployment'}]}}};
  const missing=moduleRuntimeInventory([],'app-synthetic','flux-system',source);
  expect(missing.missingWorkloads).toEqual(['ai_service_apps_Deployment']);expect(moduleInstallationObserved(missing)).toBe(false);
  const empty={...source,status:{...source.status,inventory:{entries:[]}}};
  expect(moduleInstallationObserved(moduleRuntimeInventory([],'app-synthetic','flux-system',empty))).toBe(true);
  expect(moduleInstallationObserved(moduleRuntimeInventory([],'app-synthetic','flux-system',
    {...empty,status:{...empty.status,observedGeneration:1}}))).toBe(false);
  const release:ModuleRuntimeObject={resource:'helmreleases.helm.toolkit.fluxcd.io',object:{metadata:{name:'operator',namespace:'flux-system',uid:'helm-uid',generation:1,
    labels:{'kustomize.toolkit.fluxcd.io/name':'app-synthetic','kustomize.toolkit.fluxcd.io/namespace':'flux-system'}},
    status:{observedGeneration:1,conditions:[{type:'Ready',status:'True'}],history:[{name:'operator',namespace:'operator-system',status:'deployed'}],
      inventory:{entries:[{id:'operator-system_operator_apps_Deployment'}]}} as any}};
  expect(moduleInstallationObserved(moduleRuntimeInventory([release],'app-synthetic'))).toBe(false);
  const nested:ModuleRuntimeObject={resource:'helmreleases.helm.toolkit.fluxcd.io',object:{...release.object,
    metadata:{name:'nested',namespace:'flux-system',uid:'nested-uid',generation:1,annotations:{'meta.helm.sh/release-name':'operator','meta.helm.sh/release-namespace':'operator-system'}},
    status:{...release.object.status,history:[{name:'nested',namespace:'operator-system',status:'deployed'}],
      inventory:{entries:[{id:'operator-system_nested_apps_Deployment'}]}} as any}};
  const parent={...release,object:{...release.object,status:{...release.object.status,
    inventory:{entries:[{id:'flux-system_nested_helm.toolkit.fluxcd.io_HelmRelease'}]}} as any}};
  const nestedInventory=moduleRuntimeInventory([parent,nested],'app-synthetic');
  expect(nestedInventory.missingWorkloads).toEqual(['operator-system_nested_apps_Deployment']);
  expect(moduleInstallationObserved(nestedInventory)).toBe(false);
});

test('MOD-03 current Pod templates allow only canonical API ServiceAccount admission, never changed intended image or environment',annotation,()=>{
  const mount={name:'data',mountPath:'/data'},template={volumes:[{name:'data',emptyDir:{}}],containers:[{name:'app',image:'registry.invalid/app:v2',
    command:['node'],args:['main.js'],env:[{name:'MODE',value:'test'}],volumeMounts:[mount]}]},name='kube-api-access-abc12';
  const actual={...structuredClone(template),volumes:[...template.volumes,{name,projected:{defaultMode:420,sources:[
    {serviceAccountToken:{expirationSeconds:3607,path:'token'}},{configMap:{name:'kube-root-ca.crt',items:[{key:'ca.crt',path:'ca.crt'}]}},
    {downwardAPI:{items:[{path:'namespace',fieldRef:{apiVersion:'v1',fieldPath:'metadata.namespace'}}]}}]}}],
    containers:[{...template.containers[0]!,volumeMounts:[mount,{name,mountPath:'/var/run/secrets/kubernetes.io/serviceaccount',readOnly:true}]}]};
  expect(modulePodTemplateMatches(template,actual)).toBe(true);
  for(const container of [{...actual.containers[0]!,image:'registry.invalid/old:v1'},
    {...actual.containers[0]!,env:[{name:'MODE',value:'foreign'}]},
    {...actual.containers[0]!,args:['other.js']},
    {...actual.containers[0]!,volumeMounts:[mount,{name,mountPath:'/data/private',readOnly:true}]}])
    expect(modulePodTemplateMatches(template,{...actual,containers:[container]})).toBe(false);
});

test('APP-10 app cleanup derives native kinds from the catalog and tracks all UID descendants without deleting foreign resources',annotation,()=>{
  const catalog={modules:{operator:{requiredCrds:['instances.paperclip.inc'],requires:['sandbox']},
    sandbox:{requiredCrds:['sandboxes.agents.x-k8s.io']}},applications:{paperclip:{requiredModules:['operator'],requiredCrds:['instances.paperclip.inc']}}};
  const kinds=appRuntimeResourceKinds({modules:{},catalogJson:catalog},'paperclip');
  expect(kinds).toContain('instances.paperclip.inc');expect(kinds).toContain('sandboxes.agents.x-k8s.io');
  for(const kind of ['daemonsets.apps','statefulsets.apps','replicationcontrollers','cronjobs.batch','jobs.batch'])expect(kinds).toContain(kind);
  expect(()=>appRuntimeResourceKinds({modules:{},catalogJson:{...catalog,modules:{operator:{requires:['missing']}}}},'paperclip')).toThrow('[CONFIG]');
  const object=(resource:string,name:string,uid:string,owners:string[]=[],labels:Record<string,string>={}):AppRuntimeObject=>({resource,object:{metadata:{
    name,namespace:'ai',uid,labels,ownerReferences:owners.map(uid=>({uid,kind:'Synthetic'}))}}});
  const native=object('instances.paperclip.inc','owned','native-uid',[],{'appliance.magicstick.dev/appinstance':'owned'}),
    sandbox=object('sandboxes.agents.x-k8s.io','sandbox','sandbox-uid',['native-uid']),
    stateful=object('statefulsets.apps','stateful','stateful-uid',['sandbox-uid']),
    pod=object('pods','pod','pod-uid',['stateful-uid']),foreign=object('pods','owned-prefix-other','foreign-uid');
  const before=appRuntimeInventory([pod,sandbox,foreign,stateful,native],'owned','app-uid');
  expect(before.runtime.map(item=>item.object.metadata.uid).sort()).toEqual(['native-uid','sandbox-uid','stateful-uid','pod-uid'].sort());
  const receipt:AppRuntimeReceipt={version:1,runId:newRunId(),applianceUid:'fixture',name:'owned',uid:'app-uid',generation:1,
    resources:kinds,runtime:before.runtime.map(({resource,object})=>({resource,name:object.metadata.name!,namespace:'ai',uid:object.metadata.uid!})),persistent:[],state:'observed'};
  expect(appRuntimeRemovalObserved(receipt,[pod,foreign]).removed).toBe(false);
  const lateJob=object('jobs.batch','late','late-uid',['sandbox-uid']),latePod=object('pods','late-pod','late-pod-uid',['late-uid']);
  expect(appRuntimeRemovalObserved(receipt,[latePod,lateJob,foreign]).removed).toBe(false);
  expect(appRuntimeRemovalObserved(receipt,[foreign]).removed).toBe(true);
  expect(()=>appRuntimeRemovalObserved(receipt,[{...native,object:{metadata:{...native.object.metadata,uid:'replacement'}}}])).toThrow('[OWNERSHIP]');
});

test('APP-10 app deletion snapshots are durable and keep native-list failures unknown and persistent data separate',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'app-runtime-proof-'));
  try {
    const journal=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'fixture'),name='pi-coding-'+journal.prefix+'owned';
    await journal.requested('app',name);await journal.owned('app',name,'app-uid',1);
    const entry=journal.entries[0]!,catalog={modules:{},catalogJson:{modules:{pi:{requiredCrds:[]}},applications:{'pi-coding':{requiredModules:['pi'],requiredCrds:[]}}}};
    const instance={metadata:{name,uid:'app-uid',generation:1},spec:{application:'pi-coding',targetNamespace:'ai'}};
    const pvc:AppRuntimeObject={resource:'persistentvolumeclaims',object:{metadata:{name:name+'-data',namespace:'ai',uid:'pvc-uid',
      labels:{'app.kubernetes.io/instance':name},annotations:{'helm.sh/resource-policy':'keep'}}}};
    const live={journal,config:{expected:{applianceUid:'fixture'}},guard:async()=>{},observer:{list:async(resource:string)=>resource===pvc.resource?[pvc.object]:[]}};
    let current:typeof instance|null=instance;const proof=new AppRuntimeProof(live,async()=>current,async()=>catalog);
    const receipt=await proof.capture(entry);
    expect(receipt.resources).toEqual([...appRuntimeResources].sort());expect(receipt.persistent[0]!.uid).toBe('pvc-uid');
    current=null;await expect(proof.verifyRemoved(entry)).resolves.toBe(true);
    const filename=join(directory,'app-runtime-'+name+'.json'),savedText=await readPrivate(filename),saved=JSON.parse(savedText);
    expect(saved.state).toBe('removed');expect(saved.verification.persistent[0]).toMatchObject({uid:'pvc-uid',state:'retained'});
    await proof.verifyRemoved(entry);expect(await readPrivate(filename)).toBe(savedText);
    expect(()=>appRuntimeRemovalObserved(receipt,[])).toThrow('[CLEANUP]');
    live.observer.list=async()=>{throw new Error('Synthetic forbidden list');};
    await expect(proof.verifyRemoved(entry)).rejects.toThrow('Synthetic forbidden list');
  }finally{await rm(directory,{recursive:true,force:true});}
});
