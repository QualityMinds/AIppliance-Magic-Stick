import {requireSafe} from './errors.ts';

export const gpuValidationConflictCodes=['GPU_NODE_CHANGED','GPU_DEVICE_UNAVAILABLE','GPU_EVIDENCE_STALE',
  'GPU_PROVIDER_UNSUPPORTED','GPU_OPERATOR_DISABLED','GPU_CONFIGURATION_CHANGED','GPU_REQUEST_CONFLICT'] as const;
export const gpuValidationReasons=[...gpuValidationConflictCodes,'NOT_REQUESTED','READY','ACCEPTED','READ_FAILED',
  'READINESS_DEADLINE','IDENTITY_CHANGED','INTENT_CHANGED','AUTHORIZATION_REJECTED','TRANSPORT_FAILED',
  'RESPONSE_CONTRACT','UNCLASSIFIED_RESPONSE','PREREQUISITE','BUSY'] as const;
export interface GpuValidationObservation {
  attempt:number;state:'waiting'|'ready'|'failed';
  modules:Array<{provider:'amd'|'nvidia';expectedGeneration:number|null;currentGeneration:number|null;
    observedGeneration:number|null;inventoryGenerations:Array<number|null>;identityMatches:boolean;intentMatches:boolean;ready:boolean}>;
}
export interface GpuValidationDiagnostic {
  version:1;engine:'OLlama'|'VLLM';scope:'all'|'nvidia';reason:typeof gpuValidationReasons[number];
  requestAttempted:boolean;httpStatus:number|null;history:GpuValidationObservation[];omittedObservations:number;
  responseGenerations?:{currentGeneration:number|null;inventoryGeneration:number|null};
}
const generation=(v:unknown):v is number|null=>v===null||Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2_147_483_647;
const nonnegative=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=100_000;
/** Rebuild at capture and archive import. No resource identity, URL, message,
 * header, response body or arbitrary extra attachment field is public-safe. */
export function parseGpuValidationDiagnostic(value:unknown):GpuValidationDiagnostic {
  const d=value as GpuValidationDiagnostic;
  requireSafe(d?.version===1&&['OLlama','VLLM'].includes(d.engine)&&['all','nvidia'].includes(d.scope)&&
    gpuValidationReasons.includes(d.reason)&&typeof d.requestAttempted==='boolean'&&
    (d.httpStatus===null||Number.isInteger(d.httpStatus)&&d.httpStatus>=100&&d.httpStatus<=599)&&
    (d.requestAttempted||d.httpStatus===null)&&Array.isArray(d.history)&&d.history.length<=8&&
    nonnegative(d.omittedObservations),'CONFIG');
  let previousAttempt=0;
  const history=d.history.map(o=>{
    requireSafe(o&&nonnegative(o.attempt)&&o.attempt>0&&['waiting','ready','failed'].includes(o.state)&&
      o.attempt>previousAttempt&&Array.isArray(o.modules)&&o.modules.length<=2&&new Set(o.modules.map(m=>m.provider)).size===o.modules.length,'CONFIG');
    previousAttempt=o.attempt;
    return {attempt:o.attempt,state:o.state,modules:o.modules.map(m=>{
      requireSafe(m&&['amd','nvidia'].includes(m.provider)&&generation(m.expectedGeneration)&&generation(m.currentGeneration)&&
        generation(m.observedGeneration)&&Array.isArray(m.inventoryGenerations)&&m.inventoryGenerations.length>0&&
        m.inventoryGenerations.length<=32&&m.inventoryGenerations.every(generation)&&typeof m.identityMatches==='boolean'&&
        typeof m.intentMatches==='boolean'&&typeof m.ready==='boolean','CONFIG');
      return {provider:m.provider,expectedGeneration:m.expectedGeneration,currentGeneration:m.currentGeneration,
        observedGeneration:m.observedGeneration,inventoryGenerations:[...m.inventoryGenerations],
        identityMatches:m.identityMatches,intentMatches:m.intentMatches,ready:m.ready};
    })};
  });
  let responseGenerations:GpuValidationDiagnostic['responseGenerations'];
  if(d.responseGenerations!==undefined) {
    requireSafe(d.requestAttempted&&d.httpStatus===409&&d.reason==='GPU_CONFIGURATION_CHANGED'&&
      d.responseGenerations&&generation(d.responseGenerations.currentGeneration)&&generation(d.responseGenerations.inventoryGeneration),'CONFIG');
    responseGenerations={currentGeneration:d.responseGenerations.currentGeneration,inventoryGeneration:d.responseGenerations.inventoryGeneration};
  }
  return {version:1,engine:d.engine,scope:d.scope,reason:d.reason,requestAttempted:d.requestAttempted,httpStatus:d.httpStatus,
    history,omittedObservations:d.omittedObservations,...(responseGenerations?{responseGenerations}:{})};
}

/** The server's fixed numeric mismatch observation, not a raw error body. */
export function gpuValidationResponseGenerations(payload:unknown):GpuValidationDiagnostic['responseGenerations'] {
  const value=(payload as {generations?:GpuValidationDiagnostic['responseGenerations']}|null)?.generations;
  if(value&&generation(value.currentGeneration)&&generation(value.inventoryGeneration))
    return {currentGeneration:value.currentGeneration,inventoryGeneration:value.inventoryGeneration};
}

/** Older API images have only fixed human messages. Classify only exact known
 * strings; never retain arbitrary text or infer conflict from a vague message. */
export function gpuValidationResponseReason(status:number,payload:unknown):GpuValidationDiagnostic['reason'] {
  if(status===401||status===403)return 'AUTHORIZATION_REJECTED';
  if(status===202)return 'ACCEPTED';
  if(status!==409)return 'UNCLASSIFIED_RESPONSE';
  const p=payload as {code?:unknown;error?:unknown}|null;
  if(typeof p?.code==='string'&&gpuValidationConflictCodes.includes(p.code as typeof gpuValidationConflictCodes[number]))
    return p.code as typeof gpuValidationConflictCodes[number];
  if(p?.code!==undefined)return 'UNCLASSIFIED_RESPONSE';
  const legacy:Record<string,typeof gpuValidationConflictCodes[number]>={
    'The node changed; refresh Hardware before requesting validation':'GPU_NODE_CHANGED',
    'A selected GPU changed, is unavailable or already has a pending diagnostic; refresh Hardware':'GPU_DEVICE_UNAVAILABLE',
    'Physical GPU evidence changed or expired; refresh Hardware before validation':'GPU_EVIDENCE_STALE',
    'No approved diagnostic exists for the selected provider':'GPU_PROVIDER_UNSUPPORTED',
    'The GPU operator is no longer enabled; refresh Hardware':'GPU_OPERATOR_DISABLED',
    'The GPU configuration changed; refresh Hardware before validation':'GPU_CONFIGURATION_CHANGED',
  };
  return typeof p?.error==='string'&&Object.hasOwn(legacy,p.error)?legacy[p.error]!:'UNCLASSIFIED_RESPONSE';
}
export function gpuValidationDiagnosticText(value:GpuValidationDiagnostic):string[] {
  const d=parseGpuValidationDiagnostic(value),g=(value:number|null)=>value??'unknown';
  return [`GPU verification ${d.engine}/${d.scope}: ${d.reason}; request ${d.requestAttempted?'attempted':'not attempted'}; HTTP ${d.httpStatus??'unknown'}`,
    ...(d.responseGenerations?[`Server observed generations: inventory ${g(d.responseGenerations.inventoryGeneration)}; current ${g(d.responseGenerations.currentGeneration)}`]:[]),
    ...d.history.flatMap(o=>o.modules.length?o.modules.map(m=>
      `Observation ${o.attempt} ${o.state}/${m.provider}: expected generation ${g(m.expectedGeneration)}; current ${g(m.currentGeneration)}; controller ${g(m.observedGeneration)}; inventory ${m.inventoryGenerations.map(g).join(',')}; identity ${m.identityMatches?'matches':'differs'}; intent ${m.intentMatches?'matches':'differs'}; Ready ${m.ready}`):
      [`Observation ${o.attempt} ${o.state}: configuration read unavailable`]),
    ...(d.omittedObservations?[`${d.omittedObservations} intermediate observations omitted; first and latest retained`]:[])];
}
