import type {ModelActivation} from '@magicstick/dashboard-contracts';
import type {KubeObject} from './observer.ts';
import {requireSafe} from './errors.ts';

const phases=['Pending','Running','Succeeded','Failed','Unknown','Starting','Ready','Degraded','Disabled','Stopped','WaitingForPod','WaitingForModules'];
const causes=['OOMKilled','Error','Completed','CrashLoopBackOff','ImagePullBackOff','ErrImagePull','ContainerCreating','PodInitializing',
  'CreateContainerConfigError','CreateContainerError','RunContainerError','StartError','ContainerStatusUnknown'];
const phase=(value:unknown)=>typeof value==='string' && phases.includes(value)?value:'Unknown';
const cause=(value:unknown)=>typeof value==='string' && causes.includes(value)?value:'Unknown';
const count=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<=1_000_000?value:null;
const startupReasons=['COLLECTIVE_PROBE_FAILED','COLLECTIVE_PROBE_TIMEOUT','COLLECTIVE_PROBE_LAUNCH_FAILED','COLLECTIVE_PROBE_CLEANUP_UNCONFIRMED'] as const;
export interface CollectiveStartupDiagnostic {
  version:1;stage:'collective-preflight';reason:typeof startupReasons[number];
  transport:'configured'|'host-mediated';exitCode:number|null;cleanupConfirmed:boolean;
}
/** Accept only the wrapper's fixed schema. Extra fields are dropped both when
 * reading private logs and when importing an untrusted historical attachment. */
export function parseCollectiveStartupDiagnostic(value:unknown):CollectiveStartupDiagnostic {
  const data=value as CollectiveStartupDiagnostic;
  requireSafe(data?.version===1 && data.stage==='collective-preflight' && startupReasons.includes(data.reason) &&
    ['configured','host-mediated'].includes(data.transport) && typeof data.cleanupConfirmed==='boolean' &&
    (data.exitCode===null || Number.isSafeInteger(data.exitCode) && data.exitCode>=-255 && data.exitCode<=255),'CONFIG');
  return {version:1,stage:'collective-preflight',reason:data.reason,transport:data.transport,
    exitCode:data.exitCode,cleanupConfirmed:data.cleanupConfirmed};
}

/** Bounded, read-only extraction from the existing authenticated log response.
 * Do not copy model/Pod names, arbitrary messages, paths or native NCCL output. */
export function collectiveStartupDiagnostics(value:unknown):CollectiveStartupDiagnostic[] {
  const payload=value as {pods?:Array<{containers?:Array<{logs?:Array<{text?:unknown}>}>}>};
  const prefix='[magicstick-vllm-wrapper] MAGICSTICK_STARTUP_DIAGNOSTIC=',result:CollectiveStartupDiagnostic[]=[];
  const seen=new Set<string>();let remaining=524_288;
  if(!Array.isArray(payload?.pods))return result;
  for(const pod of payload.pods.slice(0,64))for(const container of Array.isArray(pod?.containers)?pod.containers.slice(0,16):[])
    for(const log of Array.isArray(container?.logs)?container.logs.slice(0,3):[]) {
      if(remaining<=0 || result.length>=8)return result;
      if(typeof log?.text!=='string')continue;
      const text=log.text.slice(-Math.min(remaining,65_536));remaining-=text.length;
      for(const line of text.split('\n')) {
        const marker=line.indexOf(prefix);
        if(marker<0 || line.length-marker>2048)continue;
        try {
          const data=parseCollectiveStartupDiagnostic(JSON.parse(line.slice(marker+prefix.length))),key=JSON.stringify(data);
          if(!seen.has(key)){seen.add(key);result.push(data);}
          if(result.length>=8)return result;
        }catch{/* Native output and malformed/unknown markers remain private. */}
      }
    }
  return result;
}
export interface RuntimeDiagnostic {
  version:1;engine:'VLLM'|'OLlama';target:'cpu'|'nvidia-gpu'|'amd-gpu'|'intel-gpu';deployment:'single'|'split'|'replicated';gpuCount:number;generation:number;currentStatus:boolean;phase:string;
  pods:Array<{phase:string;ready:boolean;scheduled:boolean;containers:Array<{ready:boolean;restarts:number|null;
    state:'running'|'waiting'|'terminated'|'unknown';cause:string;lastCause:string;exitCode:number|null}>}>;
  startup?:CollectiveStartupDiagnostic[];
}
/** Structural runtime evidence only: no model/Pod/container names, UIDs,
 * messages, image URLs, environment, prompts, logs or upstream error bodies. */
export function runtimeDiagnostic(item:ModelActivation,pods:KubeObject[],uid:string,generation:number,logs?:unknown):RuntimeDiagnostic {
  requireSafe(item.metadata?.uid===uid && item.metadata.generation===generation && item.spec?.local,'OWNERSHIP');
  const local=item.spec.local;
  requireSafe(local.engine==='VLLM'||local.engine==='OLlama','CONFIG');
  const startup=local.engine==='VLLM'?collectiveStartupDiagnostics(logs):[];
  if(startup.length)requireSafe((logs as {model?:unknown}).model===item.metadata.name,'OWNERSHIP');
  return parseRuntimeDiagnostic({version:1,engine:local.engine,target:local.computeTarget,deployment:local.gpuDeployment??'single',
    gpuCount:Array.isArray(local.gpuDevices)?local.gpuDevices.length:1,generation,
    currentStatus:item.status?.observedGeneration===generation,phase:phase(item.status?.phase),...(startup.length?{startup}:{}),
    pods:pods.map(pod=>({phase:phase(pod.status?.phase),ready:pod.status?.conditions?.some(c=>c.type==='Ready' && c.status==='True')===true,
      scheduled:pod.status?.conditions?.some(c=>c.type==='PodScheduled' && c.status==='True')===true,
      containers:[...(pod.status?.initContainerStatuses??[]),...(pod.status?.containerStatuses??[])].map(c=>({ready:c.ready===true,
        restarts:count(c.restartCount),state:c.state?.running?'running':c.state?.waiting?'waiting':c.state?.terminated?'terminated':'unknown',
        cause:cause(c.state?.waiting?.reason??c.state?.terminated?.reason),lastCause:cause(c.lastState?.terminated?.reason),
        exitCode:count(c.state?.terminated?.exitCode??c.lastState?.terminated?.exitCode)}))}))});
}

/** Revalidate at both trace creation and aggregate import; never trust an
 * arbitrary Playwright attachment or historical diagnostic as public-safe. */
export function parseRuntimeDiagnostic(value:unknown):RuntimeDiagnostic {
  const data=value as RuntimeDiagnostic;
  requireSafe(data?.version===1 && ['VLLM','OLlama'].includes(data.engine) && ['cpu','nvidia-gpu','amd-gpu','intel-gpu'].includes(data.target) && ['single','split','replicated'].includes(data.deployment) &&
    Number.isSafeInteger(data.gpuCount) && data.gpuCount>=1 && data.gpuCount<=16 && count(data.generation)!==null && data.generation>0 &&
    typeof data.currentStatus==='boolean' && Array.isArray(data.pods) && data.pods.length<=64 &&
    (data.startup===undefined || data.engine==='VLLM' && Array.isArray(data.startup) && data.startup.length<=8),'CONFIG');
  return {version:1,engine:data.engine,target:data.target,deployment:data.deployment,gpuCount:data.gpuCount,generation:data.generation,
    currentStatus:data.currentStatus,phase:phase(data.phase),...(data.startup?.length?{startup:data.startup.map(parseCollectiveStartupDiagnostic)}:{}),pods:data.pods.map(pod=>{
      requireSafe(pod && Array.isArray(pod.containers) && pod.containers.length<=16,'CONFIG');
      return {phase:phase(pod.phase),ready:pod.ready===true,scheduled:pod.scheduled===true,containers:pod.containers.map(c=>{
        requireSafe(c && typeof c==='object' && !Array.isArray(c),'CONFIG');
        return {ready:c.ready===true,restarts:count(c.restarts),state:['running','waiting','terminated'].includes(c.state)?c.state:'unknown',
          cause:cause(c.cause),lastCause:cause(c.lastCause),exitCode:count(c.exitCode)};
      })};
    })};
}
