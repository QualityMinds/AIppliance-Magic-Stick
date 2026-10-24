import {test,expect} from '@playwright/test';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import {parseHostDrill} from '../core/host-drill.ts';
import {remainingIds,remainingRequirements,hostDrillIds} from '../profiles/remaining-p0.ts';
import {validCompanionReport,publicCompanionProof,discoverCompanionRun,companionAcceptanceCheck,companionWorkflow} from './companion-live.ts';
import {currentSecurityCiRun,normalizeRules,ordinaryDashboardRules,shippedDashboardRbac} from './security-live.ts';
import {AdministrationApi,allowedAdministrationRead} from '../core/administration-api.ts';
import type {APIRequestContext} from '@playwright/test';
import {atStage} from '../core/errors.ts';
import {inspectOidcConfig} from '../core/oidc-exec.ts';
import {verifyAppCleanerRules,OwnedAppClient,appReleaseTarget,appReleaseReady} from '../core/owned-app.ts';
import type {AppInstance} from '@magicstick/dashboard-contracts';
import type {KubeObject} from '../core/observer.ts';
import {moduleProfileWorkflow,waitModuleProfileReadback} from './modules-live.ts';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {validateAppFixtures,catalogContext} from './apps-live.ts';
import {websocketFrame,websocketEvent} from '../core/realtime-probe.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {licenseUiPermits} from './license-live.ts';
import {allowedExactDashboardRequest} from '../core/auth.ts';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import type {MemoryEstimate,ModelsPayload,ModulesPayload} from '@magicstick/dashboard-contracts';
import {applicationModel,applicationContexts,applicationEditContext} from '../core/application-model.ts';
import {catalogFixture} from '../core/input-preparation.ts';
import {HarnessError} from '../core/errors.ts';
import {HermesTerminalEvidence} from '../core/hermes-terminal.ts';
import {OpenCodeChatEvidence,completedOpenCodeTurn,openCodeChatPath} from '../core/opencode-chat.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {privateDirectory,writePrivate,readPrivate} from '../core/private-files.ts';
import {OwnedModelClient} from '../core/owned-model.ts';
import {moduleIntentSnapshot} from './mesh-live.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});

test('MESH-01 read-only navigation compares persisted module intent, not changing reconciliation status',
  evidenceAnnotations({id:'MESH-01',layer:'U'},{id:'HAR-10',layer:'U'}),()=>{
  const before:KubeObject[]=[{metadata:{name:'dashboard',namespace:'ai-system',uid:'dashboard-uid',generation:3,resourceVersion:'10'},
    spec:{module:'dashboard',enabled:true,parameters:{host:'example.local'}},
    status:{phase:'Ready',observedGeneration:3}},{metadata:{name:'mesh',namespace:'ai-system',uid:'mesh-uid',generation:1},
    spec:{module:'private-mesh',enabled:true}}];
  const reconciled=structuredClone(before).reverse();
  reconciled[1]!.metadata.resourceVersion='11';reconciled[1]!.status={phase:'Reconciling',observedGeneration:3};
  expect(moduleIntentSnapshot(reconciled)).toBe(moduleIntentSnapshot(before));
  const custom=structuredClone(before);custom.forEach(item=>{item.metadata.namespace='custom-appliance';});
  expect(moduleIntentSnapshot(custom,'custom-appliance')).toContain('custom-appliance');
  expect(()=>moduleIntentSnapshot(custom)).toThrow('[API]');
  expect(()=>moduleIntentSnapshot(custom,'')).toThrow('[API]');
  for(const mutate of [
    (items:KubeObject[])=>{items[0]!.spec!.enabled=false;},
    (items:KubeObject[])=>{items[0]!.spec!.parameters={host:'other.example.local'};},
    (items:KubeObject[])=>{items[0]!.metadata.uid='recreated-uid';},
    (items:KubeObject[])=>{items[0]!.metadata.generation=4;},
    (items:KubeObject[])=>{items[0]!.metadata.deletionTimestamp='2026-01-01T00:00:00Z';},
    (items:KubeObject[])=>{items.pop();},
    (items:KubeObject[])=>{items.push({metadata:{name:'another',namespace:'ai-system',uid:'new-uid',generation:1},spec:{module:'another'}});},
  ]) {const changed=structuredClone(before);mutate(changed);expect(moduleIntentSnapshot(changed)).not.toBe(moduleIntentSnapshot(before));}
  for(const broken of [
    [{metadata:{name:'dashboard',namespace:'ai-system',generation:3},spec:{module:'dashboard'}}],
    [{metadata:{name:'dashboard',namespace:'ai-system',uid:'uid',generation:0},spec:{module:'dashboard'}}],
    [{metadata:{name:'dashboard',namespace:'other',uid:'uid',generation:1},spec:{module:'dashboard'}}],
    [...before,before[0]!],
    [{metadata:{name:'dashboard',namespace:'ai-system',uid:'uid',generation:1}}],
  ])expect(()=>moduleIntentSnapshot(broken)).toThrow('[API]');
});

function applicationInputs() {
  const models={activations:[],presets:{small:{variants:[
    {engine:'OLlama',computeTarget:'cpu',url:'ollama://tiny:latest',memoryRequiredMi:2048,contextWindow:2048},
    {engine:'OLlama',computeTarget:'cpu',url:'ollama://long-context:latest',memoryRequiredMi:3072,contextWindow:32768},
  ]}},computeTargets:{targets:[{id:'cpu',available:true,engines:['OLlama'],kvCacheTypes:{OLlama:[{value:'f16',label:'FP16'}]}}]},
    computeMemory:{devices:[{id:'cpu',computeTarget:'cpu',unreservedMi:64000,freeMi:48000}]}} as unknown as ModelsPayload;
  const modules={modules:{},catalogJson:{applications:{hermes:{minimumModelContextTokens:64000},openclaw:{}}}} as ModulesPayload;
  return {models,modules};
}
test('APP-02 selects a small application-specific model using native context and the larger edit RAM estimate',annotation,async()=>{
  const {models,modules}=applicationInputs(),original=structuredClone(models),requests:Array<{url:string;contextWindow:number}>=[];
  const fixture=await applicationModel(models,modules,['hermes','openclaw'],async model=>{
    requests.push({url:model.url,contextWindow:model.contextWindow});
    return {modelMaxContext:model.url.includes('tiny')?32768:262144,contextWindow:model.contextWindow,
      minimumMi:3400,recommendedMi:3601};
  });
  expect(fixture).toMatchObject({url:'ollama://long-context:latest',contextWindow:64256,memoryRequiredMi:3700,maxNumSeqs:1});
  expect(requests).toEqual([{url:'ollama://tiny:latest',contextWindow:2048},
    {url:'ollama://long-context:latest',contextWindow:2048},{url:'ollama://long-context:latest',contextWindow:64256}]);
  expect(models).toEqual(original);
  expect(catalogFixture(models,'OLlama','cpu')).toMatchObject({url:'ollama://tiny:latest',contextWindow:2048,memoryRequiredMi:2048});
  expect(applicationEditContext(modules,['hermes','openclaw'],fixture.contextWindow)).toBe(64000);
  expect(applicationEditContext(modules,['hermes','openclaw'],64000)).toBe(64256);
  expect(()=>applicationEditContext(modules,['hermes'],256)).toThrow('[CONFLICT]');
});
test('APP-02 missing native context or RAM blocks before creating resources; API and inconsistent estimates fail',annotation,async()=>{
  const {models,modules}=applicationInputs();
  for(const modelMaxContext of [undefined,32768,64000])await expect(applicationModel(models,modules,['hermes'],async model=>
    ({modelMaxContext,contextWindow:model.contextWindow,minimumMi:2000,recommendedMi:3000})))
    .rejects.toMatchObject({code:'APPLICATION_MODEL',outcome:'Blocked',stage:'model-estimate'});
  const estimate=async(model:{contextWindow:number}):Promise<MemoryEstimate>=>
    ({modelMaxContext:262144,contextWindow:model.contextWindow,minimumMi:40000,recommendedMi:50000});
  await expect(applicationModel(models,modules,['hermes'],estimate)).rejects.toMatchObject({code:'APPLICATION_MODEL',outcome:'Blocked'});
  await expect(applicationModel(models,modules,['hermes'],async()=>{throw new HarnessError('API');}))
    .rejects.toMatchObject({code:'API',outcome:'Failed',stage:'model-estimate'});
  await expect(applicationModel(models,modules,['hermes'],async()=>({modelMaxContext:262144,contextWindow:2048,minimumMi:1,recommendedMi:2})))
    .rejects.toMatchObject({code:'API',outcome:'Failed'});
  expect(()=>applicationContexts(modules,['missing'])).toThrow('[PREREQUISITE]');
});
test('APP-09 context edits stay within the individually sized application fixture and retain UID/revision fencing',annotation,async()=>{
  const prefix='reg-aabbccddeeff-',name=prefix+'app-model',uid='model-uid';let writes=0;
  const current={metadata:{name,uid,generation:1},spec:{type:'local',enabled:true,local:{contextWindow:64256}}} as import('@magicstick/dashboard-contracts').ModelActivation;
  const request={fetch:async(_url:string,options:{data:string})=>{
    writes++;const body=JSON.parse(options.data);
    expect(body.expectedRevision).toBe('generation:model-uid:1');
    return {status:()=>200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(
      {...current,metadata:{...current.metadata,generation:2},spec:{...current.spec,local:{contextWindow:body.local.contextWindow}}}))};
  }} as unknown as APIRequestContext;
  const fixture={engine:'OLlama' as const,computeTarget:'cpu' as const,url:'ollama://long-context:latest',contextWindow:64256,memoryRequiredMi:4000,maxNumSeqs:1 as const};
  const client=new OwnedModelClient(request,'https://dashboard.example.invalid',1000,name,fixture,prefix,async()=>{});client.adopt(uid);
  expect(await client.editContext(current,64000)).toEqual({uid,generation:2});
  for(const context of [64257,262144,Number.NaN])await expect(client.editContext(current,context)).rejects.toMatchObject({code:'MUTATION'});
  await expect(client.editContext({...current,metadata:{...current.metadata,uid:'foreign'}},64000)).rejects.toMatchObject({code:'OWNERSHIP'});
  const smoke=new OwnedModelClient(request,'https://dashboard.example.invalid',1000,name,{...fixture,contextWindow:2048},prefix,async()=>{});smoke.adopt(uid);
  await expect(smoke.editContext(current,64000)).rejects.toMatchObject({code:'MUTATION'});
  expect(writes).toBe(1);
});
test('APP-02 observes the current controller-owned HelmRelease in the Appliance namespace, never its workload namespace',annotation,async()=>{
  const item:AppInstance={metadata:{name:'hermes-fixture',uid:'instance-uid',generation:3},
    spec:{application:'hermes',enabled:true,targetNamespace:'ai'},status:{phase:'Ready',observedGeneration:3,
      kind:'HelmRelease',name:'hermes-fixture',namespace:'ai-system'}};
  const observed=item as KubeObject,owned={uid:'instance-uid',generation:3};
  const child:KubeObject={metadata:{name:'hermes-fixture',namespace:'ai-system',uid:'release-uid',generation:7,
    labels:{'app.kubernetes.io/managed-by':'magicstick-operator','appliance.magicstick.dev/appinstance':'hermes-fixture',
      'appliance.magicstick.dev/application':'hermes'}},spec:{targetNamespace:'ai',suspend:false},
    status:{observedGeneration:7,conditions:[{type:'Ready',status:'True',observedGeneration:7}]}};
  const namespaces:string[]=[],apps=Object.create(OwnedAppClient.prototype) as OwnedAppClient;
  Object.defineProperties(apps,{owned:{value:new Map([['hermes-fixture',owned]])},read:{value:async()=>item},
    cleaner:{value:{find:async()=>observed}},live:{value:{guard:async()=>{},config:{expected:{applianceNamespace:'ai-system'}},
      observer:{list:async(_resource:string,namespace:string)=>{namespaces.push(namespace);return namespace==='ai-system'?[child]:[];}}}}});
  const ready=await apps.ready('hermes-fixture');
  expect(namespaces).toEqual(['ai-system']);expect(ready.target).toEqual({name:'hermes-fixture',namespace:'ai-system'});
  expect(appReleaseReady(item,observed,[child],owned,'ai-system')).toBe(true);
  for(const patch of [{namespace:'ai'},{name:'another-release'},{kind:'Deployment'}])
    expect(()=>appReleaseTarget({...item,status:{...item.status,...patch}},'hermes-fixture','ai-system')).toThrow('[OWNERSHIP]');
  expect(appReleaseTarget({...item,status:undefined},'hermes-fixture','ai-system').namespace).toBe('ai-system');
  for(const invalid of [{...item,metadata:{...item.metadata,uid:'foreign'}},{...item,metadata:{...item.metadata,generation:4}}])
    expect(()=>appReleaseReady(invalid,observed,[child],owned,'ai-system')).toThrow('[OWNERSHIP]');
  expect(appReleaseReady({...item,status:{...item.status,observedGeneration:2}},observed,[child],owned,'ai-system')).toBe(false);
  for(const change of [
    {...child,metadata:{...child.metadata,namespace:'ai'}},
    {...child,metadata:{...child.metadata,labels:{...child.metadata.labels,'app.kubernetes.io/managed-by':'foreign'}}},
    {...child,metadata:{...child.metadata,labels:{...child.metadata.labels,'appliance.magicstick.dev/application':'openclaw'}}},
    {...child,status:{...child.status,observedGeneration:6,conditions:[{type:'Ready',status:'True',observedGeneration:6}]}},
    {...child,spec:{...child.spec,suspend:true}},
  ])expect(appReleaseReady(item,observed,[change],owned,'ai-system')).toBe(false);
  expect(()=>appReleaseReady({...item,status:{...item.status,phase:'Degraded'}},observed,[child],owned,'ai-system'))
    .toThrow('[stage:app-ready]');
});

test('MOD-06 profile mutation requires physical AMD hardware and bounded exact-revision status readback',annotation,async()=>{
  await expect(moduleProfileWorkflow({config:{gpu:{devices:{nvidia:{id:'node/pci'}}}}} as unknown as LiveFoundation))
    .rejects.toMatchObject({code:'GPU_PROVIDER',outcome:'Blocked',stage:'gpu-backend'});
  const intent:KubeObject={metadata:{uid:'owned-module',generation:2},spec:{enabled:true,module:'amd-gpu',
    parameters:{compatibilityProfile:'',allowExperimental:'false',gpuSharing:'unchanged-sharing'}},status:{observedGeneration:2}};
  const stale={schemaVersion:1,profiles:[],nodes:[],selectedProfile:'strix-halo',allowExperimental:true};
  const current={...stale,selectedProfile:'',allowExperimental:false};
  let reads=0;
  await expect(waitModuleProfileReadback(async()=>({intent,compatibility:++reads===1?stale:current}),intent,{timeoutMs:2000}))
    .resolves.toEqual({intent,compatibility:current});
  expect(reads).toBe(2);
  for(const compatibility of [undefined,stale,{...current,allowExperimental:undefined}])
    await expect(waitModuleProfileReadback(async()=>({intent,compatibility}),intent,{timeoutMs:5}))
      .rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'module-ready'});
  await expect(waitModuleProfileReadback(async()=>({intent:{...intent,status:{observedGeneration:1}},compatibility:current}),intent,{timeoutMs:5}))
    .rejects.toMatchObject({code:'DEADLINE',stage:'module-ready'});
  for(const changed of [{...intent,metadata:{...intent.metadata,uid:'foreign'}},
    {...intent,metadata:{...intent.metadata,generation:3}},
    {...intent,metadata:{...intent.metadata,deletionTimestamp:'2026-10-24T16:00:00Z'}},
    {...intent,spec:{...intent.spec,parameters:{compatibilityProfile:'',allowExperimental:'false',gpuSharing:'foreign-sharing'}}}])
    await expect(waitModuleProfileReadback(async()=>({intent:changed,compatibility:current}),intent))
      .rejects.toMatchObject({code:'CONFLICT',outcome:'Failed'});
  reads=0;
  await expect(waitModuleProfileReadback(async()=>{reads++;throw new HarnessError('API','Failed');},intent))
    .rejects.toMatchObject({code:'API',outcome:'Failed'});
  expect(reads).toBe(1);
  await expect(waitModuleProfileReadback(async()=>({intent,compatibility:stale}),intent,{timeoutMs:5,stage:'recovery-module'}))
    .rejects.toMatchObject({code:'DEADLINE',stage:'recovery-module'});
});
test('HAR-10 license UI protection allows bodyless polling but rejects unrelated and stale writes',annotation,()=>{
  const document='synthetic-license',revision='synthetic-revision',origin='https://dashboard.example.local';
  const allowed=(method:string,path:string,body:unknown,activate=true)=>Boolean(allowedExactDashboardRequest(new URL(origin+path),method,body,origin,licenseUiPermits(document,revision,activate)));
  expect(allowedAdministrationRead(new URL(origin+'/api/license'),origin)).toBe(true);
  expect(allowed('POST','/api/license/validate',{document})).toBe(true);
  expect(allowed('PUT','/api/license',{document,expectedRevision:revision})).toBe(true);
  expect(allowed('PUT','/api/license',{document,expectedRevision:revision},false)).toBe(false);
  for(const [method,path,body] of [['PUT','/api/license',null],['POST','/api/license',{document}],
    ['PUT','/api/license',{document:'other',expectedRevision:revision}],['PUT','/api/license',{document,expectedRevision:'old'}],
    ['PUT','/api/license',{document,expectedRevision:revision,unexpected:true}],
    ['DELETE','/api/license',null],['POST','/api/license/validate',[]]] as const)
    expect(allowed(method,path,body)).toBe(false);
});
test('HAR-10 administration reads ignore flattened session cookies and retain HTTP failures',annotation,async()=>{
  let status=200;
  const request={fetch:async()=>({status:()=>status,headers:()=>({'content-type':'application/json',
    'set-cookie':'synthetic-session=one; HttpOnly\nsynthetic-session=two; HttpOnly'}),
    body:async()=>Buffer.from(JSON.stringify(status===200?{modules:{},catalogJson:{modules:{}}}:{error:'denied'}))})} as unknown as APIRequestContext;
  const api=new AdministrationApi(request,'https://dashboard.example.invalid',1000,async()=>{});
  expect((await api.api.modules()).modules).toEqual({});
  status=403;
  await expect(atStage('baseline-models',()=>api.api.modules())).rejects.toThrow('[stage:baseline-models]');
  await expect(api.write({method:'POST',path:'/api/modules/fixture/enable',body:{}},()=>api.api.enableModule('fixture')))
    .rejects.toMatchObject({status:403});
});
test('HAR-10 a durable forward receipt runs only after the guard and before the exact API write',annotation,async()=>{
  for(const fault of ['none','guard','receipt'] as const) {
    const events:string[]=[];
    const request={fetch:async()=>{events.push('send');return {status:()=>200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from('{}')};}} as unknown as APIRequestContext;
    const api=new AdministrationApi(request,'https://dashboard.example.invalid',1000,async()=>{events.push('guard');if(fault==='guard')throw new HarnessError('LOCK_LOST');});
    const action=api.write({method:'PUT',path:'/api/license',body:{document:'synthetic',expectedRevision:'1'}},()=>api.api.importLicense('synthetic','1'),
      async()=>{events.push('receipt');if(fault==='receipt')throw new HarnessError('PRIVATE_FILE');});
    if(fault==='none'){await action;expect(events).toEqual(['guard','receipt','send']);}
    else{await expect(action).rejects.toBeInstanceOf(HarnessError);expect(events).toEqual(fault==='guard'?['guard']:['guard','receipt']);}
  }
});

test('SEC-04 shipped permissions include recursively referenced regression and log roles, not an obsolete file list',annotation,async()=>{
  const rbac=await shippedDashboardRbac();
  const roles=rbac.filter(item=>item.kind==='Role');
  expect(roles.some(item=>item.metadata.name==='dashboard-regression-intent' && item.metadata.namespace==='ai-system' &&
    item.rules?.some(r=>r.resources?.includes('regressionruns')))).toBe(true);
  expect(roles.some(item=>item.metadata.name==='dashboard-model-log-ownership'&&item.metadata.namespace==='ai'&&
    item.rules?.some(r=>r.apiGroups?.some(group=>group==='kubeai.org')&&r.resources?.includes('models')))).toBe(true);
  const expected=normalizeRules(roles[0]!.rules!);
  expect(normalizeRules([...roles[0]!.rules!,{apiGroups:[''],resources:['secrets'],verbs:['get']}])).not.toEqual(expected);
  const enabled=await shippedDashboardRbac(undefined,{modules:{regression:{enabled:true}},catalogJson:{modules:{
    regression:{path:'magic-cluster/apps/regression'}}}});
  const disabled=await shippedDashboardRbac(undefined,{modules:{regression:{enabled:false}},catalogJson:{modules:{
    regression:{path:'magic-cluster/apps/regression'}}}});
  expect(enabled.filter(item=>item.kind==='RoleBinding').length).toBe(rbac.filter(item=>item.kind==='RoleBinding').length+1);
  expect(enabled.some(item=>item.kind==='Role' && item.metadata.name==='dashboard-regression-credentials' &&
    item.metadata.namespace==='magicstick-regression')).toBe(true);
  expect(disabled).toEqual(rbac);
  const source=await readFile(resolve('../../..','magic-cluster/platform/magicstick-operator/module-catalog.yaml'),'utf8');
  const catalog=JSON.parse(execFileSync('python3',['-c',
    'import sys,yaml; print(yaml.safe_load(sys.stdin.read())["data"]["modules.json"])'],{input:source,encoding:'utf8',timeout:5000}));
  const every=await shippedDashboardRbac(undefined,{catalogJson:catalog,modules:Object.fromEntries(
    Object.keys(catalog.modules).map(id=>[id,{enabled:true}]))});
  expect(every.filter(item=>item.kind==='RoleBinding').length).toBeGreaterThanOrEqual(enabled.filter(item=>item.kind==='RoleBinding').length);
});
test('HAR-10 app context proof rejects partial/stale/malformed generated consumer configurations',annotation,()=>{
  const name='reg-fixture',context=512;
  const data={
    'catalog.json':JSON.stringify({hash:'a'.repeat(16),models:[{id:name,contextWindow:context}]}),
    'openclaw.json':JSON.stringify({models:{providers:{litellm:{models:[{id:name,contextWindow:context}]}}}}),
    'hermes.yaml':JSON.stringify({providers:{litellm:{models:{[name]:{context_length:context}}}}}),
    'opencode-providers.json':JSON.stringify({litellm:{models:{[name]:{limit:{context}}}}}),
    'paperclip-opencode-providers.json':JSON.stringify({litellm:{models:{[name]:{limit:{context:384,output:64}}}}}),
  };
  expect(catalogContext(data,name,context)).toBe(true);
  expect(catalogContext(data,name,256)).toBe(false);
  for(const key of Object.keys(data))expect(catalogContext({...data,[key]:'{}'},name,context)).toBeFalsy();
  expect(catalogContext({...data,'catalog.json':'malformed'},name,context)).toBeFalsy();
});
const host:ManagedHost={name:'fixture-node',nodeUid:'fixture-uid',bootId:'fixture-boot',kernel:'fixture-kernel',available:true,message:'Fixture',
  gpuMemory:{id:'a'.repeat(64),supported:true,message:'Fixture',currentCarveoutMi:512}};
const drill=()=>({caseId:'GPUHOST-05',acknowledgeDisruption:true,independentRecoveryAvailable:true,
  request:{action:'configure-gpu-memory',nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,confirmation:host.name,
    acknowledgeDisruption:true,planId:'a'.repeat(64),gpuMemory:{carveoutIndex:9,dynamicLimitMi:98304}},
  expected:{bootChanges:1,kernel:'fixture-kernel',carveoutMi:512,dynamicLimitMi:98304,terminal:'Succeeded'}});

test('HAR-10 physical drills reject stale identity, implicit consent, arbitrary commands and invalid outcomes',annotation,()=>{
  expect(parseHostDrill(drill(),'GPUHOST-05',host).caseId).toBe('GPUHOST-05');
  for(const patch of [{nodeUid:'other'},{bootId:'new-boot'},{confirmation:'wrong'},{action:'shutdown'},{command:'arbitrary'}])
    expect(()=>parseHostDrill({...drill(),request:{...drill().request,...patch}},'GPUHOST-05',host)).toThrow();
  for(const patch of [{acknowledgeDisruption:false},{independentRecoveryAvailable:false},{caseId:'BOOT-02'},
    {expected:{...drill().expected,bootChanges:0}},{expected:{...drill().expected,sourceCommit:'short'}}])
    expect(()=>parseHostDrill({...drill(),...patch},'GPUHOST-05',host)).toThrow();
  expect(()=>parseHostDrill(drill(),'GPUHOST-05',{...host,available:false})).toThrow();
  expect(remainingIds('phase6-drill','BOOT-02')).toEqual(['BOOT-02']);
  expect(remainingRequirements('phase6-drill','BOOT-02')?.every(item=>['A','E','O','N'].includes(item.layer))).toBe(true);
  expect(hostDrillIds).not.toContain('CACHE-07');
  expect(()=>remainingIds('phase6-drill','SEC-01')).toThrow();
});

test('HAR-10 native companion proof is commit/platform/format bound and is not mesh inference proof',annotation,()=>{
  const revision='a'.repeat(40),proof={version:1,platform:'linux-x64',sourceRevision:revision,archiveSha256:'b'.repeat(64),
    launchCheck:{version:1,platform:'linux',launcherVerified:true,transportVerified:true,loopbackAuthVerified:true,
      inferenceAuthorityVerified:true,originHostVerified:true,isolatedStateVerified:true,meshInferenceVerified:false}};
  expect(validCompanionReport(proof,'linux-x64',revision)).toBe(true);
  expect(validCompanionReport(proof,'unknown',revision)).toBe(false);
  expect(validCompanionReport(proof,'linux-x64','c'.repeat(40))).toBe(false);
  for(const patch of [{archiveSha256:'short'},{launchCheck:{...proof.launchCheck,loopbackAuthVerified:false}},
    {launchCheck:{...proof.launchCheck,meshInferenceVerified:true}},{launchCheck:{...proof.launchCheck,platform:'win32'}}])
    expect(validCompanionReport({...proof,...patch},'linux-x64',revision)).toBe(false);
});

function publicCompanionFixture() {
  const revision='a'.repeat(40),run={id:123,run_attempt:2,head_sha:revision,event:'workflow_dispatch',
    path:'.github/workflows/build-mesh-companion.yml',status:'completed',conclusion:'success',updated_at:new Date().toISOString(),
    repository:{full_name:'QualityMinds/AIppliance-Magic-Stick'}};
  const reports=Object.entries({'macos-arm64':'darwin','macos-x64':'darwin','linux-x64':'linux','windows-x64':'win32'})
    .map(([platform,native])=>({version:1,platform,sourceRevision:revision,archiveSha256:'b'.repeat(64),
      launchCheck:{version:1,platform:native,launcherVerified:true,transportVerified:true,loopbackAuthVerified:true,
        inferenceAuthorityVerified:true,originHostVerified:true,isolatedStateVerified:true,meshInferenceVerified:false}}));
  const check={name:companionAcceptanceCheck,head_sha:revision,external_id:'123:2',app:{slug:'github-actions'},
    details_url:'https://github.com/QualityMinds/AIppliance-Magic-Stick/actions/runs/123',status:'completed',conclusion:'success',
    output:{text:JSON.stringify({version:1,runId:123,runAttempt:2,sourceRevision:revision,reports})}};
  return {revision,run,reports,check};
}
test('MESH-09 automatic discovery prefers the readable trusted proof over a newer PR artifact build',
  evidenceAnnotations({id:'MESH-09',variant:'p7-mesh-09',layer:'C'}),async()=>{
  const {revision,run,reports,check}=publicCompanionFixture();
  const newer={...run,id:999,event:'pull_request'},requests:number[]=[];
  const artifacts=async(id:number)=>{requests.push(id);return {artifacts:reports.map(report=>({
    name:'companion-acceptance-'+report.platform,expired:false}))};};
  expect(await discoverCompanionRun([newer,run],{check_runs:[check]},revision,artifacts)).toEqual(run);
  expect(requests).toEqual([run.id]);
  expect(await discoverCompanionRun([newer],{check_runs:[check]},revision,artifacts)).toBeUndefined();
  expect(await discoverCompanionRun([newer],{check_runs:[]},revision,artifacts,true)).toEqual(newer);
  requests.length=0;
  expect(await discoverCompanionRun([newer,run],{check_runs:[check]},revision,artifacts,true)).toEqual(run);
  expect(requests).toEqual([run.id]);
});
test('MESH-09 automatic discovery rejects missing attempt proof and expired or ambiguous platform artifacts',
  evidenceAnnotations({id:'MESH-09',variant:'p7-mesh-09',layer:'C'}),async()=>{
  const {revision,run,reports,check}=publicCompanionFixture();
  const complete=reports.map(report=>({name:'companion-acceptance-'+report.platform,expired:false}));
  expect(await discoverCompanionRun([run],{check_runs:[]},revision,async()=>({artifacts:complete}))).toBeUndefined();
  for(const artifacts of [complete.slice(0,3),[...complete,complete[0]],complete.map((v,i)=>i?v:{...v,expired:true})])
    expect(await discoverCompanionRun([run],{check_runs:[check]},revision,async()=>({artifacts}))).toBeUndefined();
  await expect(discoverCompanionRun([run],{check_runs:[{...check,head_sha:'c'.repeat(40)}]},revision,
    async()=>({artifacts:complete}))).rejects.toThrow('[REVISION]');
});
test('MESH-09 public native proof requires the exact GitHub workflow attempt and every verified platform',
  evidenceAnnotations({id:'MESH-09',variant:'p7-mesh-09',layer:'C'}),()=>{
  const {revision,run,reports,check}=publicCompanionFixture();
  expect(publicCompanionProof({check_runs:[check]},run,revision)).toHaveLength(4);
  expect(publicCompanionProof({check_runs:[]},run,revision)).toBeUndefined();
  for(const patch of [{head_sha:'c'.repeat(40)},{app:{slug:'foreign'}},{status:'in_progress'},{conclusion:'failure'},
    {details_url:'https://example.invalid/run/123'}])
    expect(()=>publicCompanionProof({check_runs:[{...check,...patch}]},run,revision)).toThrow('[REVISION]');
  for(const altered of [reports.slice(0,3),[...reports.slice(0,3),reports[0]],
    reports.map((r,i)=>i? r:{...r,launchCheck:{...r.launchCheck,originHostVerified:false}})])
    expect(()=>publicCompanionProof({check_runs:[{...check,output:{text:JSON.stringify({version:1,runId:123,runAttempt:2,sourceRevision:revision,reports:altered})}}]},run,revision)).toThrow();
  expect(()=>publicCompanionProof({check_runs:[{...check,output:{text:'private-invalid-json'}}]},run,revision)).toThrow('[API]');
});

test('MESH-09 accepts the canonical check-ID URL returned by GitHub Actions but not foreign or mismatched links',
  evidenceAnnotations({id:'MESH-09',variant:'p7-mesh-09',layer:'C'}),async()=>{
  const {revision,run,reports,check}=publicCompanionFixture();
  const url='https://github.com/QualityMinds/AIppliance-Magic-Stick/runs/456';
  const actual={...check,id:456,details_url:url,html_url:url};
  expect(publicCompanionProof({check_runs:[actual]},run,revision)).toHaveLength(4);
  expect(await discoverCompanionRun([run],{check_runs:[actual]},revision,async()=>({artifacts:reports.map(report=>({
    name:'companion-acceptance-'+report.platform,expired:false}))}))).toEqual(run);
  for(const patch of [{id:457},{id:0},{id:'456'},{id:456.5},{html_url:url+'?untrusted'},
    {details_url:url+'/extra'}, {details_url:'https://example.invalid/runs/456'},
    {details_url:url.replace('QualityMinds','Other')},{app:{slug:'foreign'}}])
    expect(()=>publicCompanionProof({check_runs:[{...actual,...patch}]},run,revision)).toThrow('[REVISION]');
  expect(publicCompanionProof({check_runs:[{...actual,external_id:'123:1'}]},run,revision)).toBeUndefined();
});

test('MESH-09 anonymous workflow proof needs no artifact token; legacy access blocks without a doomed ZIP request',
  evidenceAnnotations({id:'MESH-09',variant:'p7-mesh-09',layer:'C'}),async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-companion-proof-'));
  const oldProfile=process.env.REGRESSION_REMAINING_PROFILE,oldRun=process.env.REGRESSION_RUN_DIR;
  try {
    const {revision,run,check}=publicCompanionFixture();await privateDirectory(directory);
    const file=join(directory,'profile.json');await writePrivate(file,{companion:{runId:123,sourceRevision:revision}});
    process.env.REGRESSION_REMAINING_PROFILE=file;process.env.REGRESSION_RUN_DIR=directory;
    const requests:string[]=[];let publicProof=true;
    const live={config:{requestTimeoutMs:1000,expected:{flux:{revision:'branch@sha1:'+revision}}},context:{request:{get:async(url:string,options:any)=>{
      requests.push(url);expect(options.headers).not.toHaveProperty('Authorization');
      const data=url.includes('/check-runs?')?{check_runs:publicProof?[check]:[]}:run;
      return {status:()=>200,body:async()=>Buffer.from(JSON.stringify(data)),json:async()=>data};
    }}}} as unknown as LiveFoundation;
    await companionWorkflow(live);
    expect(JSON.parse(await readPrivate(join(directory,'companion-acceptance.json')))).toMatchObject({proofSource:'github-check',meshInferenceVerified:false});
    publicProof=false;
    await expect(companionWorkflow(live)).rejects.toMatchObject({code:'CI_ACCESS',outcome:'Blocked',stage:'companion-evidence'});
    expect(requests.some(url=>url.includes('/zip')||url.includes('/artifacts'))).toBe(false);
  }finally {
    if(oldProfile===undefined)delete process.env.REGRESSION_REMAINING_PROFILE;else process.env.REGRESSION_REMAINING_PROFILE=oldProfile;
    if(oldRun===undefined)delete process.env.REGRESSION_RUN_DIR;else process.env.REGRESSION_RUN_DIR=oldRun;
    await rm(directory,{recursive:true,force:true});
  }
});

test('HAR-10 online security evidence cannot use stale, pending, wrong-repo or wrong-commit CI',annotation,()=>{
  const now=Date.now(),revision='a'.repeat(40),path='.github/workflows/dependency-security.yml';
  const proof={path,head_sha:revision,status:'completed',conclusion:'success',updated_at:new Date(now).toISOString(),
    repository:{full_name:'QualityMinds/AIppliance-Magic-Stick'}};
  expect(currentSecurityCiRun(proof,path,revision,now)).toBe(true);
  for(const patch of [{head_sha:'b'.repeat(40)},{status:'in_progress'},{conclusion:'failure'},
    {repository:{full_name:'other/repo'}},{path:'other.yml'},{updated_at:new Date(now+1000).toISOString()},
    {updated_at:new Date(now-9*86400_000).toISOString()}])expect(currentSecurityCiRun({...proof,...patch},path,revision,now)).toBe(false);
});

test('HAR-10 observer/cleaner/RBAC checks reject wildcard and Secret/workload authority',annotation,()=>{
  expect(ordinaryDashboardRules([{apiGroups:['apps'],resources:['deployments'],verbs:['get','list']}])).toBe(true);
  for(const rule of [{resources:['secrets'],verbs:['get']},{resources:['*'],verbs:['get']},{resources:['pods'],verbs:['*']}])
    expect(ordinaryDashboardRules([rule])).toBe(false);
  expect(normalizeRules([{apiGroups:['b','a'],resources:['pods'],verbs:['list','get']}])).toEqual(normalizeRules([{verbs:['get','list'],resources:['pods'],apiGroups:['a','b']}]));
  const review={status:{incomplete:false,resourceRules:[{apiGroups:['appliance.magicstick.dev'],resources:['appinstances'],verbs:['get','list','delete']}]}};
  verifyAppCleanerRules(review);
  for(const patch of [{apiGroups:['*']},{resources:['secrets']},{verbs:['create','delete']},{resources:['appinstances','modelactivations']}])
    expect(()=>verifyAppCleanerRules({status:{...review.status,resourceRules:[{...review.status.resourceRules[0]!,...patch}]}})).toThrow();
});

test('HAR-10 kubeconfig permits only typed PKCE exec metadata and verified cluster TLS',annotation,()=>{
  const ca=Buffer.from('-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----').toString('base64');
  const user={exec:{command:'kubectl',apiVersion:'client.authentication.k8s.io/v1',args:['oidc-login','get-token',
    '--oidc-issuer-url=https://identity.example.invalid/realms/fixture','--oidc-client-id=fixture','--oidc-pkce-method=S256',
    '--certificate-authority-data='+ca,'--token-cache-storage=keyring']}};
  const config={apiVersion:'v1',kind:'Config',clusters:[{name:'fixture',cluster:{server:'https://cluster.example.invalid','certificate-authority-data':ca}}],
    users:[{name:'fixture',user}],contexts:[{name:'fixture',context:{cluster:'fixture',user:'fixture'}}],'current-context':'fixture'};
  expect(inspectOidcConfig(config,'https://identity.example.invalid').client).toBe('fixture');
  expect(()=>inspectOidcConfig({...config,users:[{name:'fixture',user:{...user,token:'fixture-secret'}}]},'https://identity.example.invalid')).toThrow();
  expect(()=>inspectOidcConfig(config,'https://other.example.invalid')).toThrow();
  expect(()=>inspectOidcConfig({...config,clusters:[{name:'fixture',cluster:{...config.clusters[0]!.cluster,'insecure-skip-tls-verify':true}}]},'https://identity.example.invalid')).toThrow();
});

test('HAR-10 app fixtures are finite HTTPS UI oracles, not arbitrary application or URL inventory',annotation,()=>{
  const fixtures=['openclaw','hermes','paperclip','kubeopencode','odysseus'].map(type=>({type,originTemplate:'https://{name}.'+type+'.example.invalid',
    promptLabel:'Prompt',sendButton:'Send',responseSelector:'[data-role=response]',responseMarker:'REGRESSION'}));
  expect(validateAppFixtures(fixtures)).toHaveLength(5);
  expect(()=>validateAppFixtures(fixtures.slice(1))).toThrow();
  expect(()=>validateAppFixtures([...fixtures.slice(1),fixtures[1]])).toThrow();
  expect(()=>validateAppFixtures([{...fixtures[0],originTemplate:'http://{name}.example.invalid'},...fixtures.slice(1)])).toThrow();
  const terminal={type:'hermes',originTemplate:'https://{name}.hermes.example.invalid/',adapter:'hermes-terminal-v1',responseMarker:'REGRESSION'};
  expect(validateAppFixtures([terminal])).toEqual([terminal]);
  const opencode={type:'kubeopencode',originTemplate:'https://{name}.kubeopencode.example.invalid/',adapter:'opencode-chat-v1',responseMarker:'REGRESSION'};
  expect(validateAppFixtures([opencode])).toEqual([opencode]);
  expect(()=>validateAppFixtures([{...opencode,type:'hermes'}])).toThrow('[CONFIG]');
  expect(openCodeChatPath).toBe('/L3dvcmtzcGFjZQ/session');
  const requestUrl='https://opencode.example.invalid/session/ses_fixture/prompt_async?directory=%2Fworkspace';
  const nativeMarker='REGRESSION_fresh',nativePrompt='Reply with exactly '+nativeMarker;
  const nativeBody={messageID:'msg_prompt',model:{providerID:'litellm',modelID:'reg-model'},parts:[{type:'text',text:nativePrompt}]};
  const nativeTurn={sessionId:'ses_fixture',messageId:'msg_prompt',model:'reg-model',prompt:nativePrompt,marker:nativeMarker};
  const nativeReply={info:{id:'msg_response',sessionID:'ses_fixture',parentID:'msg_prompt',role:'assistant',providerID:'litellm',
    modelID:'reg-model',time:{created:1,completed:2},finish:'stop'},parts:[{type:'text',text:nativeMarker,sessionID:'ses_fixture',messageID:'msg_response'}]};
  const nativeProof=new OpenCodeChatEvidence('https://opencode.example.invalid','reg-model');
  expect(nativeProof.snapshot().composerReady).toBe(false);nativeProof.ready();
  expect(nativeProof.begin(nativeMarker)).toBe(nativePrompt);nativeProof.submit(requestUrl,'POST',nativeBody);
  nativeProof.acknowledge(requestUrl,'POST',204);expect(nativeProof.accepted()).toBe(true);
  expect(new URL(nativeProof.messageUrl()).pathname).toBe('/session/ses_fixture/message');
  expect(nativeProof.observe([nativeReply])).toBe(true);nativeProof.renderedResponse();
  expect(nativeProof.snapshot()).toEqual({composerReady:true,submitted:true,acknowledged:true,completed:true,rendered:true,failed:false});
  const headerProof=new OpenCodeChatEvidence('https://opencode.example.invalid','reg-model');headerProof.begin(nativeMarker);
  headerProof.submit(requestUrl.split('?')[0]!,'POST',nativeBody,{directory:encodeURIComponent('/workspace'),workspace:'owned-workspace'});
  headerProof.acknowledge(requestUrl.split('?')[0]!,'POST',204);expect(headerProof.accepted()).toBe(true);
  expect(new URL(headerProof.messageUrl()).searchParams.get('workspace')).toBe('owned-workspace');
  for(const scope of [{directory:'/foreign'},{directory:encodeURIComponent('/foreign')},{workspace:'../foreign'}]) {
    const proof=new OpenCodeChatEvidence('https://opencode.example.invalid','reg-model');proof.begin(nativeMarker);
    expect(()=>proof.submit(requestUrl,'POST',nativeBody,scope)).toThrow('[MUTATION]');
  }
  for(const bad of [{...nativeBody,model:{...nativeBody.model,modelID:'foreign-model'}},
    {...nativeBody,model:{...nativeBody.model,providerID:'external'}},{...nativeBody,noReply:true},
    {...nativeBody,messageID:'../foreign'}, {...nativeBody,parts:[{type:'text',text:'other prompt'}]},
    {...nativeBody,parts:[...nativeBody.parts,{type:'file',url:'https://foreign.invalid'}]}]) {
    const proof=new OpenCodeChatEvidence('https://opencode.example.invalid','reg-model');proof.begin(nativeMarker);
    expect(()=>proof.submit(requestUrl,'POST',bad)).toThrow('[MUTATION]');
  }
  for(const address of [requestUrl.replace('opencode.example.invalid','foreign.example.invalid'),requestUrl.replace('%2Fworkspace','%2Fforeign'),
    requestUrl+'&token=synthetic',requestUrl.replace('ses_fixture','..')]) {
    const proof=new OpenCodeChatEvidence('https://opencode.example.invalid','reg-model');proof.begin(nativeMarker);
    expect(()=>proof.submit(address,'POST',nativeBody)).toThrow('[MUTATION]');
  }
  expect(()=>nativeProof.submit(requestUrl,'POST',nativeBody)).toThrow('[MUTATION]');
  for(const response of [{...nativeReply,info:{...nativeReply.info,sessionID:'foreign'}},
    {...nativeReply,info:{...nativeReply.info,modelID:'foreign'}}, {...nativeReply,info:{...nativeReply.info,providerID:'external'}},
    {...nativeReply,info:{...nativeReply.info,error:{name:'synthetic'}}}, {...nativeReply,info:{...nativeReply.info,finish:'length'}},
    {...nativeReply,parts:[{...nativeReply.parts[0],text:nativePrompt}]}, {...nativeReply,parts:[{...nativeReply.parts[0],synthetic:true}]},
    {...nativeReply,parts:[{...nativeReply.parts[0],ignored:true}]}, {...nativeReply,parts:[{...nativeReply.parts[0],messageID:'foreign'}]}])
    expect(()=>completedOpenCodeTurn([response],nativeTurn)).toThrow();
  for(const response of [{...nativeReply,info:{...nativeReply.info,parentID:'old-prompt'}},
    {...nativeReply,info:{...nativeReply.info,role:'user'}}, {...nativeReply,info:{...nativeReply.info,time:{created:1}}},
    {...nativeReply,info:{...nativeReply.info,finish:'tool-calls'}}])
    expect(completedOpenCodeTurn([response],nativeTurn)).toBe(false);
  expect(()=>completedOpenCodeTurn([nativeReply,nativeReply],nativeTurn)).toThrow('[API]');
  expect(()=>validateAppFixtures([{...terminal,type:'openclaw'}])).toThrow('[CONFIG]');
  expect(()=>validateAppFixtures([{...terminal,adapter:'unreviewed'}])).toThrow('[CONFIG]');
  expect(()=>validateAppFixtures([{...terminal,responseMarker:'arbitrary prompt with spaces'}])).toThrow('[CONFIG]');
  const wire=(type:string,seq:number,payload?:unknown,session_id='root')=>JSON.stringify({jsonrpc:'2.0',method:'event',params:{type,seq,session_id,payload}});
  const model='reg-fixture-model',marker='REGRESSION_fresh',origin='https://hermes.example.invalid';
  const prepared=()=>{
    const proof=new HermesTerminalEvidence(origin,model);
    expect(proof.open('wss://hermes.example.invalid/api/ws?token=private-token')).toBeUndefined();
    expect(proof.open('wss://foreign.example.invalid/api/events?channel=owned')).toBeUndefined();
    expect(proof.open('ws://hermes.example.invalid/api/events?channel=owned')).toBeUndefined();
    const pty=proof.open('wss://hermes.example.invalid/api/pty?channel=owned&token=private-token')!;
    const feed=proof.open('wss://hermes.example.invalid/api/events?channel=owned&ticket=private-ticket')!;
    proof.received(feed,wire('session.info',1,{model,lazy:true}));expect(proof.ready()).toBe(true);
    const prompt=proof.begin(marker);
    for(const character of prompt)proof.sent(pty,character);
    proof.sent(pty,'\r');
    return {proof,pty,feed,prompt};
  };
  const live=(current:ReturnType<typeof prepared>)=>{
    current.proof.received(current.feed,wire('session.info',2,{model,provider:'custom:litellm',version:'synthetic'}));
    current.proof.received(current.feed,wire('message.start',3));
  };
  const success=prepared();live(success);
  success.proof.received(success.feed,wire('message.complete',4,{status:'complete',text:marker},'foreign-session'));
  success.proof.received(success.feed,wire('message.complete',1,{status:'complete',text:marker}));
  expect(success.proof.complete()).toBe(false);
  success.proof.received(success.feed,wire('message.complete',4,{status:'complete',text:marker}));
  expect(success.proof.complete()).toBe(true);expect(success.proof.expectedCopy()).toBe(marker);
  success.proof.copiedResponse();expect(success.proof.snapshot()).toMatchObject({agent:true,submitted:true,started:true,completed:true,copied:true,failed:false});
  expect(JSON.stringify(success.proof.snapshot())).not.toMatch(/private-token|private-ticket|root|reg-fixture-model/);
  for(const result of [{status:'interrupted',text:marker},{status:'error',text:marker},{text:marker},
    {status:'complete',partial:true,text:marker},{status:'complete',error:'synthetic',text:marker},
    {status:'complete',failure_reason:'synthetic',text:marker},{status:'complete',text:'stale answer'},
    {status:'complete',text:'Reply with exactly '+marker}]) {
    const current=prepared();live(current);current.proof.received(current.feed,wire('message.complete',4,result));
    expect(()=>current.proof.complete()).toThrow('[API]');
  }
  const lazy=prepared();lazy.proof.received(lazy.feed,wire('message.start',2));
  lazy.proof.received(lazy.feed,wire('message.complete',3,{status:'complete',text:marker}));
  expect(()=>lazy.proof.complete()).toThrow('[API]');
  const noStart=prepared();noStart.proof.received(noStart.feed,wire('message.complete',4,{status:'complete',text:marker}));
  expect(()=>noStart.proof.complete()).toThrow('[API]');
  for(const info of [{model:'foreign-model',provider:'custom:litellm',version:'synthetic'},
    {model,provider:'external-provider',version:'synthetic'},{model,provider:'custom:litellm',version:'synthetic',credential_warning:'synthetic'}]) {
    const current=prepared();current.proof.received(current.feed,wire('session.info',2,info));
    expect(()=>current.proof.complete()).toThrow('[API]');
  }
  for(const damage of ['closed','reconnected','malformed','oversize','sequence'] as const) {
    const current=prepared();live(current);
    if(damage==='closed')current.proof.close(current.pty);
    if(damage==='reconnected')current.proof.open('wss://hermes.example.invalid/api/pty?channel=replacement');
    if(damage==='malformed')current.proof.received(current.feed,'not json');
    if(damage==='oversize')current.proof.received(current.feed,'x'.repeat(1024*1024+1));
    if(damage==='sequence')current.proof.received(current.feed,wire('message.complete',NaN,{status:'complete',text:marker}));
    expect(()=>current.proof.complete()).toThrow('[API]');
  }
  const otherChannel=new HermesTerminalEvidence(origin,model);
  otherChannel.open('wss://hermes.example.invalid/api/pty?channel=owned');
  const foreignFeed=otherChannel.open('wss://hermes.example.invalid/api/events?channel=foreign')!;
  otherChannel.received(foreignFeed,wire('session.info',1,{model,provider:'custom:litellm',version:'synthetic'}));
  expect(otherChannel.ready()).toBe(false);
  const unsent=new HermesTerminalEvidence(origin,model);
  unsent.open('wss://hermes.example.invalid/api/pty?channel=owned');
  const feed=unsent.open('wss://hermes.example.invalid/api/events?channel=owned')!;
  unsent.received(feed,wire('session.info',1,{model,provider:'custom:litellm',version:'synthetic'}));unsent.begin(marker);
  unsent.received(feed,wire('message.start',2));unsent.received(feed,wire('message.complete',3,{status:'complete',text:marker}));
  expect(unsent.complete()).toBe(false);
});

test('HAR-10 Realtime frames are masked, bounded and reject malformed/extended server messages',annotation,()=>{
  const payload=Buffer.from('fixture'),frame=websocketFrame(payload),mask=frame.subarray(2,6);
  expect(frame[0]).toBe(0x81);expect(frame[1]!&0x80).toBe(0x80);
  const decoded=Buffer.from(frame.subarray(6));decoded.forEach((byte,index)=>{decoded[index]=byte^mask[index%4]!;});expect(decoded.equals(payload)).toBe(true);
  const server=Buffer.concat([Buffer.from([0x81,payload.length]),payload]);
  expect(websocketEvent(server)?.payload.equals(payload)).toBe(true);
  expect(websocketEvent(server.subarray(0,4))).toBeUndefined();
  for(const first of [0x41,0x01])expect(()=>websocketEvent(Buffer.from([first,0]))).toThrow();
  expect(()=>websocketEvent(Buffer.from([0x81,0x80]))).toThrow();
  expect(()=>websocketEvent(Buffer.from([0x81,127]))).toThrow();
  expect(()=>websocketFrame(Buffer.alloc(65536))).toThrow();
});
