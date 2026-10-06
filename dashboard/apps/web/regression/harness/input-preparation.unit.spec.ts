import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {parseLabConfig} from '../core/config.ts';
import {allowedPreparationRequest,estimateInput,preparationApi} from '../core/preparation-api.ts';
import {automaticInputRecovery,catalogFixture,inputHash,inputReadiness,pinChanges,preparationArguments,prepareInputs,preparedProfile,
  preparedReboot,validateAcceptance,type PreparationOptions,type PreparationSnapshot} from '../core/input-preparation.ts';
import {automaticPreparationMeasure,readinessLines} from '../core/preparation-measures.ts';
import {hostDrillIds} from '../profiles/remaining-p0.ts';
import {automaticGpuProfile,automaticHostRecipes,automaticProfile} from '../core/automatic-fixtures.ts';
import {labPolicy,parseRegistration,verifyRegistration} from '../core/lab-policy.ts';

const digest='sha256:'+'a'.repeat(64),revision='develop@sha1:'+'b'.repeat(40);
const options:PreparationOptions={phases:[0,1,2,3,4,5,6,7,8],approve:[],independentRecovery:false};
function source() {return {version:1,profile:'preflight',dashboardUrl:'https://dashboard.example.local',identityUrl:'https://id.example.local',
  inferenceUrl:'https://inference.example.local',caFile:'ca.pem',usernameFile:'username.txt',passwordFile:'password.txt',observerKubeconfig:'observer.yaml',
  modelCleanupKubeconfig:'model-cleaner.yaml',lock:{namespace:'magicstick-regression',name:'lab-lock',kubeconfig:'locker.yaml'}};}
function snapshot():PreparationSnapshot {
  const metadata={name:'local',namespace:'ai-system',uid:'appliance-uid'};
  return {appliance:{metadata:{...metadata}},observedAppliance:{metadata:{...metadata}},
    nodes:[{metadata:{name:'lab-node',uid:'node-uid'},status:{nodeInfo:{bootID:'boot-uid',kernelVersion:'7.0.0-test'},conditions:[{type:'Ready',status:'True'}]}}],
    hosts:[{name:'lab-node',nodeUid:'node-uid',bootId:'boot-uid',kernel:'7.0.0-test',available:true,message:'synthetic'}],
    models:{activations:[],presets:{small:{variants:[
      {engine:'OLlama',computeTarget:'cpu',url:'ollama://small:latest',memoryRequiredMi:2048,contextWindow:1024},
      {engine:'VLLM',computeTarget:'cpu',url:'hf://example/small',memoryRequiredMi:4096,contextWindow:2048},
    ]}},computeTargets:{targets:[{id:'cpu',available:true,engines:['OLlama','VLLM'],
      kvCacheTypes:{OLlama:[{value:'f16',label:'Float16'}],VLLM:[{value:'auto',label:'Automatic'}]}}]}},status:{},modules:{modules:{}},
    images:[{namespace:'dashboard',deployment:'ai-appliance-dashboard',container:'web',digest},
      {namespace:'identity-system',deployment:'ai-appliance-dashboard-api',container:'api',digest}],
    flux:{namespace:'flux-system',name:'flux-system',revision},leaseIdle:true,
    readableFiles:['/inputs/username.txt','/inputs/password.txt','/inputs/observer.yaml','/inputs/locker.yaml','/inputs/model-cleaner.yaml']};
}

test('HAR-10 registered lab policy is fixed and rejects replacement targets or a mutable server marker',()=>{
  expect(Object.isFrozen(labPolicy.scopes)).toBe(true);expect(labPolicy.phases).toEqual(options.phases);
  const lab=prepareInputs(source(),snapshot(),options,{}).parsed;
  const registration=parseRegistration({version:1,kind:'disposable-regression-lab',policyVersion:1,
    id:'11111111-2222-4333-8444-555555555555',applianceUid:lab.expected.applianceUid,nodeUids:['node-uid'],
    dashboardUrl:lab.dashboardUrl,identityUrl:lab.identityUrl,createdAt:new Date().toISOString()});
  const marker={immutable:true,metadata:{namespace:labPolicy.namespace,name:labPolicy.marker,
    labels:{'regression.magicstick.dev/appliance-uid':registration.applianceUid}},data:{kind:registration.kind,
    registrationId:registration.id,policyVersion:'1',nodeUids:'node-uid'}};
  expect(()=>verifyRegistration(registration,lab,marker)).not.toThrow();
  for(const changed of [{...lab,expected:{...lab.expected,applianceUid:'foreign'}},
    {...lab,expected:{...lab.expected,nodes:[{name:'other',uid:'foreign-node'}]}},
    {...lab,dashboardUrl:'https://foreign.example.local'}])expect(()=>verifyRegistration(registration,changed,marker)).toThrow('[LAB]');
  expect(()=>verifyRegistration(registration,lab,{...marker,immutable:false})).toThrow('[LAB]');
  expect(()=>verifyRegistration(registration,lab,{...marker,data:{...marker.data,registrationId:'other'}})).toThrow('[LAB]');
});

test('HAR-10 automatic input recovery regenerates only its own interrupted transaction without a new approval form',()=>{
  const id='11111111-2222-4333-8444-555555555555',receipt={version:1,id,automatic:true};
  expect(automaticInputRecovery(undefined,true)).toBeUndefined();
  expect(automaticInputRecovery(receipt,true)).toBe(id);
  for(const invalid of [{version:1,id},{...receipt,automatic:false},{...receipt,id:'../foreign'},
    {...receipt,contentHash:'edited'}])expect(()=>automaticInputRecovery(invalid,true)).toThrow();
  expect(()=>automaticInputRecovery(receipt,false)).toThrow();
  expect(preparationArguments(['--automatic']).automatic).toBe(true);
});

test('HAR-10 automatic discovery keeps NVIDIA tests available without AMD or FreeToken telemetry',()=>{
  const observed=snapshot(),host=observed.hosts[0]!;
  observed.status.hardwareOperators={'nvidia-gpu':{devices:[{id:'node-uid/0000:01:00.0',vendor:'nvidia',
    node:host.name,nodeUid:host.nodeUid,pciAddress:'0000:01:00.0',name:'Synthetic NVIDIA'}]}} as any;
  observed.models.computeTargets.targets.push({id:'nvidia-gpu',available:true,engines:['OLlama','VLLM'],
    kvCacheTypes:{OLlama:[{value:'q8_0',label:'Q8'}],VLLM:[{value:'fp8',label:'FP8'}]}});
  const gpu=automaticGpuProfile(observed,{});
  expect(gpu?.devices.nvidia?.id).toBe('node-uid/0000:01:00.0');expect(gpu?.devices.amd).toBeUndefined();
  expect(gpu?.models.nvidiaOllama?.url).toBe('ollama://small:latest');
  expect(gpu?.models.nvidiaVllm?.contextWindow).toBe(1024);expect(gpu?.models.freetoken).toBeUndefined();
  const prepared=prepareInputs({...source(),registrationFile:'lab-registration.json',gpu},observed,{...options,automatic:true},{});
  const profile=automaticProfile(observed,{},prepared.parsed);
  expect(profile.identity.approveDisposableUsers).toBe(true);expect(profile.license.approveLicenseReplacement).toBe(true);
  expect(profile.unmanagedKey.createDisposableFixture).toBe(true);
  const report=inputReadiness(prepared.parsed,profile,observed,{...options,automatic:true,approve:[...labPolicy.scopes] as any});
  const guidance=readinessLines(report).join('\n');
  expect(guidance).not.toMatch(/--approve|ACCEPT|answer .*questions|accept .*proposal/i);
  expect(report.find(item=>item.phase === 3)?.measures.some(item=>item.id === 'gpu-profile')).toBe(false);
  expect(guidance).toContain('real second disposable appliance');
});

test('HAR-10 automatic base identity tests remain selectable when no inference runtime is ready',()=>{
  const observed=snapshot();observed.models.computeTargets.targets=[];
  const prepared=prepareInputs({...source(),registrationFile:'lab-registration.json'},observed,{...options,automatic:true},{});
  expect(prepared.parsed.expected.capabilities).toEqual([]);expect(prepared.parsed.smokeModel).toBeUndefined();
  const recipes=automaticHostRecipes(prepared.parsed,observed.hosts[0]!);
  expect(recipes.cases['BOOT-02']?.recipe.action).toBe('reboot');
  expect(recipes.cases['BOOT-03']).toBeUndefined();
  expect(recipes.cases['NET-07']).toBeUndefined();
});

test('HAR-10 automatic memory drills use advertised firmware options and preserve the OS safety reserve',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed,host=observed.hosts[0]!;
  host.gpuMemory={id:'c'.repeat(64),supported:true,message:'Synthetic',systemMemoryMi:120_000,
    currentCarveoutIndex:0,currentCarveoutMi:512,currentDynamicLimitMi:32_768,stepMi:1024,minDynamicLimitMi:1024,
    options:[{index:0,label:'Small',sizeMi:512},{index:1,label:'Next',sizeMi:1024},{index:2,label:'Too large',sizeMi:119_000}]};
  const recipes=automaticHostRecipes(lab,host);
  expect(recipes.cases['GPUHOST-05']?.recipe.gpuMemory).toEqual({carveoutIndex:0,dynamicLimitMi:31_744});
  expect(recipes.cases['GPUHOST-05']?.recipe.allowExperimental).toBe(true);
  expect(recipes.cases['GPUHOST-06']?.recipe.gpuMemory).toEqual({carveoutIndex:1,dynamicLimitMi:32_768});
  expect(recipes.cases['GPUHOST-06']?.expected.bootChanges).toBe(1);
  expect(recipes.cases['GPUHOST-07']).toBeUndefined();
  host.gpuMemory.systemMemoryMi=16_000;
  const bounded=automaticHostRecipes(lab,host);
  expect(bounded.cases['GPUHOST-05']).toBeUndefined();expect(bounded.cases['GPUHOST-06']).toBeUndefined();
});

test('HAR-10 automatic blockers retain missing case IDs and give infrastructure actions without approval forms',()=>{
  const host=automaticPreparationMeasure('physical-drill',['The reviewed typed recipe for NET-07 was not completed in setup.',
    'Temporary changes have not been approved.']);
  expect(host.missing).toEqual(['No available repository-owned host recipe for NET-07.']);
  expect(host.approval).toBeUndefined();
  const ci=automaticPreparationMeasure('security-ci');
  expect(ci.actions.join(' ')).toContain('dependency-security.yml');
  expect(ci.actions.join(' ')).toContain('public-release-checks.yml');
  expect(automaticPreparationMeasure('companion').actions.join(' ')).toContain('build-mesh-companion.yml');
  const lines=readinessLines([{phase:6,state:'Blocked',blockers:[host.blocker],measures:[host],testExecutionVerified:false}]);
  expect(lines.join('\n')).toContain('Missing: No available repository-owned host recipe for NET-07.');
  expect(lines.join('\n')).toContain('Action:');
  expect(lines.join('\n')).not.toMatch(/--approve|ACCEPT|Only after review/);
});

test('HAR-10 preparation selection is bounded; no ambient or blanket approval',()=>{
  expect(preparationArguments(['--phases','0-2,4,8'])).toEqual({...options,phases:[0,1,2,4,8]});
  expect(preparationArguments(['--approve','gpu,identity']).approve).toEqual(['gpu','identity']);
  for(const args of [['--phases','8-0'],['--phases','9'],['--approve','all'],['--approve','reboot'],['--drill','NET-07'],
    ['--accept','../../lab.json'],['--independent-recovery'],['--phases','0','--phases','1']])
    expect(()=>preparationArguments(args)).toThrow();
});

test('HAR-10 initial candidate uses independent identities, exact runtime pins and catalog CPU fixtures',()=>{
  const previous=source(),before=inputHash(previous),observed=snapshot();
  const result=prepareInputs(previous,observed,options,{});
  expect(inputHash(previous)).toBe(before);
  expect(result.parsed.expected.applianceUid).toBe('appliance-uid');
  expect(result.parsed.expected.nodes).toEqual([{name:'lab-node',uid:'node-uid',bootId:'boot-uid'}]);
  expect(result.parsed.expected.flux?.revision).toBe(revision);
  expect(result.parsed.expected.images.map(image=>image.digest)).toEqual([digest,digest]);
  expect(result.parsed.smokeModel?.url).toBe('ollama://small:latest');
  expect(result.parsed.phase2?.vllmModel.url).toBe('hf://example/small');
  expect(result.parsed.gpu).toBeUndefined();
  expect(pinChanges(previous,result.lab)).toContain('initial identity');
});

test('HAR-10 repeated prepare preserves reviewed models, endpoints, budgets and all approval defaults',()=>{
  const observed=snapshot(),first=prepareInputs(source(),observed,options,{}).lab;
  first.smokeModel.url='ollama://reviewed:latest';first.phase2.vllmModel.url='hf://reviewed/small';
  const after=prepareInputs(first,observed,options,{});
  expect(after.parsed.smokeModel?.url).toBe('ollama://reviewed:latest');
  expect(after.parsed.phase2?.vllmModel.url).toBe('hf://reviewed/small');
  const previous={version:1,applications:{fixtures:[{type:'openclaw',promptLabel:'Reviewed prompt'}]},
    identity:{approveDisposableUsers:false},repeat:{cycles:5,maximumMemoryGrowthMi:512,maximumNonCacheDiskGrowthBytes:1234}};
  const profile=preparedProfile(previous,observed,options);
  expect(profile.applications.fixtures).toEqual(previous.applications.fixtures);
  expect(profile.repeat.cycles).toBe(5);expect(profile.identity.approveDisposableUsers).toBe(false);
  expect(profile.license.approveLicenseReplacement).toBe(false);expect(profile.kubernetes.approveAdminGrant).toBe(false);
  expect(profile.cache.approveFreeToken).toBe(false);
});

test('HAR-10 read-only prerequisite report cannot become Passed regression evidence or omit missing external infrastructure',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  const profile=preparedProfile({},observed,options);
  const report=inputReadiness(lab,profile,observed,options);
  expect(report.filter(item=>item.phase <= 2).every(item=>item.state === 'InputsReady')).toBe(true);
  expect(report.filter(item=>item.phase >= 3).every(item=>item.state === 'Blocked')).toBe(true);
  expect(report.every(item=>item.testExecutionVerified === false)).toBe(true);
  expect(report.find(item=>item.phase === 5)?.blockers.some(item=>item.includes('signed licenses'))).toBe(true);
  expect(report.find(item=>item.phase === 7)?.blockers.some(item=>item.includes('second appliance'))).toBe(true);
  expect(report.find(item=>item.phase === 8)?.blockers.some(item=>item.includes('exact installed commit'))).toBe(true);
  expect(JSON.stringify(report)).not.toContain('Passed');
  observed.models.activations=[{spec:{type:'local',enabled:true}}];
  expect(inputReadiness(lab,profile,observed,options).every(item=>item.state === 'Blocked')).toBe(true);
});

test('HAR-10 every preparation blocker has concrete saved/printed measures and bounded optional approval guidance',()=>{
  const observed=snapshot(),candidate=prepareInputs(source(),observed,options,{});
  observed.gpuIssues=candidate.gpuIssues;
  const report=inputReadiness(candidate.parsed,preparedProfile({},observed,options),observed,options);
  for(const item of report) {
    expect(item.measures.map(measure=>measure.blocker)).toEqual(item.blockers);
    expect(new Set(item.measures.map(measure=>measure.id)).size).toBe(item.measures.length);
    for(const measure of item.measures) {
      expect(measure.missing.length).toBeGreaterThan(0);expect(measure.actions.length).toBeGreaterThan(0);
      if(measure.approval) {
        expect(measure.approval.command).toBe(`bash tools/regression.sh prepare --phases ${item.phase} --approve ${measure.approval.scope}`);
        expect(preparationArguments(measure.approval.command.split(' ').slice(3))).toEqual({...options,phases:[item.phase],approve:[measure.approval.scope]});
      }
    }
  }
  const lines=readinessLines(report).join('\n');
  expect(lines).toContain('Phase 3: Blocked');expect(lines).toContain('Missing: Temporary AMD/NVIDIA sharing transitions have not been approved');
  expect(lines).toContain('No unambiguous managed node');expect(lines).toContain('bash tools/regression.sh setup');
  expect(lines).toContain('build-mesh-companion.yml');expect(lines).toContain('dependency-security.yml');
  expect(lines).toContain('both exclusive and shared');expect(lines).toContain('manual --api-restart');
  expect(lines).toContain('automatic one-hour fixture');expect(lines).not.toContain('--approve all');
});

test('HAR-10 missing external fixtures remain blocked after consent; satisfied approvals are not requested again',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  const approvedOptions={...options,approve:['identity','kubernetes','license','api-restart','modules','amd-profile','federation','mesh','realtime'] as PreparationOptions['approve']};
  const profile=preparedProfile({},observed,approvedOptions),before=inputHash(profile);
  const report=inputReadiness(lab,profile,observed,approvedOptions),phase5=report.find(item=>item.phase === 5)!;
  expect(inputHash(profile)).toBe(before);
  expect(phase5.measures.some(measure=>measure.id === 'users')).toBe(false);
  expect(phase5.measures.find(measure=>measure.id === 'licenses')?.missing).toEqual([
    'The four private issuer/rejection license fixtures are incomplete or unreadable.',
    'Repeatable no-license tests need the separately scoped license-document reset/restore credential and explicit baseline consent.',
  ]);
  for(const id of ['licenses','oidc-plugin','api-restarter','optional-module','amd-profile','federation'])
    expect(phase5.measures.find(measure=>measure.id === id)?.approval).toBeUndefined();
  expect(report.find(item=>item.phase === 7)?.state).toBe('Blocked');
  expect(phase5.state).toBe('Blocked');expect(JSON.stringify(report)).not.toContain('Passed');
});

test('HAR-10 actionable output deduplicates shared state blockers and never relays private diagnostics',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  observed.readableFiles=[];observed.leaseIdle=false;
  observed.models.activations=[{spec:{type:'local',enabled:true}}];
  observed.modelWarnings=['CPU smokeModel: metadata/estimator or reviewed RAM budget needs attention',
    'CPU ollamaModel: metadata/estimator or reviewed RAM budget needs attention','https://secret:password@internal.invalid/private-token'];
  const report=inputReadiness(lab,preparedProfile({},observed,options),observed,options);
  const first=report[0]!;
  expect(first.measures.filter(measure=>measure.id === 'credentials')).toHaveLength(1);
  expect(first.measures.filter(measure=>measure.id === 'cpu-model')).toHaveLength(1);
  expect(first.measures.find(measure=>measure.id === 'cpu-model')?.missing).toHaveLength(3);
  const text=JSON.stringify(report)+readinessLines(report).join('\n');
  expect(text).not.toMatch(/private-token|internal\.invalid|secret:password/);
  expect(text).toContain('Never steal, force-reset');expect(text).toContain('Models > Stop');
  expect(report.every(item=>item.state === 'Blocked')).toBe(true);
  expect(report.find(item=>item.phase === 7)?.cases?.every(item=>item.state === 'Blocked')).toBe(true);
});

test('HAR-10 full Phase 6 readiness cannot be cleared by one approved reboot proposal',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  const drillOptions={...options,phases:[6],approve:['reboot'] as PreparationOptions['approve'],drill:'BOOT-02' as const,independentRecovery:true};
  const report=inputReadiness(lab,preparedProfile({},observed,drillOptions),observed,drillOptions);
  const physical=report[0]!.measures.filter(measure=>measure.id === 'physical-drill');
  expect(physical).toHaveLength(1);expect(physical[0]!.approval).toBeUndefined();
  expect(physical[0]!.actions.join('\n')).toContain('it does not unblock all of Phase 6');
  expect(physical[0]!.actions.join('\n')).not.toContain('bash tools/regression.sh phase6\n');
  expect(report[0]!.state).toBe('Blocked');
});

test('HAR-10 approvals apply only to named future scenarios, never to license restart or physical operations implicitly',()=>{
  const profile=preparedProfile({},snapshot(),{...options,approve:['identity','license']});
  expect(profile.identity.approveDisposableUsers).toBe(true);expect(profile.license.approveLicenseReplacement).toBe(true);
  expect(profile.license.restart.approveApiRestart).toBe(false);expect(profile.kubernetes.approveAdminGrant).toBe(false);
  expect(profile.cache.approveFreeToken).toBe(false);expect(profile.mesh).toBeUndefined();
});

test('HAR-10 retained CI run IDs are not fresh evidence until current read-only metadata confirms them',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  const ci={companion:{runId:123,sourceRevision:'b'.repeat(40)},securityCi:{dependenciesRunId:234,publicationRunId:345,sourceRevision:'b'.repeat(40)}};
  const profile=preparedProfile(ci,observed,options);
  const blocked=inputReadiness(lab,profile,observed,options);
  expect(blocked.find(item=>item.phase === 7)?.blockers).toContain('Fresh exact-commit native companion build evidence');
  expect(blocked.find(item=>item.phase === 8)?.blockers).toContain('Fresh successful security/publication CI for the exact installed commit');
  observed.ci=structuredClone(ci);
  const checked=inputReadiness(lab,profile,observed,options);
  expect(checked.find(item=>item.phase === 7)?.blockers).not.toContain('Fresh exact-commit native companion build evidence');
  expect(checked.find(item=>item.phase === 8)?.blockers).not.toContain('Fresh successful security/publication CI for the exact installed commit');
});

test('HAR-10 replacement identities discard old domain-operation consent until explicitly approved again',()=>{
  const previous={version:1,identity:{approveDisposableUsers:true},license:{approveLicenseReplacement:true,allowFirstActivation:true,
    restart:{approveApiRestart:true}},mesh:{approveTwoAppliances:true}};
  const observed=snapshot(),expected=prepareInputs(source(),observed,options,{}).parsed.expected;
  expected.applianceUid='old-installation';
  const profile=preparedProfile(previous,observed,options,expected);
  expect(profile.identity.approveDisposableUsers).toBe(false);expect(profile.license.allowFirstActivation).toBe(false);
  expect(profile.license.restart.approveApiRestart).toBe(false);expect(profile.mesh.approveTwoAppliances).toBe(false);
  const explicitlyReviewed=preparedProfile(previous,observed,{...options,approve:['identity','api-restart']},expected);
  expect(explicitlyReviewed.identity.approveDisposableUsers).toBe(true);expect(explicitlyReviewed.license.restart.approveApiRestart).toBe(true);
  expect(explicitlyReviewed.license.approveLicenseReplacement).toBe(false);expect(previous.identity.approveDisposableUsers).toBe(true);
});

test('HAR-10 preparation transport permits only exact read-only estimators and bounded discovery, never product writes',async()=>{
  const origin='https://dashboard.example.local',fixture=prepareInputs(source(),snapshot(),options,{}).parsed.smokeModel!;
  const body=estimateInput(fixture),estimates=[body];
  expect(allowedPreparationRequest(new URL('/api/models/estimate-memory',origin),'POST',body,origin,estimates)).toBe(true);
  for(const [path,method,value] of [['/api/models/local','POST',body],['/api/host-management/operations','POST',{action:'reboot'}],
    ['/api/models/estimate-memory','DELETE',body],['/api/models/estimate-memory?extra=1','POST',body],
    ['/api/models/estimate-memory','POST',{...body,allowMemoryRisk:true}],['/api/models/estimate-memory','POST',{...body,url:'hf://foreign/model'}]])
    expect(allowedPreparationRequest(new URL(String(path),origin),String(method),value,origin,estimates)).toBe(false);
  expect(allowedPreparationRequest(new URL('https://user:password@dashboard.example.local/api/models/estimate-memory'),'POST',body,origin,estimates)).toBe(false);
  const params=new URLSearchParams({provider:'huggingface',engine:'VLLM',computeTarget:'cpu',modelType:'chat',q:'synthetic',limit:'20'});
  expect(allowedPreparationRequest(new URL('/api/model-discovery/search?'+params,origin),'GET',undefined,origin,estimates)).toBe(true);
  params.append('q','second');expect(allowedPreparationRequest(new URL('/api/model-discovery/search?'+params,origin),'GET',undefined,origin,estimates)).toBe(false);
  let requests=0;
  const api=preparationApi({fetch:async()=>{requests++;return {status:()=>200,headers:()=>({'content-type':'application/json'}),
    body:async()=>Buffer.from(JSON.stringify({minimumMi:1500,recommendedMi:2200}))} as any;}},origin,500,[fixture]);
  await expect(api.estimateMemory({...body,allowMemoryRisk:true})).rejects.toThrow();expect(requests).toBe(0);
  expect((await api.estimateMemory(body)).recommendedMi).toBe(2200);expect(requests).toBe(1);
});

test('HAR-10 unavailable hardware is never auto-enabled and missing/foreign identities cannot be repinned blindly',()=>{
  const observed=snapshot();observed.models.computeTargets.targets[0]!.available=false;
  expect(catalogFixture(observed.models,'VLLM','cpu')).toBeUndefined();
  expect(()=>prepareInputs(source(),observed,options,{})).toThrow();
  const foreign=snapshot();foreign.appliance.metadata!.uid='other-appliance';
  expect(()=>prepareInputs(source(),foreign,options,{})).toThrow();
  const missing=snapshot(),before=prepareInputs(source(),missing,options,{}).lab;
  missing.nodes=[];expect(()=>prepareInputs(before,missing,options,{})).toThrow();
});

test('HAR-10 acceptance rejects moved boots/source/images, edited inputs, expiry and clock reversal',()=>{
  const now=Date.now(),plan={version:1,kind:'input-preparation',createdAt:new Date(now).toISOString(),originalHash:'original',snapshotHash:'snapshot'};
  expect(()=>validateAcceptance(plan,'original','snapshot',now)).not.toThrow();
  for(const [original,current,time] of [['changed','snapshot',now],['original','changed',now],['original','snapshot',now+900001],['original','snapshot',now-1]] as const)
    expect(()=>validateAcceptance(plan,original,current,time)).toThrow();
  expect(()=>preparationArguments(['--accept','12345678-aaaa-bbbb-cccc-123456789abc','--approve','gpu'])).toThrow();
});

test('HAR-10 boot changes are explicit candidate differences, never changes to accepted input',()=>{
  const observed=snapshot(),previous=prepareInputs(source(),observed,options,{}).lab;
  observed.nodes[0]!.status!.nodeInfo!.bootID='new-boot';observed.hosts[0]!.bootId='new-boot';
  const candidate=prepareInputs(previous,observed,options,{}).lab;
  expect(previous.expected.nodes[0].bootId).toBe('boot-uid');expect(candidate.expected.nodes[0].bootId).toBe('new-boot');
  expect(pinChanges(previous,candidate)).toEqual(['boot identity']);
});

test('HAR-10 reboot generation needs exact scope and independent recovery; it is only typed current-boot data',()=>{
  const observed=snapshot(),lab=prepareInputs(source(),observed,options,{}).parsed;
  expect(preparedReboot(lab,observed,options)).toBeUndefined();
  expect(()=>preparedReboot(lab,observed,{...options,drill:'BOOT-02'})).toThrow();
  expect(()=>preparedReboot(lab,observed,{...options,drill:'BOOT-02',approve:['reboot'],independentRecovery:true})).toThrow();
});

test('HAR-10 accepted mixed GPU pins and fixture budgets are retained only with current FreeToken telemetry',async()=>{
  const example=JSON.parse(await readFile(new URL('../gpu-profile.example.json',import.meta.url),'utf8')).gpu;
  const observed=snapshot();
  for(const provider of ['amd','nvidia'])observed.status.hardwareOperators ??= {},observed.status.hardwareOperators[provider]={devices:[{
    id:`node-uid/0000:0${provider === 'amd' ? 1 : 2}:00.0`,node:'lab-node',nodeUid:'node-uid',vendor:provider,name:'synthetic',
    pciAddress:`0000:0${provider === 'amd' ? 1 : 2}:00.0`,pciId:'synthetic',validationAvailable:true}]};
  observed.models.computeTargets.targets.push(...(['amd','nvidia'] as const).map(provider=>({id:provider+'-gpu',available:true,engines:['OLlama','VLLM','FreeToken']})));
  observed.models.computeTargets.freeTokenCapabilities={available:true,supportedVendors:['nvidia'],memoryStrategies:['auto'],devices:[{
    id:'node:lab-node',node:'lab-node',supported:true,systemMemoryMi:131072,systemAvailableMi:100000,maxGpuCount:1}]};
  observed.models.computeMemory={devices:[{id:'physical',kind:'gpu',vendor:'nvidia',computeTarget:'nvidia-gpu',nodes:['lab-node'],
    totalMi:49152,freeMi:48000,unreservedMi:48000,metricsAvailable:true,freeToken:{id:'node:lab-node',supported:true}}]};
  const previous=prepareInputs(source(),observed,{...options,phases:[0]},{}).lab;
  const gpu={...example,nodeName:'lab-node',nodeUid:'node-uid',bootId:'boot-uid',devices:{
    amd:{id:'node-uid/0000:01:00.0',pciAddress:'0000:01:00.0'},nvidia:{id:'node-uid/0000:02:00.0',pciAddress:'0000:02:00.0'}}};
  gpu.models.amdVllm!.url='hf://example/small';gpu.models.nvidiaVllm!.url='hf://example/small';
  gpu.models.freetoken!.freetoken.gpuDevice='node:lab-node';previous.gpu=gpu;
  parseLabConfig(previous,'/inputs');
  const before=inputHash(previous),candidate=prepareInputs(previous,observed,options,{});
  expect(inputHash(previous)).toBe(before);expect(candidate.parsed.gpu?.models.nvidiaVllm!.url).toBe('hf://example/small');
  const campaignOptions={...options,phases:[6],approve:['host-drills'] as PreparationOptions['approve']};
  const action=(id:string)=>id.startsWith('BOOT-') ? 'reboot' : id.startsWith('GPUHOST-') ? 'configure-gpu-memory' :
    id.startsWith('HOST-') ? 'prepare-gpu' : id.startsWith('NET-') ? 'configure-network' : id.startsWith('CHANNEL-') ?
    'apply-software-channel' : id.startsWith('CACHE-') ? 'clear-model-cache' : id === 'UPD-05' ? 'install-updates' : 'configure-updates';
  const recipes={version:2,applianceUid:'appliance-uid',nodeUid:'node-uid',nodeName:'lab-node',approveDestructive:true,
    independentRecoveryAvailable:true,cases:Object.fromEntries(hostDrillIds.map(id=>[id,{recipe:{action:action(id),
      allowExperimental:false,experimentMode:false},expected:{terminal:'Succeeded',bootChanges:0,kernel:'7.0.0-test'}}]))};
  observed.drills=recipes;
  const campaignProfile=preparedProfile({},observed,campaignOptions);
  const campaignReport=()=>inputReadiness(candidate.parsed,campaignProfile,observed,campaignOptions)[0]!;
  expect(campaignReport().measures.some(item=>item.id === 'physical-drill')).toBe(false);
  delete recipes.cases['NET-07'];
  expect(campaignReport().measures.find(item=>item.id === 'physical-drill')?.missing).toContain(
    'The reviewed typed recipe for NET-07 was not completed in setup.');
  recipes.independentRecoveryAvailable=false;
  expect(campaignReport().measures.some(item=>item.id === 'physical-drill')).toBe(true);
  recipes.independentRecoveryAvailable=true;recipes.applianceUid='foreign-installation';
  expect(campaignReport().measures.some(item=>item.id === 'physical-drill')).toBe(true);
  const reboot=preparedReboot(candidate.parsed,observed,{...options,drill:'BOOT-02',approve:['reboot'],independentRecovery:true});
  expect(reboot?.cases['BOOT-02'].request.bootId).toBe('boot-uid');
  expect(JSON.stringify(reboot)).not.toMatch(/"command"|"script"|"password"/);
  const replaced=structuredClone(previous);replaced.expected.applianceUid='old-installation';
  expect(prepareInputs(replaced,observed,options,{}).parsed.gpu).toBeUndefined();
  expect(prepareInputs(replaced,observed,{...options,approve:['gpu']},{}).parsed.gpu?.nodeUid).toBe('node-uid');
  observed.models.computeMemory!.devices![0]!.metricsAvailable=false;
  const blocked=prepareInputs(previous,observed,options,{});
  expect(blocked.parsed.gpu).toBeUndefined();expect(blocked.gpuProblem).toBe(true);
  expect(blocked.gpuIssues).toEqual(['freetoken-telemetry']);
  observed.gpuIssues=blocked.gpuIssues;
  const telemetry=inputReadiness(blocked.parsed,{},observed,{...options,phases:[3]})[0]!.measures.find(item=>item.id === 'gpu-profile')!;
  expect(telemetry.missing).toEqual(['The FreeToken capability or current physical NVIDIA VRAM/system-RAM telemetry could not be verified.']);
  expect(telemetry.approval).toBeUndefined();
  observed.models.computeMemory!.devices![0]!.metricsAvailable=true;
  const noApproval=structuredClone(previous);noApproval.gpu.acknowledgeSharingTransitions=false;
  const unapproved=prepareInputs(noApproval,observed,options,{});
  expect(unapproved.gpuIssues).toEqual(['sharing-approval']);expect(unapproved.parsed.gpu).toBeUndefined();
  observed.gpuIssues=unapproved.gpuIssues;
  const consent=inputReadiness(unapproved.parsed,{},observed,{...options,phases:[4]})[0]!.measures.find(item=>item.id === 'gpu-profile')!;
  expect(consent.approval?.command).toBe('bash tools/regression.sh prepare --phases 4 --approve gpu');
  observed.models.computeMemory!.devices![0]!.freeMi=1000;
  expect(prepareInputs(previous,observed,options,{}).gpuIssues).toEqual(['freetoken-budget']);
});
