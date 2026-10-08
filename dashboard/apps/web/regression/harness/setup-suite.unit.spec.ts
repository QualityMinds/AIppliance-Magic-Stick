import {test,expect,type APIRequestContext} from '@playwright/test';
import {createHash,createPublicKey,verify} from 'node:crypto';
import type {ManagedHost,ModelsPayload,ModulesPayload,SystemStatusPayload} from '@magicstick/dashboard-contracts';
import type {LabConfig} from '../core/config.ts';
import {savedSetupOptions,suiteInventory,verifyHostContinuation,type SetupConsent} from '../core/setup-suite.ts';
import type {PreparationOptions,PreparationSnapshot} from '../core/input-preparation.ts';
import {createTestLicenseSigner,testLicenseDocument,validateTestLicenseSigner} from '../core/test-license-fixtures.ts';
import {materializeHostDrill,recipeBundle} from '../core/host-drill-recipes.ts';
import {disposableUnmanagedKey,UnmanagedKeyFixtureClient,verifyUnmanagedKey} from '../core/unmanaged-key-fixture.ts';
import {licenseDocumentPatch} from '../core/license-baseline.ts';
import {browserDnsArguments} from '../core/browser-dns.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
const uid='appliance-fixture',nodeUid='node-fixture',installation='11111111-2222-4333-8444-555555555555';
const options:PreparationOptions={phases:[0,1,2,3,4,5,6,7,8],approve:[],independentRecovery:false};
const snapshot={observedAppliance:{metadata:{uid}},nodes:[{metadata:{uid:nodeUid}}]} as PreparationSnapshot;
const consent:SetupConsent={version:1,testLab:true,applianceUid:uid,nodeUids:[nodeUid],phases:options.phases,
  scopes:['gpu','license','host-drills'],confirmedAt:new Date().toISOString()};
test('HAR-10 setup consent is exact-installation bound and subset-scoped',annotation,()=>{
  expect(savedSetupOptions(options,consent,snapshot).approve).toEqual(consent.scopes);
  expect(savedSetupOptions({...options,phases:[0]}, {...consent,phases:[0]},snapshot).approve).toEqual(consent.scopes);
  expect(savedSetupOptions(options,{...consent,phases:[0]},snapshot).approve).toEqual([]);
  expect(savedSetupOptions(options,{...consent,scopes:[]},snapshot).approve).toEqual([]);
  for(const patch of [{applianceUid:'other'},{nodeUids:['foreign']},{nodeUids:[nodeUid,nodeUid]},
    {scopes:['all']},{phases:[0,0]},{phases:[]},{confirmedAt:new Date(Date.now()+600_000).toISOString()}])
    expect(()=>savedSetupOptions(options,{...consent,...patch},snapshot)).toThrow();
});
test('HAR-10 a proved host continuation cannot repin credentials, identities, models or budgets',annotation,()=>{
  const lab={expected:{applianceUid:uid,nodes:[{name:'fixture',uid:nodeUid,bootId:'boot-1'}],
    images:[{namespace:'dashboard',deployment:'web',container:'web',digest:'sha256:'+'a'.repeat(64)}],flux:{revision:'branch@sha1:'+'b'.repeat(40)}},
    dashboardUrl:'https://fixture.local',usernameFile:'/inputs/user',smokeModel:{url:'ollama://small',memoryRequiredMi:2048},
    gpu:{bootId:'boot-1',nodeUid}} as unknown as LabConfig;
  const next=structuredClone(lab);next.expected.nodes[0]!.bootId='boot-2';next.gpu!.bootId='boot-2';
  next.expected.images[0]!.digest='sha256:'+'c'.repeat(64);next.expected.flux!.revision='branch@sha1:'+'d'.repeat(40);
  verifyHostContinuation(lab,next);
  for(const change of [(value:LabConfig)=>{value.expected.nodes[0]!.uid='foreign';},
    (value:LabConfig)=>{value.usernameFile='/inputs/foreign';},(value:LabConfig)=>{value.smokeModel!.memoryRequiredMi=4096;},
    (value:LabConfig)=>{value.dashboardUrl='https://other.local';}]) {
    const unsafe=structuredClone(next);change(unsafe);expect(()=>verifyHostContinuation(lab,unsafe)).toThrow();
  }
});
test('HAR-10 suite discovery allowlists actual optional modules and never exports arbitrary model secrets',annotation,()=>{
  const models={activations:[{metadata:{name:'model-a',uid:'model-uid',generation:1,resourceVersion:'4'},
    spec:{type:'local',enabled:true,apiKey:'DO-NOT-EXPORT'}}],computeTargets:{targets:[]}} as unknown as ModelsPayload;
  const modules={modules:{optional:{enabled:false,parameters:{version:'current'}}},catalogJson:{modules:{
    optional:{activationMode:'moduleactivation',parameters:[{name:'version',label:'Version'}]},
    'nvidia-gpu':{activationMode:'moduleactivation'},identity:{activationMode:'moduleactivation'},
    unrelated:{activationMode:'appinstance'}},applications:{openclaw:{},unknown:{}}}} as unknown as ModulesPayload;
  const result=suiteInventory(models,modules,{} as SystemStatusPayload,[]);
  expect(result.optionalModules.map(item=>item.id)).toEqual(['optional']);expect(result.applications).toEqual(['openclaw']);
  expect(result.activeModels[0]?.uid).toBe('model-uid');expect(JSON.stringify(result)).not.toContain('DO-NOT-EXPORT');
});

test('HAR-10 disposable license signer is Ed25519 and bound to the exact installation',annotation,()=>{
  const signer=createTestLicenseSigner(uid,installation);
  expect(validateTestLicenseSigner(signer,uid,installation)).toBe(signer);
  expect(()=>validateTestLicenseSigner(signer,'foreign',installation)).toThrow();
  expect(()=>validateTestLicenseSigner({...signer,privateKey:'private secret malformed'},uid,installation)).toThrow('[CONFIG]');
  expect(()=>validateTestLicenseSigner({...signer,fingerprint:'a'.repeat(64)},uid,installation)).toThrow();
});
test('HAR-10 signed license fixtures prove real expiry, wrong installation and signature tampering',annotation,()=>{
  const signer=createTestLicenseSigner(uid,installation),now=Date.now();
  for(const mode of ['valid','expired','wrong-installation','tampered','short-lived'] as const) {
    const document=JSON.parse(testLicenseDocument(signer,mode,now));
    const [header,payload,signature]=document.token.split('.');
    const claims=JSON.parse(Buffer.from(payload,'base64url').toString());
    expect(verify(null,Buffer.from(header+'.'+payload),createPublicKey(signer.publicKey),Buffer.from(signature,'base64url'))).toBe(mode !== 'tampered');
    expect(claims.installationId === installation).toBe(mode !== 'wrong-installation');
    expect(claims.expiresAt > Math.floor(now/1000)).toBe(mode !== 'expired');
    if(mode === 'short-lived')expect(claims.expiresAt-Math.floor(now/1000)).toBe(120);
    expect(claims.features).toEqual(['federated-sso']);expect(document).not.toHaveProperty('privateKey');
  }
});

const host:ManagedHost={name:'fixture',nodeUid,bootId:'boot-1',kernel:'kernel-test',available:true,message:'Fixture',
  gpuMemory:{id:'a'.repeat(64),supported:true,message:'Fixture'}};
const lab={expected:{applianceUid:uid,nodes:[{name:host.name,uid:nodeUid,bootId:host.bootId}]}} as LabConfig;
function recipes(){return {version:2,applianceUid:uid,nodeUid,nodeName:host.name,approveDestructive:true,independentRecoveryAvailable:true,
  cases:{'GPUHOST-05':{recipe:{action:'configure-gpu-memory',allowExperimental:false,experimentMode:false,
    gpuMemory:{carveoutIndex:1,dynamicLimitMi:32768}},expected:{kernel:host.kernel,bootChanges:1,terminal:'Succeeded'}}}};}
test('HAR-10 saved destructive recipes derive only the fresh same-host plan and reviewed boot',annotation,()=>{
  const value=recipes(),drill=materializeHostDrill(value,'GPUHOST-05',host,lab);
  expect(drill.request.planId).toBe('a'.repeat(64));expect(drill.request.bootId).toBe('boot-1');expect(drill.request.confirmation).toBe(host.name);
  const fresh={...host,gpuMemory:{...host.gpuMemory!,id:'b'.repeat(64)}};
  expect(materializeHostDrill(value,'GPUHOST-05',fresh,lab).request.planId).toBe('b'.repeat(64));
  for(const changed of [{...host,nodeUid:'foreign'},{...host,bootId:'unexplained'},{...host,available:false}])
    expect(()=>materializeHostDrill(value,'GPUHOST-05',changed,lab)).toThrow();
});
test('HAR-10 destructive recipe bundles reject implicit recovery, arbitrary commands and outcome widening',annotation,()=>{
  const value=recipes();recipeBundle(value,uid,nodeUid);
  for(const patch of [{approveDestructive:false},{independentRecoveryAvailable:false},{applianceUid:'foreign'}])
    expect(()=>recipeBundle({...value,...patch},uid,nodeUid)).toThrow();
  const unsafe=structuredClone(value) as any;unsafe.cases['GPUHOST-05'].recipe.command='arbitrary command';
  expect(()=>recipeBundle(unsafe,uid,nodeUid)).toThrow();
  unsafe.cases['GPUHOST-05'].recipe=structuredClone(value.cases['GPUHOST-05'].recipe);unsafe.cases['GPUHOST-05'].expected.bootChanges=3;
  expect(()=>recipeBundle(unsafe,uid,nodeUid)).toThrow();
});
test('HAR-10 license baseline patch cannot alter installation identity, trust or unrelated Secret data',annotation,()=>{
  const secret={metadata:{name:'magicstick-license',namespace:'identity-system',uid:'secret-uid',resourceVersion:'17'},
    data:{installationId:Buffer.from(installation).toString('base64'),'license.json':Buffer.from('original').toString('base64'),other:'untouched'}};
  const original=JSON.stringify(secret),patch=licenseDocumentPatch(secret,installation,null);
  expect(patch.slice(0,3).map(item=>item.path)).toEqual(['/metadata/uid','/metadata/resourceVersion','/data']);
  expect(patch[3]).toEqual({op:'remove',path:'/data/license.json'});expect(JSON.stringify(secret)).toBe(original);
  expect(licenseDocumentPatch({...secret,data:{installationId:secret.data.installationId}},installation,'restored')[3]?.path).toBe('/data/license.json');
  for(const change of [{...secret,metadata:{...secret.metadata,name:'trust'}},{...secret,data:{...secret.data,installationId:'foreign'}}])
    expect(()=>licenseDocumentPatch(change,installation,null)).toThrow();
});
test('HAR-10 browser mDNS mapping is private, bounded and keeps actual TLS/SNI origins',annotation,()=>{
  expect(browserDnsArguments({version:1,mappings:[{suffix:'openclaw.fixture.local',address:'192.0.2.10'}]}))
    .toEqual(['--host-resolver-rules=MAP *.openclaw.fixture.local 192.0.2.10,EXCLUDE localhost']);
  expect(browserDnsArguments({version:1,mappings:[]})).toEqual([]);
  for(const mapping of [{suffix:'public.example.com',address:'192.0.2.10'},{suffix:'fixture.local,MAP *',address:'192.0.2.10'},
    {suffix:'fixture.local',address:'192.0.2.10,MAP *'},{suffix:'fixture.local',address:'192.0.2.10',args:'--ignore-certificate-errors'}])
    expect(()=>browserDnsArguments({version:1,mappings:[mapping]})).toThrow();
});

const runId='reg-11111111-2222-4333-8444-555555555555';
test('HAR-10 disposable unmanaged key is a real random key with hash-only identity and no inference permission',annotation,()=>{
  const fixture=disposableUnmanagedKey(runId,uid);
  expect(fixture.identity.id).toBe(createHash('sha256').update(fixture.body.key).digest('hex'));
  expect(JSON.stringify(fixture.identity)).not.toContain(fixture.body.key);expect(fixture.body.max_budget).toBe(0);
  expect(fixture.body.models).toEqual(['regression-no-inference-'+runId]);expect(fixture.body.duration).toBe('1h');
  expect(disposableUnmanagedKey(runId,uid).identity.id).not.toBe(fixture.identity.id);
});
test('HAR-10 unmanaged-key ownership requires the actual reviewed fixture and rejects missing/foreign/managed records',annotation,()=>{
  const fixture=disposableUnmanagedKey(runId,uid),info={...fixture.body};
  verifyUnmanagedKey({info},fixture.identity);
  for(const record of [null,{info:null},{info:{...info,key_alias:'other'}},{info:{...info,max_budget:10}},
    {info:{...info,metadata:{...info.metadata,regressionAppliance:'foreign'}}},
    {info:{...info,metadata:{...info.metadata,magicstick_source:'managed'}}}])
    expect(()=>verifyUnmanagedKey(record,fixture.identity)).toThrow();
});
test('HAR-10 unmanaged fixture lifecycle uses upstream create/read/delete with hash-only URLs and exact cleanup',annotation,async()=>{
  const fixture=disposableUnmanagedKey(runId,uid),calls:Array<{url:string;options:any}>=[];let info:unknown=null;
  const request={fetch:async(url:string,options:any)=>{
    calls.push({url,options});let result:any={};let status=200;
    if(url.endsWith('/key/generate')){info={...options.data};result={key:options.data.key};}
    else if(url.endsWith('/key/delete')){expect(options.data.keys).toEqual([fixture.identity.id]);info=null;}
    else {result={info};if(!info)status=404;}
    return {status:()=>status,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(result)),json:async()=>result};
  }} as unknown as APIRequestContext;
  const client=new UnmanagedKeyFixtureClient(request,'https://inference.example.test','sk-synthetic-master',async()=>{},1000);
  await client.create(fixture);await client.removeOwned(fixture.identity);
  expect(calls.map(item=>item.url).join(' ')).not.toContain(fixture.body.key);
  expect(calls.filter(item=>item.options.method === 'POST').map(item=>new URL(item.url).pathname)).toEqual(['/key/generate','/key/delete']);
});
test('HAR-10 unmanaged fixture cleanup refuses a concurrently replaced record',annotation,async()=>{
  const fixture=disposableUnmanagedKey(runId,uid);let writes=0;
  const request={fetch:async(_url:string,options:any)=>{if(options.method === 'POST')writes++;
    const result={info:{...fixture.body,key_alias:'foreign'}};
    return {status:()=>200,headers:()=>({'content-type':'application/json'}),body:async()=>Buffer.from(JSON.stringify(result)),json:async()=>result};
  }} as unknown as APIRequestContext;
  const client=new UnmanagedKeyFixtureClient(request,'https://inference.example.test','sk-synthetic-master',async()=>{},1000);
  await expect(client.removeOwned(fixture.identity)).rejects.toThrow();expect(writes).toBe(0);
});
