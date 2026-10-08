import type {ModelActivation,ModelsPayload} from '@magicstick/dashboard-contracts';
import type {KubeObject} from './observer.ts';
import {poll} from './poll.ts';

export interface ModelStopState {item?:ModelActivation|null;observed?:KubeObject|null;pods:KubeObject[];models:ModelsPayload}

/** Stopping a model retains its saved activation, but withdraws the runtime
 * and generated routable catalog entry. Absence of configuration is not success. */
export function modelStopped(state:ModelStopState,name:string) {
  return state.item?.spec?.enabled === false && state.pods.length === 0 &&
    Array.isArray(state.models.models) && !state.models.models.some(item=>item.id === name);
}

/** Bounded structural diagnostics only: no logs, args, env, credentials,
 * arbitrary status messages or HTTP response bodies. */
export function stopDiagnostic(state:ModelStopState|undefined,name:string) {
  const number=(value:unknown)=>Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
  const timestamp=(value:unknown)=>typeof value === 'string' && /^\d{4}-\d\d-\d\dT[0-9:.]+Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : undefined;
  const activation=(item:ModelActivation|KubeObject|null|undefined)=>item ? {
    generation:number(item.metadata?.generation),observedGeneration:number(item.status?.observedGeneration),
    enabled:typeof item.spec?.enabled === 'boolean' ? item.spec.enabled : undefined,
    deletionTimestamp:timestamp(item.metadata?.deletionTimestamp),
  } : undefined;
  return {version:1,sampled:Boolean(state),checks:{intentDisabled:state?.item?.spec?.enabled === false,
    runtimePodsGone:Boolean(state && state.pods.length === 0),
    catalogEntryGone:Boolean(state && Array.isArray(state.models.models) && !state.models.models.some(item=>item.id === name))},
    activation:activation(state?.item),observedActivation:activation(state?.observed),
    pods:state?.pods.slice(0,16).map(pod=>({
      uid:typeof pod.metadata.uid === 'string' && /^[a-f0-9-]{36}$/.test(pod.metadata.uid) ? pod.metadata.uid : undefined,
      deleting:Boolean(pod.metadata.deletionTimestamp),deletionTimestamp:timestamp(pod.metadata.deletionTimestamp),
      phase:['Pending','Running','Succeeded','Failed','Unknown'].includes(pod.status?.phase ?? '') ? pod.status!.phase : undefined,
      terminationGracePeriodSeconds:number(pod.spec?.terminationGracePeriodSeconds),
      containers:pod.status?.containerStatuses?.slice(0,16).map(container=>({ready:container.ready === true,
        containerID:typeof container.containerID === 'string' && /^containerd:\/\/[a-f0-9]{64}$/.test(container.containerID) ? container.containerID : undefined,
        restartCount:number(container.restartCount),exitCode:number(container.state?.terminated?.exitCode),
        finishedAt:timestamp(container.state?.terminated?.finishedAt)})),
    })) ?? []};
}

/** Capture the last observed Stop predicate before teardown removes evidence.
 * Success is recorded too, so repeated live cycles have measured Stop times.
 * The original timeout/read failure is never replaced with a diagnostic failure. */
export async function waitModelStopped(read:()=>Promise<ModelStopState>,name:string,
  diagnostic:(value:ReturnType<typeof stopDiagnostic> & {observation:{startedAt:string;elapsedMs:number;completed:boolean};
    initial:ReturnType<typeof stopDiagnostic>})=>Promise<void>,
  options:{timeoutMs?:number;now?:()=>number;wait?:(milliseconds:number)=>Promise<void>}={}) {
  let last:ModelStopState|undefined,initial:ReturnType<typeof stopDiagnostic>|undefined;
  const now=options.now ?? Date.now,started=now(),startedAt=new Date().toISOString();
  const save=async(completed:boolean)=>{
    try {await diagnostic({...stopDiagnostic(last,name),initial:initial ?? stopDiagnostic(undefined,name),
      observation:{startedAt,elapsedMs:Math.max(0,now()-started),completed}});}catch{/* Preserve the actual lifecycle result. */}
  };
  try {
    const result=await poll(async()=>{
      last=await read();initial ??= stopDiagnostic(last,name);return last;
    },state=>modelStopped(state,name),
      {timeoutMs:options.timeoutMs ?? 300_000,intervalMs:1000,stage:'model-stopped',now:options.now,wait:options.wait});
    await save(true);return result;
  }catch(error) {
    await save(false);
    throw error;
  }
}
