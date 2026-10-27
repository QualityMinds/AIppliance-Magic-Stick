import {createHash} from 'node:crypto';
import type {KubeObject} from './observer.ts';
import {requireSafe} from './errors.ts';

export const pinConditions=['ready','missing','identity','revision','generation','replicas','containers','image','readiness'] as const;
export interface PinCheck {component:'flux'|'deployment';index:number;condition:typeof pinConditions[number]}
export interface ObservationWindow {startedAt:string;finishedAt:string}
interface Identity {uidFingerprint?:string;resourceVersionFingerprint?:string;generation?:number;observedGeneration?:number}
export interface PinPod extends Identity {
  terminating:boolean;phase:'Pending'|'Running'|'Succeeded'|'Failed'|'Unknown';
  containers:Array<{role:'workload'|'init';ready:boolean;restartCount:number|null;imageMatches:boolean|null;
    state:'running'|'waiting'|'terminated'|'unknown';reason:string;exitCode?:number;previousReason?:string;previousExitCode?:number}>;
}
export interface PinObservation extends ObservationWindow {
  attempt:number;checks:Array<PinCheck&Identity&{observed?:ObservationWindow;podsObserved?:ObservationWindow;
    sourceMatches?:boolean;desiredReplicas?:number;readyReplicas?:number;pods?:PinPod[];omittedPods?:number;
    readyCondition?:{status:'True'|'False'|'Unknown';reason:string;observedGeneration?:number}}>;
  omittedChecks?:number;readFailure?:'API'|'AUTH'|'OBSERVER'|'IDENTITY'|'HOST'|'CAPABILITY'|'LAB'|'UNEXPECTED';
}
/** Private collection inputs never enter a filtered trace. Names are only used
 * for exact UID-bound event/log reads, never for ownership or recovery. */
export interface PinReference {component:PinCheck['component'];index:number;kind:'deployment'|'replicaset'|'pod'|'flux';
  namespace:string;name:string;uid:string;generation?:number}
export interface PreflightDiagnostic {
  version:1;state:'observing'|'converged'|'failed';attempts:number;firstFailure?:PinObservation;
  history:PinObservation[];omittedObservations:number;
  events:{state:'not-needed'|'pending'|'collected'|'unavailable';items:Array<{component:PinCheck['component'];index:number;
    objectFingerprint:string;observedAt:string;occurredAt?:string;type:'Normal'|'Warning'|'Unknown';reason:string;count?:number}>;omitted:number};
  logs:{state:'not-needed'|'pending'|'captured'|'unavailable';streams:number;reason?:'not-native'|'not-authorized'|'endpoint-unavailable'|'identity-changed'|'collection-failed'};
}
const reasons=new Set(['Unknown','Progressing','Available','NewReplicaSetAvailable','ReplicaSetUpdated','MinimumReplicasAvailable',
  'MinimumReplicasUnavailable','ProgressDeadlineExceeded','DeploymentDoesNotHaveMinimumReplicas','DependencyNotReady',
  'BuildFailed','ReconciliationSucceeded','ReconciliationFailed','HealthCheckFailed','ArtifactFailed','ProgressingWithRetry',
  'Succeeded','Failed','FailedCreate','FailedDelete','FailedScheduling','FailedMount','FailedAttachVolume','FailedBinding',
  'BackOff','Pulling','Pulled','Created','Started','Killing','Unhealthy','Scheduled','ScalingReplicaSet','OOMKilled',
  'CrashLoopBackOff','ImagePullBackOff','ErrImagePull','ContainerCreating','PodInitializing','CreateContainerConfigError',
  'CreateContainerError','RunContainerError','Completed','Error','Evicted','DeadlineExceeded']);
export const safePinReason=(value:unknown)=>typeof value==='string'&&reasons.has(value)?value:'Unknown';
export const pinFingerprint=(value:string)=>createHash('sha256').update(value).digest('hex');
const integer=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0;
const timestamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));
const fingerprint=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function window(value:ObservationWindow):ObservationWindow {
  requireSafe(timestamp(value?.startedAt)&&timestamp(value.finishedAt)&&Date.parse(value.finishedAt)>=Date.parse(value.startedAt),'CONFIG');
  return {startedAt:value.startedAt,finishedAt:value.finishedAt};
}
export function pinIdentity(item:KubeObject):Identity {
  return {...(typeof item.metadata.uid==='string'&&item.metadata.uid?{uidFingerprint:pinFingerprint(item.metadata.uid)}:{}),
    ...(typeof item.metadata.resourceVersion==='string'&&item.metadata.resourceVersion?{resourceVersionFingerprint:pinFingerprint(item.metadata.resourceVersion)}:{}),
    ...(integer(item.metadata.generation)?{generation:item.metadata.generation}:{}),
    ...(integer(item.status?.observedGeneration)?{observedGeneration:item.status!.observedGeneration}:{})};
}
export function pinPod(item:KubeObject,container:string,digest:string):PinPod {
  return {...pinIdentity(item),terminating:!!item.metadata.deletionTimestamp,
    phase:['Pending','Running','Succeeded','Failed'].includes(item.status?.phase??'')?item.status!.phase as PinPod['phase']:'Unknown',
    containers:[...(item.status?.containerStatuses??[]).filter(c=>c.name===container).slice(0,2).map(c=>({...c,role:'workload' as const})),
      ...(item.status?.initContainerStatuses??[]).slice(0,2).map(c=>({...c,role:'init' as const}))].map(c=>{
      const terminated=c.state?.terminated,previous=c.lastState?.terminated;
      return {role:c.role,ready:c.ready===true,restartCount:integer(c.restartCount)?c.restartCount:null,imageMatches:c.role==='workload'&&c.imageID?c.imageID.endsWith(digest):null,
        state:c.state?.running?'running' as const:c.state?.waiting?'waiting' as const:terminated?'terminated' as const:'unknown' as const,
        reason:safePinReason(c.state?.waiting?.reason??terminated?.reason),
        ...(Number.isSafeInteger(terminated?.exitCode)?{exitCode:terminated!.exitCode}:{}),
        ...(previous?{previousReason:safePinReason(previous.reason),...(Number.isSafeInteger(previous.exitCode)?{previousExitCode:previous.exitCode}:{})}:{})};
    })};
}
function identity(value:Identity):Identity {
  return {...(fingerprint(value.uidFingerprint)?{uidFingerprint:value.uidFingerprint}:{}),
    ...(fingerprint(value.resourceVersionFingerprint)?{resourceVersionFingerprint:value.resourceVersionFingerprint}:{}),
    ...(integer(value.generation)?{generation:value.generation}:{}),...(integer(value.observedGeneration)?{observedGeneration:value.observedGeneration}:{})};
}
function observation(value:PinObservation):PinObservation {
  requireSafe(integer(value?.attempt)&&value.attempt>0&&Array.isArray(value.checks)&&value.checks.length<=16,'CONFIG');
  return {...window(value),attempt:value.attempt,checks:value.checks.map(check=>{
    requireSafe(['flux','deployment'].includes(check.component)&&integer(check.index)&&check.index<1_000_000&&pinConditions.includes(check.condition)&&
      (check.pods===undefined||Array.isArray(check.pods)&&check.pods.length<=12),'CONFIG');
    return {component:check.component,index:check.index,condition:check.condition,...identity(check),...(check.observed?{observed:window(check.observed)}:{}),
      ...(check.podsObserved?{podsObserved:window(check.podsObserved)}:{}),
      ...(typeof check.sourceMatches==='boolean'?{sourceMatches:check.sourceMatches}:{}),
      ...(integer(check.desiredReplicas)?{desiredReplicas:check.desiredReplicas}:{}),...(integer(check.readyReplicas)?{readyReplicas:check.readyReplicas}:{}),
      ...(check.readyCondition?{readyCondition:{status:['True','False'].includes(check.readyCondition.status)?check.readyCondition.status:'Unknown' as const,
        reason:safePinReason(check.readyCondition.reason),...(integer(check.readyCondition.observedGeneration)?{observedGeneration:check.readyCondition.observedGeneration}:{})}}:{}),
      ...(integer(check.omittedPods)?{omittedPods:check.omittedPods}:{}),...(check.pods?{pods:check.pods.map(p=>{
        requireSafe(typeof p.terminating==='boolean'&&['Pending','Running','Succeeded','Failed','Unknown'].includes(p.phase)&&Array.isArray(p.containers)&&p.containers.length<=4,'CONFIG');
        return {...identity(p),terminating:p.terminating,phase:p.phase,containers:p.containers.map(c=>{
          requireSafe(typeof c.ready==='boolean'&&(integer(c.restartCount)||c.restartCount===null)&&
            (typeof c.imageMatches==='boolean'||c.imageMatches===null)&&['running','waiting','terminated','unknown'].includes(c.state),'CONFIG');
          return {role:c.role==='init'?'init' as const:'workload' as const,ready:c.ready,restartCount:c.restartCount,imageMatches:c.imageMatches,state:c.state,reason:safePinReason(c.reason),
            ...(Number.isSafeInteger(c.exitCode)?{exitCode:c.exitCode}:{}),...(c.previousReason?{previousReason:safePinReason(c.previousReason)}:{}),
            ...(Number.isSafeInteger(c.previousExitCode)?{previousExitCode:c.previousExitCode}:{})};
        })};
      })}:{} )};
  }),...(integer(value.omittedChecks)&&value.omittedChecks>0?{omittedChecks:value.omittedChecks}:{}),
    ...(value.readFailure&&['API','AUTH','OBSERVER','IDENTITY','HOST','CAPABILITY','LAB','UNEXPECTED'].includes(value.readFailure)?{readFailure:value.readFailure}:{})};
}
/** Reconstruction, not passthrough: raw messages/names/URLs/env/logs are dropped
 * again on reporter attachment, aggregate import and portable archive export. */
export function parsePreflightDiagnostic(value:unknown):PreflightDiagnostic {
  const d=value as PreflightDiagnostic;
  requireSafe(d?.version===1&&['observing','converged','failed'].includes(d.state)&&integer(d.attempts)&&integer(d.omittedObservations)&&
    Array.isArray(d.history)&&d.history.length<=12&&['not-needed','pending','collected','unavailable'].includes(d.events?.state)&&
    Array.isArray(d.events.items)&&d.events.items.length<=32&&integer(d.events.omitted)&&
    ['not-needed','pending','captured','unavailable'].includes(d.logs?.state)&&integer(d.logs.streams)&&d.logs.streams<=4,'CONFIG');
  return {version:1,state:d.state,attempts:d.attempts,...(d.firstFailure?{firstFailure:observation(d.firstFailure)}:{}),
    history:d.history.map(observation),omittedObservations:d.omittedObservations,
    events:{state:d.events.state,omitted:d.events.omitted,items:d.events.items.map(e=>{
      requireSafe(['flux','deployment'].includes(e.component)&&integer(e.index)&&e.index<1_000_000&&fingerprint(e.objectFingerprint)&&timestamp(e.observedAt),'CONFIG');
      return {component:e.component,index:e.index,objectFingerprint:e.objectFingerprint,observedAt:e.observedAt,
        type:['Normal','Warning'].includes(e.type)?e.type:'Unknown',reason:safePinReason(e.reason),
        ...(timestamp(e.occurredAt)?{occurredAt:e.occurredAt}:{}),...(integer(e.count)?{count:e.count}:{})};
    })},logs:{state:d.logs.state,streams:d.logs.streams,...(d.logs.reason&&['not-native','not-authorized','endpoint-unavailable','identity-changed','collection-failed'].includes(d.logs.reason)?{reason:d.logs.reason}:{})}};
}
export function newPreflightDiagnostic():PreflightDiagnostic {
  return {version:1,state:'observing',attempts:0,history:[],omittedObservations:0,
    events:{state:'not-needed',items:[],omitted:0},logs:{state:'not-needed',streams:0}};
}
/** Preserve the first failure separately; keep the first observation plus a
 * bounded tail of transitions. Unchanged polling still increments attempts. */
export function recordPinObservation(d:PreflightDiagnostic,sample:PinObservation) {
  const value=observation(sample);d.attempts=value.attempt;
  if(!d.firstFailure&&(value.readFailure||value.checks.some(c=>c.condition!=='ready')))d.firstFailure=value;
  const signature=(s:PinObservation)=>JSON.stringify({readFailure:s.readFailure,checks:s.checks.map(({observed,podsObserved,...check})=>check)});
  const last=d.history.at(-1);
  if(last&&signature(last)===signature(value)&&d.history.length>1){d.omittedObservations++;d.history[d.history.length-1]=value;return;}
  d.history.push(value);
  while(d.history.length>12||(d.history.length>2&&JSON.stringify(d).length>160*1024)){d.history.splice(1,1);d.omittedObservations++;}
}
export function preflightDiagnosticText(d:PreflightDiagnostic):string[] {
  const first=d.firstFailure;
  return [`Preflight: ${d.state}; ${d.attempts} observations; ${d.omittedObservations} omitted`,
    ...(first?[`First failed observation: ${first.startedAt} – ${first.finishedAt}`,
      ...(first.readFailure?[`Read failure: ${first.readFailure}`]:[]),
      ...first.checks.filter(c=>c.condition!=='ready').map(c=>`${c.component}[${c.index}]: ${c.condition}; generation ${c.generation??'unknown'}/${c.observedGeneration??'unknown'}; replicas ${c.readyReplicas??'unknown'}/${c.desiredReplicas??'unknown'}`)]:[]),
    ...d.history.flatMap(s=>[`Observation ${s.attempt}: ${s.startedAt} – ${s.finishedAt}${s.readFailure?' / '+s.readFailure:''}${s.omittedChecks?'; '+s.omittedChecks+' additional component observations omitted':''}`,
      ...s.checks.flatMap(c=>[`${c.component}[${c.index}]: ${c.condition}; observed ${c.observed?c.observed.startedAt+' – '+c.observed.finishedAt:'unknown'}; source match ${c.sourceMatches??'unknown'}; generation ${c.generation??'unknown'}/${c.observedGeneration??'unknown'}; replicas ${c.readyReplicas??'unknown'}/${c.desiredReplicas??'unknown'}${c.readyCondition?'; Ready='+c.readyCondition.status+'/'+c.readyCondition.reason+' (observed generation '+(c.readyCondition.observedGeneration??'unknown')+')':''}`,
        ...(c.pods??[]).map(p=>`Pod ${p.uidFingerprint??'unknown'}: ${p.phase}${p.terminating?' / terminating':''}; `+p.containers.map(container=>
          `${container.role}: ${container.state}/${container.reason}; ready=${container.ready}; image match=${container.imageMatches??'unknown'}; restarts=${container.restartCount??'unknown'}; exit=${container.exitCode??'unknown'}; previous=${container.previousReason??'unknown'}/${container.previousExitCode??'unknown'}`).join(' | '))])]),
    `Events: ${d.events.state} (${d.events.items.length}, ${d.events.omitted} omitted); private logs: ${d.logs.state}${d.logs.reason?' / '+d.logs.reason:''}`,
    ...d.events.items.map(e=>`${e.type}/${e.reason}: ${e.component}[${e.index}]; event ${e.occurredAt??'unknown'}; observed ${e.observedAt}; count ${e.count??'unknown'}`)];
}
