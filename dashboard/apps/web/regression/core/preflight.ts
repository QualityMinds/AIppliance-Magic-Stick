import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import type {Appliance, ManagedHost, ModelsPayload} from '@magicstick/dashboard-contracts';
import type {LabConfig} from './config.ts';
import type {KubeObject, KubectlObserver} from './observer.ts';
import {HarnessError, requireSafe} from './errors.ts';
import {engineRegressionEnabled} from './engine-policy.ts';
import {poll} from './poll.ts';
import {newPreflightDiagnostic,pinIdentity,pinPod,recordPinObservation,safePinReason,
  type PinCheck,type PinObservation,type PinReference,type ObservationWindow,type PreflightDiagnostic} from './preflight-diagnostic.ts';

export type {PinCheck} from './preflight-diagnostic.ts';
/** Only readiness may converge. A different source/image is never retried. */
export class DeploymentPinError extends HarnessError {
  readonly checks:PinCheck[];
  readonly retryable:boolean;
  constructor(checks:PinCheck[],retryable:boolean) {
    const failure=checks.find(c=>['identity','revision','image','missing'].includes(c.condition))??checks.find(c=>c.condition!=='ready');
    super('REVISION','Failed',failure?.component==='flux'?'flux-ready':'preflight');
    this.checks=checks;this.retryable=retryable;
  }
}

export async function verifiedEndpoint(url: string, timeoutMs: number, ca?: string): Promise<void> {
  requireSafe(new URL(url).protocol === 'https:', 'TLS');
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(url, {method: 'HEAD', ...(ca ? {ca} : {})}, response => {
      // Authentication redirects/401 are expected here. Only connectivity/TLS is accepted.
      response.resume(); resolve();
    });
    const timer = setTimeout(() => { request.destroy(); reject(new HarnessError('TLS')); }, timeoutMs);
    request.on('error', () => { clearTimeout(timer); reject(new HarnessError('TLS')); });
    request.on('response', () => clearTimeout(timer));
    request.end();
  });
}

export function verifyIdentity(config: LabConfig, appliance: Appliance, observedAppliance: KubeObject, nodes: KubeObject[], hosts: ManagedHost[]) {
  requireSafe(appliance.metadata?.uid === config.expected.applianceUid && observedAppliance.metadata.uid === config.expected.applianceUid &&
    appliance.metadata.name === config.expected.applianceName && appliance.metadata.namespace === config.expected.applianceNamespace, 'IDENTITY');
  for (const expected of config.expected.nodes) {
    const node = nodes.find(item => item.metadata.name === expected.name), host = hosts.find(item => item.name === expected.name);
    requireSafe(node?.metadata.uid === expected.uid && host?.nodeUid === expected.uid, 'IDENTITY');
    const bootId = node.status?.nodeInfo?.bootID;
    if (!bootId || host.bootId !== bootId || (expected.bootId && expected.bootId !== bootId)) {
      throw new HarnessError('HOST', 'Blocked', 'host-boot');
    }
    if (!node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') || host.available !== true) {
      throw new HarnessError('HOST', 'Blocked', 'host-readiness');
    }
  }
}

export function verifyCapabilities(config: LabConfig, models: ModelsPayload) {
  requireSafe(Array.isArray(models.computeTargets?.targets) && Array.isArray(models.activations), 'API');
  for (const expected of config.expected.capabilities) {
    const engines=expected.engines.filter(engineRegressionEnabled);
    // Old saved inputs can pin an excluded experimental engine. Its absence
    // must not block unrelated classic-engine tests or change product settings.
    if(!engines.length)continue;
    const target = models.computeTargets.targets.find(item => item.id === expected.target);
    requireSafe(target?.available === true && engines.every(engine => target.engines?.includes(engine) &&
      target.engineAvailability?.[engine]?.available !== false), 'CAPABILITY');
  }
}

export function verifyIdle(hosts: ManagedHost[], models: ModelsPayload, config: LabConfig) {
  const selected = new Set(config.expected.nodes.map(item => item.name));
  const terminal = new Set(['Succeeded', 'Failed', 'Cancelled','RolledBack','Interrupted','Rejected']);
  requireSafe(hosts.filter(host => selected.has(host.name)).every(host => !host.updates?.busy && !host.software?.busy &&
    (!host.operation || terminal.has(host.operation.phase))), 'BUSY');
  // Phase 0 is conservative: active local definitions, even without a Pod, block it.
  requireSafe(models.activations.every(item => item.spec?.type !== 'local' || item.spec?.enabled === false), 'BUSY');
}

export async function verifyDeploymentPins(config: LabConfig, observer: Pick<KubectlObserver, 'get' | 'list'>,
  pods: KubeObject[], flux: KubeObject[],identities?:Map<string,string>,sampling?:{
    podsObserved?:ObservationWindow;fluxObserved?:ObservationWindow;
    capture:(checks:PinObservation['checks'],references:PinReference[])=>void}) {
  const checks:PinCheck[]=[];
  const details:PinObservation['checks']=[],references:PinReference[]=[];
  const reference=(item:KubeObject,component:PinCheck['component'],index:number,kind:PinReference['kind'])=>{
    if(item.metadata.namespace&&item.metadata.name&&item.metadata.uid)references.push({component,index,kind,
      namespace:item.metadata.namespace,name:item.metadata.name,uid:item.metadata.uid,...(item.metadata.generation!==undefined?{generation:item.metadata.generation}:{})});
  };
  const sameIdentity=(key:string,item:KubeObject)=>{
    const value=JSON.stringify([item.metadata.uid,item.metadata.generation]);
    const previous=identities?.get(key);identities?.set(key,previous??value);
    return previous===undefined||previous===value;
  };
  if (config.expected.flux) {
    const expected = config.expected.flux;
    const item = flux.find(entry => entry.metadata.name === expected.name && entry.metadata.namespace === expected.namespace);
    checks.push({component:'flux',index:0,condition:!item?'missing':!sameIdentity('flux',item)?'identity':
      item.status?.lastAppliedRevision!==expected.revision?'revision':
      item.status?.conditions?.some(condition =>
      condition.type === 'Ready' && condition.status === 'True' &&
      (condition.observedGeneration ?? item.status?.observedGeneration) === item.metadata.generation)?'ready':'readiness'});
    const ready=item?.status?.conditions?.find(c=>c.type==='Ready');
    if(item)reference(item,'flux',0,'flux');
    // Missing timing is unknown, not a fabricated atomic cluster snapshot.
    details.push({...checks.at(-1)!,...(item?pinIdentity(item):{}),...(sampling?.fluxObserved?{observed:sampling.fluxObserved}:{}),
      ...(typeof item?.status?.lastAppliedRevision==='string'?{sourceMatches:item.status.lastAppliedRevision===expected.revision}:{}),
      ...(ready?{readyCondition:{status:['True','False'].includes(ready.status)?ready.status as 'True'|'False':'Unknown',reason:safePinReason(ready.reason),
        ...(Number.isSafeInteger(ready.observedGeneration)?{observedGeneration:ready.observedGeneration}:{})}}:{})});
  }
  sampling?.capture(details,references);
  for (const [index,expected] of config.expected.images.entries()) {
    const startedAt=new Date().toISOString();
    const deployment = await observer.get('deployments.apps', expected.namespace, expected.deployment);
    const finishedAt=new Date().toISOString();
    const replicasets = await observer.list('replicasets.apps', expected.namespace);
    const ownedSets=replicasets.filter(item => item.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid));
    const owners = new Set(ownedSets.map(item => item.metadata.uid));
    const ownedPods=pods.filter(item => item.metadata.namespace === expected.namespace && item.metadata.ownerReferences?.some(owner => owners.has(owner.uid)));
    const containers = ownedPods
      .flatMap(item => item.status?.containerStatuses ?? []).filter(item => item.name === expected.container);
    checks.push({component:'deployment',index,condition:
      !sameIdentity('deployment-'+index,deployment)?'identity':
      containers.some(item=>item.imageID&&!item.imageID.endsWith(expected.digest))?'image':
      deployment.metadata.generation!==deployment.status?.observedGeneration?'generation':
      !(Number(deployment.status?.readyReplicas)>0)?'replicas':!containers.length?'containers':
      !containers.every(item=>item.ready&&item.imageID?.endsWith(expected.digest))?'readiness':'ready'});
    reference(deployment,'deployment',index,'deployment');
    for(const set of ownedSets)reference(set,'deployment',index,'replicaset');
    for(const pod of ownedPods)reference(pod,'deployment',index,'pod');
    details.push({...checks.at(-1)!,...pinIdentity(deployment),observed:{startedAt,finishedAt},
      ...(sampling?.podsObserved?{podsObserved:sampling.podsObserved}:{}),
      ...(Number.isSafeInteger(deployment.spec?.replicas)&&Number(deployment.spec?.replicas)>=0?{desiredReplicas:Number(deployment.spec!.replicas)}:{}),
      ...(Number.isSafeInteger(deployment.status?.readyReplicas)&&Number(deployment.status?.readyReplicas)>=0?{readyReplicas:deployment.status!.readyReplicas}:{}),
      pods:ownedPods.slice(0,12).map(p=>pinPod(p,expected.container,expected.digest)),omittedPods:Math.max(0,ownedPods.length-12)});
    sampling?.capture(details,references);
  }
  sampling?.capture(details,references);
  if(checks.some(c=>c.condition!=='ready'))throw new DeploymentPinError(checks,
    !checks.some(c=>['identity','revision','image','missing'].includes(c.condition)));
  return checks;
}

/** A baseline is not an atomic cluster snapshot. Refresh all observations after
 * a readiness-only miss, before acquiring a Lease or creating any test object.
 * Reads/auth/identity errors and different pins remain immediate failures. */
export async function waitForDeploymentPins<T extends {pods:KubeObject[];flux:KubeObject[];pinReadWindows?:{pods:ObservationWindow;flux:ObservationWindow}}>(config:LabConfig,
  observer:Pick<KubectlObserver,'get'|'list'>,read:()=>Promise<T>,options:{timeoutMs:number;
    now?:()=>number;wait?:(ms:number)=>Promise<void>;
    diagnostic?:(value:PreflightDiagnostic)=>Promise<void>;
    firstFailure?:(value:PinObservation,references:PinReference[])=>Promise<Pick<PreflightDiagnostic,'events'|'logs'>>}):Promise<T> {
  let last:DeploymentPinError|undefined,attempt=0;
  const identities=new Map<string,string>();
  const diagnostic=newPreflightDiagnostic();let collected=false,active=true;
  // A missing diagnostic must never replace the original observation failure.
  const save=async()=>{try{await options.diagnostic?.(structuredClone(diagnostic));}catch{/* optional diagnostic sink */}};
  try {
    const accepted=await poll(async signal=>{
      attempt++;const startedAt=new Date().toISOString();let details:PinObservation['checks']=[],references:PinReference[]=[];
      const sample=()=>({attempt,startedAt,finishedAt:new Date().toISOString(),
        checks:[...details.filter(c=>c.condition!=='ready'),...details.filter(c=>c.condition==='ready')].slice(0,16),
        ...(details.length>16?{omittedChecks:details.length-16}:{})});
      try {
        const value=await read();
        signal.throwIfAborted();
        await verifyDeploymentPins(config,observer,value.pods,value.flux,identities,{podsObserved:value.pinReadWindows?.pods,
          fluxObserved:value.pinReadWindows?.flux,capture:(checks,refs)=>{details=checks;references=refs;}});
        signal.throwIfAborted();
        recordPinObservation(diagnostic,sample());
        diagnostic.state='converged';await save();
        return {value,ready:true};
      }catch(error) {
        if(!active)throw error;
        if(error instanceof DeploymentPinError)last=error;
        const code=error instanceof HarnessError?error.code:'UNEXPECTED';
        recordPinObservation(diagnostic,{...sample(),
          ...(!(error instanceof DeploymentPinError)?{readFailure:(['API','AUTH','OBSERVER','IDENTITY','HOST','CAPABILITY','LAB'].includes(code)?code:'UNEXPECTED') as NonNullable<PinObservation['readFailure']>}:{} )});
        if(!collected&&options.firstFailure){diagnostic.events.state='pending';diagnostic.logs={state:'pending',streams:0};}
        await save(); // Persist the first failure before slow diagnostic reads.
        if(!collected&&diagnostic.firstFailure){
          collected=true;
          if(options.firstFailure){
            try{const extra=await options.firstFailure(diagnostic.firstFailure,references);if(active)Object.assign(diagnostic,extra);}
            catch{diagnostic.events.state='unavailable';diagnostic.logs={state:'unavailable',streams:0,reason:'collection-failed'};}
            if(!active)throw error;
            await save();
          }
        }
        if(!(error instanceof DeploymentPinError))throw error;
        if(!error.retryable)throw error;
        return {value:undefined,ready:false};
      }
    },value=>value.ready,{timeoutMs:options.timeoutMs,intervalMs:500,now:options.now,wait:options.wait,stage:'preflight'});
    active=false;return accepted.value!;
  }catch(error) {
    active=false;
    if(diagnostic.events.state==='pending')diagnostic.events.state='unavailable';
    if(diagnostic.logs.state==='pending')diagnostic.logs={state:'unavailable',streams:0,reason:'collection-failed'};
    diagnostic.state='failed';await save();
    // Preserve the specific failed pin check, not a generic polling deadline.
    if(error instanceof HarnessError&&error.code==='DEADLINE'&&last)throw last;
    throw error;
  }
}

export function safeBaseline(config: LabConfig, nodes: KubeObject[], pods: KubeObject[], models: ModelsPayload, flux: KubeObject[]) {
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  return {version: 1, targetFingerprint: fingerprint(config.expected.applianceUid),
    nodes: config.expected.nodes.map((expected, index) => {
      const node = nodes.find(item => item.metadata.uid === expected.uid)!;
      return {alias: `node-${index + 1}`, uidFingerprint: fingerprint(expected.uid), bootFingerprint: fingerprint(node.status?.nodeInfo?.bootID ?? ''),
        kernel: /^[0-9a-zA-Z.+-]+$/.test(node.status?.nodeInfo?.kernelVersion ?? '') ? node.status?.nodeInfo?.kernelVersion : 'unknown'};
    }),
    computeTargets: models.computeTargets.targets.map(item => ({id: /^[a-z0-9-]+$/.test(item.id) ? item.id : 'unknown', available: item.available === true,
      engines: (item.engines ?? []).filter(engine => /^[a-zA-Z0-9-]+$/.test(engine))})),
    imageDigests: [...new Set(pods.flatMap(pod => (pod.status?.containerStatuses ?? []).map(container =>
      container.imageID?.match(/sha256:[0-9a-f]{64}/)?.[0]).filter((digest): digest is string => Boolean(digest))))].sort(),
    fluxRevisions: [...new Set(flux.map(item => item.status?.lastAppliedRevision?.match(/(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/)?.[0])
      .filter((revision): revision is string => Boolean(revision)))],
    pins: {flux: Boolean(config.expected.flux), criticalImages: config.expected.images.length, bootIds: config.expected.nodes.filter(item => item.bootId).length},
    nonTestDefinitions: models.activations.length, observedPodCount: pods.length,
    mutationsEnabled: false, cleanupAdaptersEnabled: false};
}
