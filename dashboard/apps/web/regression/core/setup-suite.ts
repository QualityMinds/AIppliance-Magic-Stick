import type {ModelsPayload, ModulesPayload, SystemStatusPayload, ManagedHost} from '@magicstick/dashboard-contracts';
import {requireSafe} from './errors.ts';
import {editRevision} from './owned-model.ts';
import {approvals,type Approval,type PreparationOptions,type PreparationSnapshot} from './input-preparation.ts';
import {canonicalInput} from './input-preparation.ts';
import type {LabConfig} from './config.ts';

/** Owner consent is data, not an administrator credential or a preflight bypass.
 * Boots may change during a reviewed drill; physical installation IDs may not. */
export interface SetupConsent {
  version:1; testLab:true; applianceUid:string; nodeUids:string[];
  phases:number[]; scopes:Approval[]; confirmedAt:string;
}
export function savedSetupOptions(options:PreparationOptions,consent:unknown,snapshot:PreparationSnapshot):PreparationOptions {
  if(consent === undefined)return options;
  const value=consent as SetupConsent;
  requireSafe(value?.version === 1 && value.testLab === true && Array.isArray(value.nodeUids) && value.nodeUids.length > 0 &&
    value.nodeUids.every(uid=>typeof uid === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(uid)) && new Set(value.nodeUids).size === value.nodeUids.length &&
    Array.isArray(value.phases) && value.phases.every(phase=>Number.isInteger(phase) && phase >= 0 && phase <= 8) &&
    value.phases.length > 0 && new Set(value.phases).size === value.phases.length &&
    Array.isArray(value.scopes) && value.scopes.every(scope=>approvals.includes(scope)) && new Set(value.scopes).size === value.scopes.length &&
    Number.isFinite(Date.parse(value.confirmedAt)) && Date.parse(value.confirmedAt) <= Date.now()+300_000,'CONFIG');
  requireSafe(value.applianceUid === snapshot.observedAppliance.metadata.uid &&
    value.nodeUids.length === snapshot.nodes.length && value.nodeUids.every(uid=>snapshot.nodes.some(node=>node.metadata.uid === uid)),'IDENTITY');
  // Consent for one selected subset never authorizes another subset implicitly.
  return {...options,approve:[...new Set([...options.approve,...(options.phases.every(phase=>value.phases.includes(phase)) ? value.scopes : [])])],
    independentRecovery:options.independentRecovery};
}

/** Only proved owned host operations may advance boots/source/images. Every
 * credential, endpoint, identity, model, budget and approval stays unchanged. */
export function verifyHostContinuation(before:LabConfig,next:LabConfig) {
  requireSafe(next.expected.applianceUid === before.expected.applianceUid && next.expected.nodes.length === before.expected.nodes.length &&
    next.expected.nodes.every(node=>before.expected.nodes.some(old=>old.uid === node.uid && old.name === node.name)),'IDENTITY');
  const normalized=(value:LabConfig)=>{
    const clone=structuredClone(value);
    clone.expected.nodes=clone.expected.nodes.map(node=>({...node,bootId:''}));
    clone.expected.images=clone.expected.images.map(image=>({...image,digest:''}));
    if(clone.expected.flux)clone.expected.flux.revision='';
    if(clone.gpu)clone.gpu.bootId='';
    return canonicalInput(clone);
  };
  requireSafe(normalized(before) === normalized(next),'CONFIG');
}

/** Small, private, allowlisted inventory for the terminal wizard. Never export
 * settings Secrets, environment variables, API keys or arbitrary model specs. */
export function suiteInventory(models:ModelsPayload,modules:ModulesPayload,status:SystemStatusPayload,hosts:ManagedHost[]) {
  const optionalModules=Object.entries(modules.catalogJson?.modules ?? {}).filter(([id,item])=>item.activationMode === 'moduleactivation' &&
    !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh|model-catalog|magicstick-operator/.test(id))
    .map(([id,item])=>({id,disabled:modules.modules[id]?.enabled !== true,
      parameters:modules.modules[id]?.parameters ?? {},fields:(item.parameters ?? []).map(field=>({name:field.name,label:field.label ?? field.name}))}));
  const amd=status.hardwareOperators?.['amd-gpu']?.compatibility;
  const profiles=Object.entries(models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {});
  const realtime=profiles.flatMap(([id,profile])=>(models.computeTargets.realtimeDevices ?? []).filter(device=>
    device.profile === id && device.supported && profile.gpuCounts.includes(1) && ['nvidia-gpu','amd-gpu'].includes(device.computeTarget ?? ''))
    .map(device=>({id,model:profile.model,node:device.node,computeTarget:device.computeTarget,
      contextWindow:Math.min(2048,profile.defaultContextWindow,profile.maxContextWindow ?? 2048),
      maxContextWindow:profile.maxContextWindow ?? profile.defaultContextWindow,
      systemMemoryMi:profile.defaultSystemMemoryMi,availableSystemMemoryMi:device.systemMemoryMi,
      gpuMemoryMi:device.gpuMemoryMi,maxCpuOffloadGiB:profile.maxCpuOffloadGiB ?? 0})));
  return {nodes:hosts.map(host=>({name:host.name,nodeUid:host.nodeUid})),
    activeModels:models.activations.filter(item=>item.spec?.type === 'local' && item.spec.enabled !== false).map(item=>({
      name:item.metadata!.name,uid:item.metadata!.uid,generation:item.metadata!.generation,revision:editRevision(item)})),
    applications:Object.keys(modules.catalogJson?.applications ?? {}).filter(type=>['openclaw','hermes','paperclip','kubeopencode','odysseus'].includes(type)),
    optionalModules,amdProfiles:(amd?.profiles ?? []).filter(profile=>profile.id !== amd?.selectedProfile).map(profile=>({id:profile.id,experimental:profile.experimental})),
    realtime,hosts:hosts.map(host=>({name:host.name,nodeUid:host.nodeUid,bootId:host.bootId,kernel:host.kernel,available:host.available,
      plan:host.plan,gpuMemory:host.gpuMemory,network:host.network,updates:host.updates ? {id:host.updates.id,policy:host.updates.policy,rebootRequired:host.updates.rebootRequired} : null,
      modelCache:host.modelCache,software:host.software ? {id:host.software.id,channel:host.software.channel,hostCommit:host.software.hostCommit,preview:host.software.preview} : null}))};
}
