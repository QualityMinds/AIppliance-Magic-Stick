import {join,dirname,basename} from 'node:path';
import {lstat} from 'node:fs/promises';
import type {RegressionCleanup} from '@magicstick/dashboard-contracts';
import {recoveryInventory,recoveryPaths,type RecoveryIdentity} from './recovery-inventory.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError,requireSafe,reasons,stages} from './errors.ts';
import type {Lease} from './lease.ts';

async function optionalJson(filename:string) {
  try {await lstat(filename);}catch(error) {if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  return JSON.parse(await readPrivate(filename));
}
function proofHeader(value:any,runId:string,targetUid:string) {
  requireSafe(value?.version===1&&value.state==='verified'&&value.runId===runId&&value.targetUid===targetUid&&
    /^[a-f0-9]{64}$/.test(value.fingerprint)&&Array.isArray(value.nodeUids)&&value.nodeUids.length<=64&&
    value.nodeUids.every((n:unknown)=>typeof n==='string'&&n.length>0)&&Number.isFinite(Date.parse(value.checkedAt)),'RECOVERY');
}

/** Complete private reservation receipts only after independently observing the
 * exact appliance Lease free. This does not write or force-release the Lease. */
export async function verifyReservationReleased(directory:string,identity:RecoveryIdentity,read:()=>Promise<Lease>) {
  const lease=await read();
  requireSafe(lease.metadata.uid&&!lease.spec.holderIdentity&&
    lease.metadata.labels['regression.magicstick.dev/appliance-uid']===identity.applianceUid,'CLEANUP');
  const inventory=await recoveryInventory(directory,identity);
  for(const item of inventory.leases) {
    requireSafe(item.value.leaseUid===lease.metadata.uid,'OWNERSHIP');
    if(item.state!=='released')await writePrivate(item.filename,{...item.value,state:'released'});
  }
}

export function cleanupStatus(value:unknown):RegressionCleanup|undefined {
  if(!value||typeof value!=='object')return;
  const v=value as RegressionCleanup;
  if(!['unknown','required','running','verified','blocked'].includes(v.state))return;
  return {state:v.state,...(typeof v.checkedAt==='string'&&v.checkedAt.length<=80&&Number.isFinite(Date.parse(v.checkedAt))?{checkedAt:new Date(v.checkedAt).toISOString()}:{}),
    ...(v.reason&&Object.hasOwn(reasons,v.reason)?{reason:v.reason}:{}),...(v.stage&&stages.includes(v.stage as never)?{stage:v.stage}:{})};
}

/** Called only after the existing cleanup adapters independently verified
 * absence/restoration and released the exact Lease. It is not a cleanup engine. */
export async function attestCleanup(directory:string,identity:RecoveryIdentity,recovered=false) {
  const inventory=await recoveryInventory(directory,identity);requireSafe(inventory.open===0&&inventory.leasePending===0,'CLEANUP');
  const status:RegressionCleanup={state:'verified',checkedAt:new Date().toISOString()};
  await writePrivate(join(directory,'cleanup-verification.json'),{version:1,runId:inventory.journals[0]!.runId,
    targetUid:identity.applianceUid,nodeUids:identity.nodeUids,recovered,fingerprint:inventory.fingerprint(directory),...status});
  return status;
}

/** Evaluate private evidence after the child process group stopped, not from
 * a report boolean. A later write invalidates the exact receipt fingerprint. */
export async function assessCleanup(directory:string,processesStopped:boolean):Promise<RegressionCleanup> {
  const checkedAt=new Date().toISOString();
  try {
    const paths=await recoveryPaths(directory);
    const root=JSON.parse(await readPrivate(join(directory,'journal.json')));
    requireSafe(root.version===1&&typeof root.targetUid==='string'&&Array.isArray(root.entries),'RECOVERY');
    if(/^reg-/.test(basename(directory)))requireSafe(root.runId===basename(directory),'RECOVERY');
    // Node identities are checked by the live adapters before attestation. Use
    // the durable proof identity, never a node supplied by a browser request.
    const proof=await optionalJson(join(directory,'cleanup-verification.json'));
    if(proof!==undefined)proofHeader(proof,root.runId,root.targetUid);
    const nodeUids=new Set<string>(Array.isArray(proof?.nodeUids)?proof.nodeUids.filter((n:unknown)=>typeof n==='string'):[]);
    // Worker proofs bind their own exact node identities as well.
    const {readdir}=await import('node:fs/promises');
    for(const path of paths.slice(1)) {
      const value=await optionalJson(join(path,'cleanup-verification.json'));if(value===undefined)continue;
      const worker=JSON.parse(await readPrivate(join(path,'journal.json')));proofHeader(value,worker.runId,root.targetUid);
      if(value.targetUid===root.targetUid&&Array.isArray(value.nodeUids))for(const uid of value.nodeUids)if(typeof uid==='string')nodeUids.add(uid);
    }
    // Pending sharing can exist before any verification was issued. Read its
    // identity only for inventory; it does not authorize a recovery mutation.
    for(const path of paths)for(const name of await readdir(path))if(/^(?:gpu|mesh|cache|realtime)-sharing\.json$/.test(name)) {
      const value=JSON.parse(await readPrivate(join(path,name)));if(typeof value.nodeUid==='string')nodeUids.add(value.nodeUid);
    }
    const inventory=await recoveryInventory(directory,{applianceUid:root.targetUid,nodeUids:[...nodeUids]});
    if(inventory.open||inventory.leasePending)return {state:'required',checkedAt,reason:'CLEANUP',stage:inventory.open?'cleanup':'recovery-barrier'};
    const session=await optionalJson(join(directory,'runner-session.json'));
    if(session!==undefined)requireSafe(session.version===1&&session.runId===root.runId&&session.targetUid===root.targetUid&&
      ['finished','running'].includes(session.state),'RECOVERY');
    const matches=(value:any,path:string)=>value?.version===1&&value.state==='verified'&&value.targetUid===root.targetUid&&
      inventory.journals.some(j=>j.runId===value.runId&&j.filename===join(path,'journal.json'))&&
      value.fingerprint===inventory.fingerprint(path)&&Number.isFinite(Date.parse(value.checkedAt));
    if(!processesStopped||session&&(session.state!=='finished'||session.processesStopped===false)&&!(proof?.recovered===true&&matches(proof,directory)))
      return {state:'unknown',checkedAt,reason:'RECOVERY',stage:'recovery-barrier'};
    if(matches(proof,directory))return {state:'verified',checkedAt};
    for(const path of inventory.paths) {
      const changed=[...inventory.files].some(([file,body])=>dirname(file)===path&&
        !inventory.leases.some(l=>l.filename===file&&l.state==='released')&&
        (file.endsWith('/journal.json')||file.endsWith('.journal.json')?JSON.parse(body).entries.length>0:true));
      if(!changed)continue;
      const value=await optionalJson(join(path,'cleanup-verification.json'));
      if(!matches(value,path))return {state:'unknown',checkedAt,reason:'RECOVERY',stage:'recovery-journal'};
    }
    return {state:'verified',checkedAt};
  }catch(error) {
    return {state:'blocked',checkedAt,reason:error instanceof HarnessError?error.code:'RECOVERY',stage:'recovery-journal'};
  }
}

/** Aggregate only the exact private child receipts written by this launcher.
 * A report saying "clear" is not a child cleanup receipt. */
export async function assessRunCleanup(output:string,directory:string,processesStopped:boolean,ancestors=new Set<string>()):Promise<RegressionCleanup> {
  const {lstat}=await import('node:fs/promises');
  const own=await lstat(join(directory,'journal.json')).catch(()=>undefined)?await assessCleanup(directory,processesStopped):undefined;
  if(!await lstat(join(directory,'child-runs.json')).catch(()=>undefined))return own??{state:'unknown',checkedAt:new Date().toISOString(),reason:'RECOVERY',stage:'recovery-journal'};
  const checkedAt=new Date().toISOString();
  try {
    requireSafe(!ancestors.has(directory)&&ancestors.size<10,'RECOVERY');ancestors=new Set([...ancestors,directory]);
    const manifest=JSON.parse(await readPrivate(join(directory,'child-runs.json')));
    requireSafe(manifest.version===1&&Array.isArray(manifest.children)&&manifest.children.length>0&&manifest.children.length<=1000,'RECOVERY');
    const {isolatedStep}=await import('./test-mode.ts');
    const states:RegressionCleanup[]=own?[own]:[];
    for(const child of manifest.children) {
      requireSafe(/^reg-[0-9a-f-]{36}$/.test(child.runId)&&typeof child.mode==='string'&&child.fixture===isolatedStep(child.mode),'RECOVERY');
      if(!child.fixture)states.push(await assessRunCleanup(output,join(output,child.runId),processesStopped,ancestors));
    }
    return states.find(s=>s.state==='blocked')??states.find(s=>s.state==='required')??states.find(s=>s.state!=='verified')??{state:'verified',checkedAt};
  }catch{return {state:'unknown',checkedAt,reason:'RECOVERY',stage:'recovery-journal'};}
}
