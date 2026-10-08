import {test,expect} from '@playwright/test';
import type {ManagedHost} from '@magicstick/dashboard-contracts';
import {parseHostDrill} from '../core/host-drill.ts';
import {remainingIds,remainingRequirements,hostDrillIds} from '../profiles/remaining-p0.ts';
import {validCompanionReport} from './companion-live.ts';
import {currentSecurityCiRun,normalizeRules,ordinaryDashboardRules} from './security-live.ts';
import {inspectOidcConfig} from '../core/oidc-exec.ts';
import {verifyAppCleanerRules} from '../core/owned-app.ts';
import {validateAppFixtures,catalogContext} from './apps-live.ts';
import {websocketFrame,websocketEvent} from '../core/realtime-probe.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
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
