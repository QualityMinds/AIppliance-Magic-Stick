import {createHash} from 'node:crypto';
import type {Appliance, HardwareGpuDevice, ManagedHost, ModelsPayload, ModulesPayload, SystemStatusPayload} from '@magicstick/dashboard-contracts';
import {parseLabConfig, type LabConfig, type RuntimeModelFixture} from './config.ts';
import type {KubeObject} from './observer.ts';
import {requireSafe} from './errors.ts';
import {verifyIdentity, verifyCapabilities, verifyIdle} from './preflight.ts';
import {freeTokenNodeCapacity} from './freetoken-inventory.ts';
import {engineRegressionEnabled,freeTokenRegressionEnabled} from './engine-policy.ts';
import {requirePhase0Profile} from '../profiles/phase0-p0.ts';
import {requirePhase1Profile} from '../profiles/phase1-p0.ts';
import {requirePhase2Profile} from '../profiles/phase2-p0.ts';
import {requireGpuProfile} from '../profiles/gpu-p0.ts';
import {remainingRequirements,hostDrillIds} from '../profiles/remaining-p0.ts';
import {recipeBundle,type HostDrillRecipes} from './host-drill-recipes.ts';
import {automaticPreparationMeasure,preparationMeasure,type PreparationMeasure,type PreparationMeasureId} from './preparation-measures.ts';

type Json = Record<string, any>;
export const approvals = ['gpu','identity','kubernetes','license','api-restart','first-license','modules','amd-profile','federation','mesh','realtime','cache','reboot','unmanaged-key','host-drills'] as const;
export type Approval = typeof approvals[number];
export interface PreparationOptions {phases:number[]; approve:Approval[]; drill?:'BOOT-02'; independentRecovery:boolean; automatic?:boolean}
export type GpuInputIssue='mixed-hardware'|'device-selection'|'sharing-approval'|'fixtures'|'freetoken-telemetry'|'freetoken-budget';
export interface PreparationSnapshot {
  appliance:Appliance; observedAppliance:KubeObject; nodes:KubeObject[]; hosts:ManagedHost[];
  models:ModelsPayload; status:SystemStatusPayload; modules:ModulesPayload;
  images:LabConfig['expected']['images']; flux:NonNullable<LabConfig['expected']['flux']>;
  leaseIdle:boolean; readableFiles:string[]; ci?:Json;
  modelWarnings?:string[];
  gpuIssues?:GpuInputIssue[];
  drills?:unknown;
}
export interface Readiness {phase:number; state:'InputsReady'|'Blocked'; blockers:string[];measures:PreparationMeasure[];
  /** Prerequisite evaluation is deliberately NOT regression evidence. */
  testExecutionVerified:false; cases?:Array<{id:string;variant:string;state:'InputsReady'|'Blocked'}>}

export function canonicalInput(value:unknown):string {
  if(value === undefined)return 'null';
  if(Array.isArray(value))return '['+value.map(canonicalInput).join(',')+']';
  if(value && typeof value === 'object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b))
    .map(([key,item])=>JSON.stringify(key)+':'+canonicalInput(item)).join(',')+'}';
  return JSON.stringify(value);
}
export const inputHash = (value:unknown) => createHash('sha256').update(canonicalInput(value)).digest('hex');

export function preparationArguments(args:string[]):PreparationOptions & {accept?:string} {
  const result:PreparationOptions & {accept?:string}={phases:[0,1,2,3,4,5,6,7,8],approve:[],independentRecovery:false};
  const seen=new Set<string>();
  for(let i=0;i<args.length;i++) {
    const flag=args[i]!;requireSafe(!seen.has(flag),'CONFIG');seen.add(flag);
    if(flag === '--automatic')result.automatic=true;
    else if(flag === '--independent-recovery')result.independentRecovery=true;
    else if(flag === '--phases') {
      const value=args[++i] ?? ''; requireSafe(/^(?:[0-8](?:-[0-8])?)(?:,[0-8](?:-[0-8])?)*$/.test(value),'CONFIG');
      result.phases=[...new Set(value.split(',').flatMap(part=>{
        const [start,end]=part.split('-').map(Number);requireSafe(start! <= (end ?? start!),'CONFIG');
        return Array.from({length:(end ?? start!)-start!+1},(_,index)=>start!+index);
      }))].sort();
    } else if(flag === '--approve') {
      const values=(args[++i] ?? '').split(',');requireSafe(values.length > 0 && values.every(item=>approvals.includes(item as Approval)),'CONFIG');
      result.approve=[...new Set(values)] as Approval[];
    } else if(flag === '--drill') {requireSafe(args[++i] === 'BOOT-02','CONFIG');result.drill='BOOT-02';}
    else if(flag === '--accept') {
      const id=args[++i] ?? '';requireSafe(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id),'CONFIG');result.accept=id;
    } else requireSafe(false,'CONFIG');
  }
  requireSafe(!result.accept || seen.size === 1,'CONFIG');
  requireSafe(!result.independentRecovery || result.drill === 'BOOT-02','CONFIG');
  requireSafe(!result.approve.includes('reboot') || result.drill === 'BOOT-02' || result.automatic,'CONFIG');
  return result;
}

/** Select the smallest advertised text fixture, not a parallel model catalog.
 * It remains a test candidate, not proof of inference or memory adequacy. */
export function catalogFixture(models:ModelsPayload,engine:'OLlama'|'VLLM',target:'cpu'|'amd-gpu'|'nvidia-gpu'):RuntimeModelFixture|undefined {
  const capability=models.computeTargets.targets.find(item=>item.id === target);
  if(!capability?.available || !capability.engines?.includes(engine) || capability.engineAvailability?.[engine]?.available === false)return;
  const candidates=Object.values(models.presets).flatMap(item=>item.variants ?? []).filter(item=>
    item.engine === engine && item.computeTarget === target && (!item.modelType || item.modelType === 'chat') &&
    Number.isSafeInteger(item.memoryRequiredMi) && Number(item.memoryRequiredMi) >= 1024 && Number(item.memoryRequiredMi) <= (target === 'cpu' ? 8192 : 32768) &&
    (engine === 'OLlama' ? /^ollama:\/\// : /^hf:\/\//).test(item.url ?? '')).sort((a,b)=>Number(a.memoryRequiredMi)-Number(b.memoryRequiredMi) || String(a.url).localeCompare(String(b.url)));
  const chosen=candidates[0];if(!chosen)return;
  const artifact=chosen.artifacts?.find(item=>item.id === chosen.defaultArtifact);
  const cache=(capability.kvCacheTypes?.[engine] ?? []).map(item=>item.value);
  const preferred=engine === 'OLlama' ? target === 'cpu' ? 'f16' : 'q8_0' : target === 'cpu' ? 'auto' : 'fp8';
  if(!cache.includes(preferred))return;
  return {engine,computeTarget:target,url:artifact?.url ?? chosen.url!,memoryRequiredMi:Number(artifact?.memoryRequiredMi ?? chosen.memoryRequiredMi),
    contextWindow:Math.min(2048,Number(chosen.contextWindow ?? 1024)),maxNumSeqs:1,kvCacheType:preferred} as RuntimeModelFixture;
}

function gpuProfile(previous:Json,snapshot:PreparationSnapshot,options:PreparationOptions,defaults:Json):{profile?:Json;issues:GpuInputIssue[]} {
  const issues:GpuInputIssue[]=[];
  const devices=Object.values(snapshot.status.hardwareOperators ?? {}).flatMap(item=>item.devices ?? []);
  const hosts=snapshot.hosts.filter(host=>snapshot.nodes.some(node=>node.metadata.uid === host.nodeUid));
  const pairs=hosts.map(host=>({host,amd:devices.filter(d=>d.vendor === 'amd' && d.nodeUid === host.nodeUid),
    nvidia:devices.filter(d=>d.vendor === 'nvidia' && d.nodeUid === host.nodeUid)})).filter(pair=>pair.amd.length === 1 && pair.nvidia.length === 1);
  const pair=previous.gpu ? pairs.find(pair=>pair.host.nodeUid === previous.gpu.nodeUid) : pairs.length === 1 ? pairs[0] : undefined;
  const sameInstallation=!previous.expected || previous.expected.applianceUid === snapshot.observedAppliance.metadata.uid;
  const approved=(sameInstallation && previous.gpu?.acknowledgeSharingTransitions === true) || options.approve.includes('gpu');
  if(!approved)issues.push('sharing-approval');
  if(!pair) {issues.push(pairs.length ? 'device-selection' : 'mixed-hardware');return {issues};}
  const selected=(device:HardwareGpuDevice)=>({id:device.id,pciAddress:device.pciAddress});
  if(previous.gpu && (previous.gpu.devices.amd.id !== pair.amd[0]!.id || previous.gpu.devices.nvidia.id !== pair.nvidia[0]!.id)) {
    issues.push('device-selection');return {issues};
  }
  const models=previous.gpu?.models ? structuredClone(previous.gpu.models) : {
    amdOllama:catalogFixture(snapshot.models,'OLlama','amd-gpu'),amdVllm:catalogFixture(snapshot.models,'VLLM','amd-gpu'),
    nvidiaOllama:catalogFixture(snapshot.models,'OLlama','nvidia-gpu'),nvidiaVllm:catalogFixture(snapshot.models,'VLLM','nvidia-gpu'),
    ...(freeTokenRegressionEnabled ? {freetoken:structuredClone(defaults.freetoken)} : {}),
  };
  // Old accepted inputs may contain a FreeToken fixture. It is not a
  // prerequisite for the currently selected classic-engine regression scope.
  if(!freeTokenRegressionEnabled)delete models.freetoken;
  if(!['amdOllama','amdVllm','nvidiaOllama','nvidiaVllm'].every(key=>models[key]) ||
    freeTokenRegressionEnabled && !models.freetoken?.freetoken) {issues.push('fixtures');return {issues};}
  // The catalog and separate current telemetry must both support the fixture.
  // Do not turn unknown VRAM into host RAM or borrow another GPU's counters.
  if(freeTokenRegressionEnabled)try {
    models.freetoken.freetoken.gpuDevice=`node:${pair.host.name}`;
    const ft=freeTokenNodeCapacity(snapshot.models,pair.host.name);
    if(!ft.capability.memoryStrategies?.includes(models.freetoken.freetoken.memoryStrategy) ||
      ft.gpuAvailableMi < models.freetoken.freetoken.gpuMemoryMi || ft.systemAvailableMi < models.freetoken.freetoken.systemMemoryMi)
      issues.push('freetoken-budget');
  } catch {issues.push('freetoken-telemetry');}
  if(issues.length)return {issues};
  return {issues,profile:{acknowledgeSharingTransitions:true,nodeName:pair.host.name,nodeUid:pair.host.nodeUid,bootId:pair.host.bootId,
    sharedSlots:2,devices:{amd:selected(pair.amd[0]!),nvidia:selected(pair.nvidia[0]!)},models}};
}

const filled=(value:unknown)=>typeof value === 'string' && value.length > 0 && !value.includes('CHANGEME');
const approved=(value:Json|undefined,field:string)=>value?.[field] === true;
const file=(value:unknown,snapshot:PreparationSnapshot)=>filled(value) && snapshot.readableFiles.includes(String(value));

export function inputReadiness(lab:LabConfig,profile:Json,snapshot:PreparationSnapshot,options:PreparationOptions):Readiness[] {
  type Issue={id:PreparationMeasureId;missing:string[];approvalNeeded?:boolean};
  const base:Issue[]=[];
  const check=(action:()=>void,id:PreparationMeasureId,reason:string)=>{try{action();}catch{base.push({id,missing:[reason]});}};
  check(()=>verifyIdentity(lab,snapshot.appliance,snapshot.observedAppliance,snapshot.nodes,snapshot.hosts),'identity',
    'The selected Appliance/Node/host identity, current boot or Ready state does not match the proposed pins.');
  check(()=>verifyCapabilities(lab,snapshot.models),'capability','A required compute target or engine is not currently advertised as available.');
  check(()=>verifyIdle(snapshot.hosts,snapshot.models,lab),'idle','An enabled local model or a non-terminal host/update/channel operation is present.');
  if(!snapshot.leaseIdle)base.push({id:'lease',missing:['The reviewed lab Lease is not idle.']});
  for(const warning of snapshot.modelWarnings ?? []) {
    // These source warnings are bounded, but never relay an arbitrary external
    // string into a console/report if a future producer adds private details.
    const id=warning === 'Current usable CPU RAM telemetry' ? 'cpu-telemetry' :
      warning === 'CPU vLLM discovery: current paged results and immutable artifact metadata' ? 'cpu-discovery' : 'cpu-model';
    const reasons:Record<string,string>={smokeModel:'The CPU smoke model metadata/estimate or retained RAM budget needs review.',
      ollamaModel:'The CPU Ollama model metadata/estimate or retained RAM budget needs review.',
      vllmModel:'The CPU vLLM model metadata/estimate or retained RAM budget needs review.'};
    const name=warning.match(/^CPU (smokeModel|ollamaModel|vllmModel): metadata\/estimator or reviewed RAM budget needs attention$/)?.[1];
    base.push({id,missing:[name ? reasons[name]! : id === 'cpu-model' ? 'A CPU fixture prerequisite could not be verified.' :
      id === 'cpu-telemetry' ? 'Current finite usable system-RAM measurements are unavailable.' : 'Paged discovery and immutable artifact metadata could not be verified.']});
  }
  for(const reference of [lab.observerKubeconfig,lab.lock?.kubeconfig,lab.modelCleanupKubeconfig,lab.usernameFile,lab.passwordFile])
    if(!file(reference,snapshot))base.push({id:'credentials',missing:['A required scoped credential or saved login file is not safely readable.']});
  const gates:Record<string,Issue[]>={};
  const add=(gate:string,id:PreparationMeasureId,requirements:Array<[unknown,string]>,approvalNeeded=false)=>{
    const missing=requirements.filter(([present])=>!present).map(([,reason])=>reason);
    if(missing.length)(gates[gate] ??= []).push({id,missing,approvalNeeded});
  };
  add('identity','users',[[approved(profile.identity,'approveDisposableUsers'),'Creating/changing/removing disposable test users has not been approved.']],
    !approved(profile.identity,'approveDisposableUsers'));
  const apps=profile.applications;
  add('applications','app-cleaner',[[file(apps?.cleanerKubeconfig,snapshot),'The separate app-intent cleaner is missing, unsafe or unreadable.']]);
  for(const type of ['openclaw','hermes','paperclip','kubeopencode','odysseus'] as const) {
    const fixture=apps?.fixtures?.find((item:Json)=>item.type === type);
    add('applications',`app-${type}`,[[snapshot.modules.catalogJson?.applications?.[type],'The application is not advertised in the current catalog.'],
      [fixture && (fixture.adapter === 'semantic-chat-v1' ? ['originTemplate','responseMarker'] :
        ['originTemplate','promptLabel','sendButton','responseSelector','responseMarker']).every(key=>filled(fixture[key])),
        'The reviewed HTTPS template and actual prompt/send/response controls are incomplete.']]);
  }
  add('applications','optional-module',[[filled(profile.modules?.id),'No reviewed disabled optional-module fixture was selected.'],
    [approved(profile.modules,'approveOptionalModule'),'The optional-module enable/disable test has not been approved.']],!approved(profile.modules,'approveOptionalModule'));
  add('applications','amd-profile',[[filled(profile.moduleProfile?.profileId),'No advertised alternate AMD profile fixture was selected.'],
    [approved(profile.moduleProfile,'approveTemporaryProfile'),'The temporary AMD profile change has not been approved.']],!approved(profile.moduleProfile,'approveTemporaryProfile'));
  add('identity','oidc-plugin',[[file(profile.kubernetes?.plugin?.filename,snapshot) && /^[a-f0-9]{64}$/.test(profile.kubernetes?.plugin?.sha256 ?? ''),
    'The executable Linux OIDC plugin and its verified SHA-256 are missing or unreadable.'],
    [approved(profile.kubernetes,'approveAdminGrant'),'Kubernetes grants to disposable test users have not been approved.']],!approved(profile.kubernetes,'approveAdminGrant'));
  add('license','licenses',[[file(profile.license?.validFile,snapshot) && profile.license?.invalidFiles?.length === 3 &&
    profile.license.invalidFiles.every((path:string)=>file(path,snapshot)),'The four private issuer/rejection license fixtures are incomplete or unreadable.'],
    [approved(profile.license,'approveLicenseReplacement'),'Temporary license replacement/restoration has not been approved.']],!approved(profile.license,'approveLicenseReplacement'));
  add('license','api-restarter',[[file(profile.license?.restart?.kubeconfig,snapshot),'The distinct narrow API-Pod restarter credential is missing or unreadable.'],
    [approved(profile.license?.restart,'approveApiRestart'),'The API-Pod restart has not been approved separately.']],!approved(profile.license?.restart,'approveApiRestart'));
  add('license','licenses',[[file(profile.license?.baseline?.kubeconfig,snapshot) && approved(profile.license?.baseline,'approveNoFileBaseline'),
    'Repeatable no-license tests need the separately scoped license-document reset/restore credential and explicit baseline consent.']],
    !approved(profile.license?.baseline,'approveNoFileBaseline'));
  add('federation','federation',[[profile.federation?.fixtures?.length === 2 && ['origin','realm','clientId'].every(key=>filled(profile.federation?.upstream?.[key])) &&
    file(profile.federation?.upstream?.clientSecretFile,snapshot) && file(profile.federation?.brokerCleaner?.clientSecretFile,snapshot),
    'The controlled test IdP, both protocol adapters or scoped client credentials are incomplete.'],
    [file(profile.federation?.expiringLicenseFile,snapshot) && file(profile.federation?.restoreLicenseFile,snapshot),'A fresh short-lived signed test license and the original restore document are required.'],
    [approved(profile.federation,'approveDisposableProviders'),'Disposable federation-provider changes have not been approved.']],!approved(profile.federation,'approveDisposableProviders'));
  add('mesh','mesh',[[file(profile.mesh?.peerConfig,snapshot) && filled(profile.mesh?.enrollmentOrigin),'The separate pinned peer configuration or enrollment origin is missing or unreadable.'],
    [approved(profile.mesh,'approveTwoAppliances') && approved(profile.mesh,'approveGpuTransitions'),'Mesh operations and GPU transitions on both appliances have not been approved.']],
    !approved(profile.mesh,'approveTwoAppliances') || !approved(profile.mesh,'approveGpuTransitions'));
  add('companion','companion',[[Number.isSafeInteger(profile.companion?.runId) && profile.companion.runId > 0 &&
    snapshot.ci?.companion?.runId === profile.companion.runId && snapshot.ci?.companion?.sourceRevision === profile.companion.sourceRevision &&
    lab.expected.flux?.revision.endsWith(profile.companion.sourceRevision) && /^[a-f0-9]{40}$/.test(profile.companion.sourceRevision ?? ''),
    'No fresh verified native companion run/artifact metadata matches the exact installed commit.']]);
  add('realtime','realtime',[[profile.realtime?.fixtures?.length === 2 &&
    profile.realtime.fixtures.every((item:Json)=>snapshot.models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles?.[item.fixture?.realtime?.profile]),
    'The exclusive and shared Realtime fixtures with current advertised Omni profiles are missing.'],
    [approved(profile.realtime,'approveGpuTransitions'),'Realtime GPU transitions have not been approved.']],!approved(profile.realtime,'approveGpuTransitions'));
  add('repeat','repeat',[[Number.isInteger(profile.repeat?.cycles) && profile.repeat.cycles >= 3 && profile.repeat.cycles <= 10,'The reviewed cycle count is outside 3–10 or missing.']]);
  add('supply-chain','security-ci',[[profile.securityCi?.dependenciesRunId > 0 && profile.securityCi?.publicationRunId > 0 &&
    snapshot.ci?.securityCi?.dependenciesRunId === profile.securityCi.dependenciesRunId &&
    snapshot.ci?.securityCi?.publicationRunId === profile.securityCi.publicationRunId && snapshot.ci?.securityCi?.sourceRevision === profile.securityCi.sourceRevision &&
    /^[a-f0-9]{40}$/.test(profile.securityCi?.sourceRevision ?? '') && lab.expected.flux?.revision.endsWith(profile.securityCi.sourceRevision),
    'No fresh verified successful dependency-security and public-release runs match the exact installed commit.']]);
  const physicalGates=['maintenance','network','channel','cache','reboot'];
  let recipes:HostDrillRecipes|undefined;
  const drillNode=(snapshot.drills as {nodeUid?:string}|undefined)?.nodeUid;
  const recipeNode=lab.gpu?.nodeUid ?? (options.automatic && lab.expected.nodes.some(node=>node.uid === drillNode) ? drillNode : undefined);
  if(options.approve.includes('host-drills') && recipeNode)try{recipes=recipeBundle(snapshot.drills,lab.expected.applianceUid,recipeNode);}catch{/* No guessed or foreign physical recipe. */}
  for(const gate of physicalGates)add(gate,'physical-drill',[[Boolean(recipes),
    'Setup needs installation-bound destructive consent, independent recovery and typed host-test recipes; an old one-boot plan does not authorize a campaign.']]);
  const gpuReasons:Record<GpuInputIssue,string>={
    'mixed-hardware':'No unambiguous managed node with exactly one detected AMD GPU and one NVIDIA GPU is available.',
    'device-selection':'The retained GPU identities no longer match, or more than one mixed node needs an explicit reviewed selection.',
    'sharing-approval':'Temporary AMD/NVIDIA sharing transitions have not been approved for this installation.',
    fixtures:'The advertised small AMD/NVIDIA Ollama/vLLM fixtures or the reviewed FreeToken fixture are incomplete.',
    'freetoken-telemetry':'The FreeToken capability or current physical NVIDIA VRAM/system-RAM telemetry could not be verified.',
    'freetoken-budget':'The FreeToken memory strategy or retained GPU/RAM budget does not fit current supported capacity.',
  };
  return options.phases.map(phase=>{
    const shared=[...base],gpuPhase=[3,4,6,7,8].includes(phase);
    try {if(options.automatic) { /* Runtime checks each fixture/provider independently. */ }
      else if(phase === 0)requirePhase0Profile(lab); else if(phase === 1)requirePhase1Profile(lab);
      else if(phase === 2)requirePhase2Profile(lab);else if(gpuPhase)requireGpuProfile(lab);else requirePhase1Profile(lab);}
    catch{shared.push(gpuPhase ? {id:'gpu-profile',missing:snapshot.gpuIssues?.length ? snapshot.gpuIssues.map(issue=>gpuReasons[issue]) :
      ['The complete current mixed-GPU/CPU profile, trusted CA and Inference pins are not present.'],
      approvalNeeded:snapshot.gpuIssues?.includes('sharing-approval') ?? !(lab.gpu?.acknowledgeSharingTransitions || options.approve.includes('gpu'))} :
      {id:'cpu-profile',missing:['The complete CPU fixture, Inference endpoint, current boot and web/API/source pins are required.']});}
    const issues=[...shared];
    const requirements=phase >= 5 ? remainingRequirements(`phase${phase}`) ?? [] : [];
    const cases=[...new Map(requirements.map(item=>[item.variant,item])).values()].map(item=>{
      const needed=[...(item.gate ? gates[item.gate] ?? [] : [])];
      if(item.gate && physicalGates.includes(item.gate) && hostDrillIds.includes(item.id) && recipes && !recipes.cases[item.id])needed.push({id:'physical-drill',
        missing:[`The reviewed typed recipe for ${item.id} was not completed in setup.`]});
      if(item.group === 'kubernetes')needed.push(...(gates.identity ?? []));
      if(item.id === 'KEY-04' && (!approved(profile.unmanagedKey,'approveDisposableProbe') || !filled(profile.unmanagedKey?.id) && profile.unmanagedKey?.createDisposableFixture !== true))needed.push({id:'unmanaged-key',
        missing:[...(!filled(profile.unmanagedKey?.id) && profile.unmanagedKey?.createDisposableFixture !== true ? ['No real disposable unmanaged-key fixture or automatic fixture plan was supplied.'] : []),
          ...(!approved(profile.unmanagedKey,'approveDisposableProbe') ? ['The denied-delete probe on that disposable fixture has not been approved.'] : [])]});
      issues.push(...needed);return {id:item.id,variant:item.variant,state:needed.length || shared.length ? 'Blocked' as const : 'InputsReady' as const};
    });
    const merged=new Map<PreparationMeasureId,Issue>();
    for(const issue of issues) {
      const previous=merged.get(issue.id);merged.set(issue.id,{...issue,missing:[...new Set([...(previous?.missing ?? []),...issue.missing])],
        approvalNeeded:previous?.approvalNeeded || issue.approvalNeeded});
    }
    const measures=[...merged.values()].map(issue=>options.automatic ? automaticPreparationMeasure(issue.id,issue.missing) :
      preparationMeasure(issue.id,issue.missing,phase,issue.approvalNeeded));
    return {phase,state:measures.length ? 'Blocked' : 'InputsReady',blockers:measures.map(item=>item.blocker),measures,
      testExecutionVerified:false,...(cases.length ? {cases} : {})};
  });
}

/** Only explicit CLI approval or a previously accepted approval can set a gate.
 * The command generates files; it does NOT perform any of these operations. */
export function preparedProfile(previous:Json,snapshot:PreparationSnapshot,options:PreparationOptions,previousExpected?:LabConfig['expected']):Json {
  const profile:Json=structuredClone(previous);
  // A replaced appliance/node is a new lab, not inherited consent for acting
  // on the old installation. Named approvals can be reviewed again explicitly.
  if(previousExpected && (previousExpected.applianceUid !== snapshot.observedAppliance.metadata.uid ||
    previousExpected.nodes.some(node=>!snapshot.nodes.some(current=>current.metadata.uid === node.uid)))) {
    const reset=(value:Json)=>{for(const [key,item] of Object.entries(value)) {
      if(key.startsWith('approve') || key === 'allowFirstActivation')value[key]=false;
      else if(item && typeof item === 'object')reset(item as Json);
    }};
    reset(profile);
  }
  profile.version=1;
  profile.identity ??= {approveDisposableUsers:false};
  profile.applications ??= {cleanerKubeconfig:'/inputs/app-cleaner.kubeconfig',fixtures:[]};
  profile.kubernetes ??= {approveAdminGrant:false,plugin:{filename:'/inputs/kubectl-oidc_login',sha256:''}};
  profile.license ??= {approveLicenseReplacement:false,allowFirstActivation:false,validFile:'/inputs/license-valid.license',
    invalidFiles:['/inputs/license-expired.license','/inputs/license-wrong-installation.license','/inputs/license-tampered.license'],
    restart:{approveApiRestart:false,kubeconfig:'/inputs/api-restarter.kubeconfig'}};
  profile.license.baseline ??= {approveNoFileBaseline:false,kubeconfig:'/inputs/license-resetter.kubeconfig'};
  profile.cache ??= {approveFreeToken:false};
  profile.repeat ??= {cycles:3,maximumMemoryGrowthMi:1024,maximumNonCacheDiskGrowthBytes:268435456};
  const flags:Record<string,[string,string][]>={identity:[['identity','approveDisposableUsers']],kubernetes:[['kubernetes','approveAdminGrant']],
    license:[['license','approveLicenseReplacement'],['license.baseline','approveNoFileBaseline']],federation:[['federation','approveDisposableProviders']],
    'api-restart':[['license.restart','approveApiRestart']],'first-license':[['license','allowFirstActivation']],
    modules:[['modules','approveOptionalModule']],'amd-profile':[['moduleProfile','approveTemporaryProfile']],
    mesh:[['mesh','approveTwoAppliances'],['mesh','approveGpuTransitions']],realtime:[['realtime','approveGpuTransitions']],cache:[['cache','approveFreeToken']],
    'unmanaged-key':[['unmanagedKey','approveDisposableProbe']]};
  for(const flag of options.approve)for(const [section,field] of flags[flag] ?? []) {
    let object=profile;for(const part of section.split('.')) {object[part] ??= {};object=object[part];}object[field]=true;
  }
  if(snapshot.ci?.securityCi)profile.securityCi={...profile.securityCi,...snapshot.ci.securityCi};
  if(snapshot.ci?.companion)profile.companion={...profile.companion,...snapshot.ci.companion};
  return profile;
}

export function prepareInputs(previous:Json,snapshot:PreparationSnapshot,options:PreparationOptions,gpuDefaults:Json) {
  const lab:Json=structuredClone(previous);
  const metadata=snapshot.observedAppliance.metadata;
  requireSafe(metadata.uid && metadata.name && metadata.namespace && snapshot.images.length >= 2,'CONFIG');
  const retainedNames=previous.expected?.nodes?.map((node:Json)=>node.name) as string[]|undefined;
  const nodes=snapshot.nodes.filter(node=>!retainedNames || retainedNames.includes(node.metadata.name ?? ''));
  requireSafe(nodes.length > 0 && (!retainedNames || nodes.length === retainedNames.length),'IDENTITY');
  lab.version=1;lab.profile='preflight';
  lab.expected={applianceUid:metadata.uid,applianceName:metadata.name,applianceNamespace:metadata.namespace,role:'magicstick-admin',
    nodes:nodes.map(node=>({name:node.metadata.name,uid:node.metadata.uid,bootId:node.status?.nodeInfo?.bootID})),
    capabilities:(!options.automatic ? previous.expected?.capabilities : undefined) ?? snapshot.models.computeTargets.targets.filter(item=>item.available).map(item=>
      ({target:item.id,engines:(item.engines ?? []).filter(engine=>engineRegressionEnabled(engine) &&
        item.engineAvailability?.[engine]?.available !== false)})).filter(item=>item.engines.length),
    flux:snapshot.flux,images:snapshot.images};
  // First setup uses catalog defaults; repeat prepare retains reviewed fixtures.
  lab.smokeModel ??= catalogFixture(snapshot.models,'OLlama','cpu');
  if(!lab.phase2) {
    const vllm=catalogFixture(snapshot.models,'VLLM','cpu'),ollama=catalogFixture(snapshot.models,'OLlama','cpu');
    // Model form edits use a 100-MiB step; round only the Phase 2 budgets up.
    // Existing independently reviewed values are never changed.
    const stepped=(fixture:RuntimeModelFixture)=>({...fixture,memoryRequiredMi:Math.ceil(fixture.memoryRequiredMi/100)*100});
    if(vllm && ollama)lab.phase2={vllmModel:stepped(vllm),ollamaModel:stepped(ollama),
      failureModel:{...stepped(ollama),url:'ollama://magicstick-regression-missing:never',expectedReason:'startup failed'},
      externalModel:{source:'owned-ollama',apiBase:'http://kubeai.ai.svc.cluster.local/openai/v1',contextWindow:2048},
      discovery:{query:vllm.url.split('/')[2],repo:vllm.url.slice(5),artifactUrl:vllm.url}};
  }
  let gpuProblem=false;
  let gpuIssues:GpuInputIssue[]=[];
  if(!options.automatic && (options.phases.some(phase=>[3,4,6,7,8].includes(phase)) || previous.gpu)) {
    try {const result=gpuProfile(previous,snapshot,options,gpuDefaults);gpuIssues=result.issues;
      if(result.profile)lab.gpu=result.profile;else {delete lab.gpu;gpuProblem=true;}}
    catch {delete lab.gpu;gpuProblem=true;gpuIssues=['fixtures'];}
  }
  const parsed=parseLabConfig(lab,'/inputs');
  verifyIdentity(parsed,snapshot.appliance,snapshot.observedAppliance,snapshot.nodes,snapshot.hosts);
  verifyCapabilities(parsed,snapshot.models);
  return {lab,parsed,gpuProblem,gpuIssues};
}

export function preparedReboot(lab:LabConfig,snapshot:PreparationSnapshot,options:PreparationOptions) {
  if(!options.drill)return undefined;
  requireSafe(options.approve.includes('reboot') && options.independentRecovery && lab.gpu,'PREREQUISITE');
  const host=snapshot.hosts.find(item=>item.nodeUid === lab.gpu!.nodeUid);
  requireSafe(host?.available && host.kernel && host.bootId === lab.gpu.bootId,'HOST');
  return {version:1,cases:{'BOOT-02':{caseId:'BOOT-02',acknowledgeDisruption:true,independentRecoveryAvailable:true,
    request:{action:'reboot',nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,confirmation:host.name,
      acknowledgeDisruption:true,allowExperimental:false,experimentMode:false},
    expected:{bootChanges:1,kernel:host.kernel,terminal:'Succeeded'}}}};
}

export function pinChanges(before:Json,after:Json):string[] {
  if(!before.expected)return ['initial identity','source revision','critical image digests'];
  const result:string[]=[];
  for(const [label,old,next] of [
    ['appliance identity',[before.expected.applianceUid,before.expected.applianceName,before.expected.applianceNamespace],
      [after.expected.applianceUid,after.expected.applianceName,after.expected.applianceNamespace]],
    ['node identity',before.expected.nodes.map((node:Json)=>({name:node.name,uid:node.uid})),after.expected.nodes.map((node:Json)=>({name:node.name,uid:node.uid}))],
    ['boot identity',before.expected.nodes.map((node:Json)=>node.bootId),after.expected.nodes.map((node:Json)=>node.bootId)],
    ['source revision',before.expected.flux,after.expected.flux],['critical image digests',before.expected.images,after.expected.images],
    ['GPU profile/approval',before.gpu,after.gpu],
    ['model fixture configuration',[before.smokeModel,before.phase2],[after.smokeModel,after.phase2]],
  ])if(canonicalInput(old) !== canonicalInput(next))result.push(String(label));
  return result;
}

export function validateAcceptance(plan:Json,currentHash:string,snapshotHash:string,now=Date.now()) {
  requireSafe(plan.version === 1 && plan.kind === 'input-preparation' && plan.originalHash === currentHash &&
    plan.snapshotHash === snapshotHash && Number.isFinite(Date.parse(plan.createdAt)) && now >= Date.parse(plan.createdAt) &&
    now-Date.parse(plan.createdAt) <= 900_000,'REVISION');
}

/** Private input writes do not mutate the appliance. An interrupted automatic
 * transaction can be regenerated only after fresh registration/Lease checks;
 * a legacy reviewed acceptance must never be implicitly adopted. */
export function automaticInputRecovery(receipt:unknown,automatic:boolean):string|undefined {
  if(!receipt)return;
  const value=receipt as Json;
  requireSafe(automatic && value.version === 1 && value.automatic === true &&
    Object.keys(value).sort().join(',') === 'automatic,id,version' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id),'CONFIG');
  return value.id;
}
