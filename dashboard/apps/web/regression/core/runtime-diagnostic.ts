import type {ModelActivation} from '@magicstick/dashboard-contracts';
import type {KubeObject} from './observer.ts';
import {requireSafe} from './errors.ts';

const phases=['Pending','Running','Succeeded','Failed','Unknown','Starting','Ready','Degraded','Disabled','Stopped','WaitingForPod','WaitingForModules'];
const causes=['OOMKilled','Error','Completed','CrashLoopBackOff','ImagePullBackOff','ErrImagePull','ContainerCreating','PodInitializing',
  'CreateContainerConfigError','CreateContainerError','RunContainerError','StartError','ContainerStatusUnknown'];
const phase=(value:unknown)=>typeof value==='string' && phases.includes(value)?value:'Unknown';
const cause=(value:unknown)=>typeof value==='string' && causes.includes(value)?value:'Unknown';
const count=(value:unknown)=>typeof value==='number' && Number.isSafeInteger(value) && value>=0 && value<=1_000_000?value:null;
export interface RuntimeDiagnostic {
  version:1;engine:'VLLM'|'OLlama';target:'cpu'|'nvidia-gpu'|'amd-gpu'|'intel-gpu';deployment:'single'|'split'|'replicated';gpuCount:number;generation:number;currentStatus:boolean;phase:string;
  pods:Array<{phase:string;ready:boolean;scheduled:boolean;containers:Array<{ready:boolean;restarts:number|null;
    state:'running'|'waiting'|'terminated'|'unknown';cause:string;lastCause:string;exitCode:number|null}>}>;
}
/** Structural runtime evidence only: no model/Pod/container names, UIDs,
 * messages, image URLs, environment, prompts, logs or upstream error bodies. */
export function runtimeDiagnostic(item:ModelActivation,pods:KubeObject[],uid:string,generation:number):RuntimeDiagnostic {
  requireSafe(item.metadata?.uid===uid && item.metadata.generation===generation && item.spec?.local,'OWNERSHIP');
  const local=item.spec.local;
  requireSafe(local.engine==='VLLM'||local.engine==='OLlama','CONFIG');
  return parseRuntimeDiagnostic({version:1,engine:local.engine,target:local.computeTarget,deployment:local.gpuDeployment??'single',
    gpuCount:Array.isArray(local.gpuDevices)?local.gpuDevices.length:1,generation,
    currentStatus:item.status?.observedGeneration===generation,phase:phase(item.status?.phase),
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
    typeof data.currentStatus==='boolean' && Array.isArray(data.pods) && data.pods.length<=64,'CONFIG');
  return {version:1,engine:data.engine,target:data.target,deployment:data.deployment,gpuCount:data.gpuCount,generation:data.generation,
    currentStatus:data.currentStatus,phase:phase(data.phase),pods:data.pods.map(pod=>{
      requireSafe(pod && Array.isArray(pod.containers) && pod.containers.length<=16,'CONFIG');
      return {phase:phase(pod.phase),ready:pod.ready===true,scheduled:pod.scheduled===true,containers:pod.containers.map(c=>{
        requireSafe(c && typeof c==='object' && !Array.isArray(c),'CONFIG');
        return {ready:c.ready===true,restarts:count(c.restarts),state:['running','waiting','terminated'].includes(c.state)?c.state:'unknown',
          cause:cause(c.cause),lastCause:cause(c.lastCause),exitCode:count(c.exitCode)};
      })};
    })};
}
