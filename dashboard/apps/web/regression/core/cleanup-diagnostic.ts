import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {lstat,readdir} from 'node:fs/promises';
import {HarnessError,reasons,stages,requireSafe,type ReasonCode,type Stage} from './errors.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {KubernetesCommandError,parseKubernetesCommandDiagnostic,type KubernetesCommandDiagnostic} from './kubernetes-command.ts';

export const cleanupOperations=['guard','lookup','remove','verify','persist'] as const;
export type CleanupOperation=typeof cleanupOperations[number];
export interface CleanupObservation extends Partial<KubernetesCommandDiagnostic> {
  operation:CleanupOperation;state:'running'|'passed'|'failed';at:string;elapsedMs:number;
  reason?:ReasonCode;stage?:Stage;
  exists?:boolean|null;uidMatches?:boolean|null;generationMatches?:boolean|null;
  expectedGeneration?:number;observedGeneration?:number;deleting?:boolean|null;
  podCount?:number|null;catalogCount?:number|null;timeoutMs?:number;
  method?:'GET'|'POST'|'PUT'|'DELETE';endpoint?:'model-activation'|'model-catalog'|'api-key';
  requestAttempted?:boolean;attempt?:number;retrying?:boolean;
  resourceVersionChanged?:boolean|null;intentMatches?:boolean|null;
}
export interface CleanupDiagnostic {
  version:1;runId:string;ownerRunId?:string;scope:string;kind:'model'|'app'|'key'|'identity';state:'running'|'passed'|'failed';
  observations:number;omittedObservations:number;history:CleanupObservation[];firstFailure?:CleanupObservation;
  collection:'captured'|'write-failed'|'invalid';
}
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=1_000_000_000;
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v));
const nullableBoolean=(v:unknown)=>v===null||typeof v==='boolean';
/** Reconstruct, never spread untrusted objects: free text, URLs, headers and
 * actual names/UIDs are not part of the portable diagnostic contract. */
export function parseCleanupObservation(value:unknown):CleanupObservation {
  const v=value as CleanupObservation;
  requireSafe(v&&cleanupOperations.includes(v.operation)&&['running','passed','failed'].includes(v.state)&&timestamp(v.at)&&integer(v.elapsedMs),'CONFIG');
  const result:CleanupObservation={operation:v.operation,state:v.state,at:v.at,elapsedMs:v.elapsedMs};
  for(const key of ['exists','uidMatches','generationMatches','deleting','resourceVersionChanged','intentMatches'] as const)if(v[key]!==undefined){requireSafe(nullableBoolean(v[key]),'CONFIG');result[key]=v[key];}
  for(const key of ['requestAttempted','retrying'] as const)if(v[key]!==undefined){requireSafe(typeof v[key]==='boolean','CONFIG');result[key]=v[key];}
  if(v.attempt!==undefined){requireSafe(Number.isSafeInteger(v.attempt)&&v.attempt>0&&v.attempt<=3,'CONFIG');result.attempt=v.attempt;}
  for(const key of ['expectedGeneration','observedGeneration','timeoutMs'] as const)if(v[key]!==undefined){requireSafe(integer(v[key]),'CONFIG');result[key]=v[key];}
  for(const key of ['podCount','catalogCount'] as const)if(v[key]!==undefined){requireSafe(v[key]===null||integer(v[key]),'CONFIG');result[key]=v[key];}
  if(v.reason!==undefined){requireSafe(Object.hasOwn(reasons,v.reason),'CONFIG');result.reason=v.reason;}
  if(v.stage!==undefined){requireSafe(stages.includes(v.stage),'CONFIG');result.stage=v.stage;}
  if(v.method!==undefined){requireSafe(['GET','POST','PUT','DELETE'].includes(v.method),'CONFIG');result.method=v.method;}
  if(v.endpoint!==undefined){requireSafe(['model-activation','model-catalog','api-key'].includes(v.endpoint),'CONFIG');result.endpoint=v.endpoint;}
  if(v.httpStatus!==undefined){requireSafe(v.httpStatus===null||Number.isInteger(v.httpStatus)&&v.httpStatus>=100&&v.httpStatus<=599,'CONFIG');result.httpStatus=v.httpStatus;}
  if(v.commandFailure!==undefined)Object.assign(result,parseKubernetesCommandDiagnostic(v));
  else requireSafe(v.kubernetesReason===undefined&&v.exitCode===undefined&&v.processSignal===undefined,'CONFIG');
  return result;
}
export function parseCleanupDiagnostic(value:unknown):CleanupDiagnostic {
  const d=value as CleanupDiagnostic;
  requireSafe(d?.version===1&&/^reg-[0-9a-f-]{36}$/.test(d.runId)&&/^[a-f0-9]{64}$/.test(d.scope)&&['model','app','key','identity'].includes(d.kind)&&
    ['running','passed','failed'].includes(d.state)&&integer(d.observations)&&integer(d.omittedObservations)&&
    Array.isArray(d.history)&&d.history.length>0&&d.history.length<=12&&d.observations===d.history.length+d.omittedObservations&&
    ['captured','write-failed','invalid'].includes(d.collection)&&
    (d.ownerRunId===undefined||/^reg-[0-9a-f-]{36}$/.test(d.ownerRunId))&&d.state===d.history.at(-1)?.state&&
    (!d.firstFailure||d.firstFailure.state==='failed'),'CONFIG');
  return {version:1,runId:d.runId,scope:d.scope,kind:d.kind,state:d.state,observations:d.observations,omittedObservations:d.omittedObservations,
    collection:d.collection,history:d.history.map(parseCleanupObservation),
    ...(d.firstFailure?{firstFailure:parseCleanupObservation(d.firstFailure)}:{}),...(d.ownerRunId?{ownerRunId:d.ownerRunId}:{})};
}
/** One file per exact journal entry. Fingerprints are scoped to this run;
 * diagnostics are observations only, never ownership or cleanup receipts. */
export class CleanupRecorder {
  readonly filename:string;
  private diagnostic:CleanupDiagnostic;
  private started=Date.now();
  private previous='';
  private writes=Promise.resolve();
  private loaded=false;
  private writable=true;
  private epoch=0;
  private retired=false;
  constructor(journal:{filename:string;runId:string},entry:{kind:CleanupDiagnostic['kind'];name:string;uid:string|null}) {
    const scope=createHash('sha256').update(JSON.stringify([journal.runId,journal.filename,entry.kind,entry.name,entry.uid])).digest('hex');
    this.filename=join(dirname(journal.filename),'cleanup-diagnostics',scope+'.json');
    this.diagnostic={version:1,runId:journal.runId,scope,kind:entry.kind,state:'running',observations:0,omittedObservations:0,history:[],collection:'captured'};
  }
  snapshot(){return this.diagnostic.history.length?parseCleanupDiagnostic(this.diagnostic):undefined;}
  begin(){const epoch=++this.epoch;this.retired=false;return async(value:Omit<CleanupObservation,'at'|'elapsedMs'>)=>{
    if(epoch===this.epoch&&!this.retired)await this.record(value,epoch);
  };}
  async record(value:Omit<CleanupObservation,'at'|'elapsedMs'>,observeEpoch?:number) {
    if(!this.loaded) {
      this.loaded=true;
      try {
        const stat=await lstat(this.filename);requireSafe(stat.isFile()&&!stat.isSymbolicLink(),'PRIVATE_FILE');
        const old=await readCleanupCapture(this.filename);
        requireSafe(old.scope===this.diagnostic.scope&&old.runId===this.diagnostic.runId&&old.kind===this.diagnostic.kind,'CONFIG');
        this.diagnostic=old;
        this.started=Date.parse(old.history[0]!.at);
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){this.diagnostic.collection='write-failed';this.writable=false;}}
    }
    if(observeEpoch!==undefined&&(observeEpoch!==this.epoch||this.retired))return;
    let observation:CleanupObservation;
    const time={at:new Date().toISOString(),elapsedMs:Math.min(1_000_000_000,Math.max(0,Date.now()-this.started))};
    try{observation=parseCleanupObservation({...value,...time});}
    catch{this.diagnostic.collection='invalid';observation={...time,operation:cleanupOperations.includes(value?.operation)?value.operation:'guard',state:'failed',reason:'CONFIG',stage:'cleanup'};}
    this.diagnostic.observations++;
    const key=JSON.stringify({...observation,at:undefined,elapsedMs:undefined});
    // Keep first and latest state changes, not thousands of identical polls.
    if(key===this.previous&&this.diagnostic.history.length>1){this.diagnostic.history[this.diagnostic.history.length-1]=observation;this.diagnostic.omittedObservations++;}
    else {
      this.diagnostic.history.push(observation);this.previous=key;
      if(this.diagnostic.history.length>12){this.diagnostic.history.splice(1,1);this.diagnostic.omittedObservations++;}
    }
    if(observation.state==='failed'&&!this.diagnostic.firstFailure)this.diagnostic.firstFailure=observation;
    this.diagnostic.state=observation.state==='running'?'running':observation.state;
    const body=this.snapshot()!;
    if(this.writable)this.writes=this.writes.then(()=>writePrivate(this.filename,body)).catch(()=>{this.diagnostic.collection='write-failed';});
    await this.writes;
  }
  async failure(operation:CleanupOperation,error:unknown) {
    this.retired=true;
    await this.record({...this.diagnostic.history.at(-1),operation,state:'failed',reason:error instanceof HarnessError?error.causeReason??error.code:'UNEXPECTED',
      ...(error instanceof KubernetesCommandError?error.diagnostic:{}),
      ...(error instanceof HarnessError&&(error.causeStage??error.stage)?{stage:error.causeStage??error.stage}:{})});
  }
  async complete(){this.retired=true;await this.record({operation:'persist',state:'passed'});}
}
export function cleanupForTrace(value:CleanupDiagnostic,runId:string) {
  const d=parseCleanupDiagnostic(value);requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId),'CONFIG');
  return parseCleanupDiagnostic({...d,runId,...(d.runId!==runId?{ownerRunId:d.ownerRunId??d.runId}:{})});
}
/** Only exact entry-derived files are read; never adopt a name-prefix/glob as
 * evidence. An unreadable capture is explicit, not a successful empty result. */
export async function readCleanupCapture(filename:string):Promise<CleanupDiagnostic> {
  return parseCleanupDiagnostic(JSON.parse(await readPrivate(filename,64*1024)));
}
export async function runCleanupCaptures(directory:string,runId:string) {
  const diagnostics:CleanupDiagnostic[]=[];let unavailable=0,omitted=0,read=0;
  try {
    const root=await lstat(directory);requireSafe(root.isDirectory()&&!root.isSymbolicLink()&&(root.mode&0o077)===0,'PRIVATE_FILE');
    const workers=(await readdir(directory)).filter(name=>/^worker-/.test(name));
    for(const name of workers)if(!/^worker-(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(name))unavailable++;
    const paths=[directory,...workers.filter(name=>/^worker-(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(name)).sort().map(name=>join(directory,name))];
    for(const parent of paths)try {
      const stat=await lstat(parent);requireSafe(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_FILE');
      const path=join(parent,'cleanup-diagnostics');let exists;
      try{exists=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
      requireSafe(exists.isDirectory()&&!exists.isSymbolicLink()&&(exists.mode&0o077)===0,'PRIVATE_FILE');
      const owners=new Set(parent===directory?[runId]:[]);
      // Exact local journal IDs only. This check associates observations with
      // their worker, never grants resource ownership or a cleanup attestation.
      for(const file of (await readdir(parent)).filter(name=>name==='journal.json'||
        /^(?:ollama|vllm|unsupported|sanitized|risk-reject|risk-accept|external|provider)-reg-[0-9a-f-]{36}\.journal\.json$/.test(name)).slice(0,128)) {
        try{const journal=JSON.parse(await readPrivate(join(parent,file)));
          requireSafe(journal.version===1&&/^reg-[0-9a-f-]{36}$/.test(journal.runId)&&
            (parent!==directory||file!=='journal.json'||journal.runId===runId),'CONFIG');owners.add(journal.runId);
        }catch{unavailable++;}
      }
      const files=(await readdir(path)).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort();
      for(const name of files) {
        if(read++>=256){omitted++;continue;}
        try {const d=await readCleanupCapture(join(path,name));requireSafe(name===d.scope+'.json'&&owners.has(d.runId),'CONFIG');
          diagnostics.push(cleanupForTrace(d,runId));
        }catch{unavailable++;}
      }
    }catch{unavailable++;}
  }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')unavailable++;}
  diagnostics.sort((a,b)=>Date.parse(a.history.at(-1)!.at)-Date.parse(b.history.at(-1)!.at));
  while(diagnostics.length>16){const passed=diagnostics.findIndex(d=>d.state==='passed');diagnostics.splice(passed>=0?passed:1,1);omitted++;}
  return {diagnostics,unavailable,omitted};
}
export function cleanupDiagnosticText(value:CleanupDiagnostic):string[] {
  const d=parseCleanupDiagnostic(value),last=d.history.at(-1)!;
  const render=(o:CleanupObservation)=>`${o.operation}: ${o.state}${o.reason?' · '+o.reason:''}${o.stage?' · '+o.stage:''} · ${o.elapsedMs} ms`+
    (o.timeoutMs!==undefined?` / ${o.timeoutMs} ms budget`:'')+
    (o.exists!==undefined?` · object ${o.exists===null?'unknown':o.exists?'present':'absent'}`:'')+
    (o.uidMatches!==undefined?` · UID ${o.uidMatches===null?'unknown':o.uidMatches?'matches':'changed'}`:'')+
    (o.generationMatches!==undefined?` · revision ${o.generationMatches===null?'unknown':o.generationMatches?'matches':'changed'}`:'')+
    (o.expectedGeneration!==undefined?` · expected revision ${o.expectedGeneration}`:'')+
    (o.observedGeneration!==undefined?` · observed revision ${o.observedGeneration}`:'')+
    (o.resourceVersionChanged!==undefined?` · resource version ${o.resourceVersionChanged===null?'unknown':o.resourceVersionChanged?'changed':'unchanged'}`:'')+
    (o.intentMatches!==undefined?` · model intent ${o.intentMatches===null?'unknown':o.intentMatches?'matches':'changed'}`:'')+
    (o.deleting!==undefined?` · deletion ${o.deleting===null?'unknown':o.deleting?'in progress':'not marked'}`:'')+
    (o.podCount!==undefined?` · pods ${o.podCount??'unknown'}`:'')+(o.catalogCount!==undefined?` · catalog ${o.catalogCount??'unknown'}`:'')+
    (o.method?` · ${o.method} ${o.endpoint??'endpoint-unavailable'}`:'')+
    (o.method||o.httpStatus!==undefined?` · HTTP ${o.httpStatus??'unknown'}`:'')+
    (o.kubernetesReason?` · Kubernetes ${o.kubernetesReason}`:'')+
    (o.commandFailure?` · command ${o.commandFailure}`:'')+
    (o.exitCode!==undefined?` · exit ${o.exitCode}`:'')+(o.processSignal?` · signal ${o.processSignal}`:'')+
    (o.attempt!==undefined?` · attempt ${o.attempt}/3`:'')+
    (o.retrying!==undefined?` · retry ${o.retrying?'after identity recheck':'not scheduled'}`:'')+
    (o.requestAttempted!==undefined?` · request ${o.requestAttempted?'attempted':'not attempted'}`:'');
  return [`Resource ${d.kind} · reference ${d.scope.slice(0,12)} · ${d.state} · capture ${d.collection}`,
    ...(d.firstFailure?['First failure: '+render(d.firstFailure)]:[]),'Last observation: '+render(last),
    ...d.history.map(render),`${d.omittedObservations} repeated/older observations compacted.`];
}
