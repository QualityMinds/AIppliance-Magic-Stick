import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {newRunId,ResourceJournal,type CleanupAdapter,type ResourceKind} from './journal.ts';
import {LabLease,leaseHolderReason,type Lease,type LeaseStore} from './lease.ts';
import {HeartbeatLoop,bounded} from './run-lifecycle.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError,requireSafe} from './errors.ts';
import type {LabRegistration} from './lab-policy.ts';
import {BorrowedModule} from './borrowed-module.ts';
import {BorrowedSharing,canonical,type SharingAdapter} from './borrowed-sharing.ts';
import type {KubeObject} from './observer.ts';
import type {RunnerSession} from './runner-session.ts';
import {poll} from './poll.ts';

const runPattern=/^reg-[0-9a-f-]{36}$/;
const drainMs=60_000;
/** A campaign may recover only its exact, finished child. Wait for real expiry
 * and the normal drain; never rewrite renewTime to force a takeover. */
export async function campaignRecoveryLease(root:string,runId:string,targetUid:string,store:LeaseStore,
  options:{timeoutMs?:number;intervalMs?:number;now?:()=>number}={}) {
  requireSafe(runPattern.test(runId),'RECOVERY');
  const session=JSON.parse(await readPrivate(join(root,runId,'runner-session.json'))) as RunnerSession;
  requireSafe(session.version===1&&session.runId===runId&&session.targetUid===targetUid&&session.state==='finished','LOCK_BUSY');
  const now=options.now??Date.now;
  try {
    return await poll(()=>store.read(),lease=>{
      requireSafe(lease.metadata.labels['regression.magicstick.dev/appliance-uid']===targetUid&&
        lease.metadata.annotations?.['regression.magicstick.dev/run-id']===runId,'RECOVERY');
      return !lease.spec.holderIdentity||leaseHolderReason(lease,now())==='LOCK_STALE'&&
        now()>=Date.parse(lease.spec.renewTime!)+lease.spec.leaseDurationSeconds!*1000+drainMs;
    },{timeoutMs:options.timeoutMs??190_000,intervalMs:options.intervalMs??1000,stage:'recovery-barrier'});
  }catch(error) {
    if(error instanceof HarnessError&&error.code==='DEADLINE')throw new HarnessError('LOCK_STALE','Blocked','recovery-barrier');
    throw error;
  }
}
interface ModuleReceipt {filename:string;original:KubeObject;applied?:KubeObject}
interface SharingReceipt {filename:string;identity:{runId:string;targetUid:string;nodeName:string;nodeUid:string}}
export interface RecoveryAdapters {
  store:LeaseStore;
  verifyTarget():Promise<void>;
  cleanup(journal:ResourceJournal,guard:()=>Promise<void>):Record<ResourceKind,CleanupAdapter>;
  module(original:KubeObject,guard:()=>Promise<void>):{read():Promise<KubeObject>;set(enabled:boolean,parameters:Record<string,string>):Promise<unknown>};
  sharing(identity:SharingReceipt['identity'],guard:()=>Promise<void>):SharingAdapter;
  cancel():Promise<void>;
}

/** Read precisely the lease-referenced run, never sweep by prefix. Missing
 * evidence or an unsupported unfinished transaction is a genuine recovery gate. */
export class AutomaticRecovery {
  readonly runId:string;
  readonly directory:string;
  readonly expected:Lease;
  readonly registration:LabRegistration;
  readonly journals:ResourceJournal[];
  readonly modules:ModuleReceipt[];
  readonly sharing:SharingReceipt[];
  private constructor(runId:string,directory:string,expected:Lease,registration:LabRegistration,
    journals:ResourceJournal[],modules:ModuleReceipt[],sharing:SharingReceipt[]) {
    this.runId=runId;this.directory=directory;this.expected=expected;this.registration=registration;
    this.journals=journals;this.modules=modules;this.sharing=sharing;
  }
  static async prepare(root:string,lease:Lease,registration:LabRegistration,now=Date.now()) {
    requireSafe(lease.metadata.labels['regression.magicstick.dev/appliance-uid']===registration.applianceUid,'LAB');
    requireSafe(!lease.spec.holderIdentity||leaseHolderReason(lease,now)==='LOCK_STALE'&&
      now>=Date.parse(lease.spec.renewTime!)+lease.spec.leaseDurationSeconds!*1000+drainMs,'LOCK_STALE');
    const runId=lease.metadata.annotations?.['regression.magicstick.dev/run-id']??lease.spec.holderIdentity!;
    requireSafe(runPattern.test(runId),'RECOVERY');
    const directory=join(root,runId),stat=await lstat(directory).catch(()=>undefined);
    requireSafe(stat?.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'RECOVERY');
    const sessionFile=join(directory,'runner-session.json');
    if(await lstat(sessionFile).catch(()=>undefined)) {
      const session=JSON.parse(await readPrivate(sessionFile)) as RunnerSession;
      requireSafe(session.version===1&&session.runId===runId&&session.targetUid===registration.applianceUid&&
        ['running','finished'].includes(session.state)&&Number.isFinite(Date.parse(session.updatedAt))&&now>=Date.parse(session.updatedAt),'RECOVERY');
      requireSafe(session.state==='finished'||now-Date.parse(session.updatedAt)>=180_000,'LOCK_BUSY');
    } else {
      // Compatibility with completed runs made before parent liveness receipts.
      // No report means the old runner's lifecycle is unknown, not permission.
      const summary=JSON.parse(await readPrivate(join(directory,'summary.json')));
      const reportStat=await lstat(join(directory,'summary.json'));
      requireSafe(summary.version===2&&summary.runId===runId&&now-reportStat.mtimeMs>=drainMs,'RECOVERY');
    }
    const paths=[directory],journals:ResourceJournal[]=[],modules:ModuleReceipt[]=[],sharing:SharingReceipt[]=[];
    for(const entry of await readdir(directory,{withFileTypes:true}))if(/^worker-(?:[1-9]|[1-5][0-9]|6[0-4])$/.test(entry.name)) {
      const child=join(directory,entry.name),s=await lstat(child);
      requireSafe(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o077)===0,'RECOVERY');paths.push(child);
    }
    for(const path of paths) {
      const journal=await ResourceJournal.resume(join(path,'journal.json'),registration.applianceUid);journals.push(journal);
      for(const name of await readdir(path)) {
        const filename=join(path,name);
        if(name.endsWith('.journal.json')) {
          // Phase-2 CPU workflows keep one ownership journal per model. Read
          // only files inside this exact lease-referenced private run; the
          // filename owner, document owner, target, prefix and live UID must
          // all agree. Unknown/malformed journals are a gate, never ignored.
          const match=/^(?:ollama|vllm|unsupported|sanitized|risk-reject|risk-accept|external|provider)-(reg-[0-9a-f-]{36})\.journal\.json$/.exec(name);
          requireSafe(match&&journals.length<128,'RECOVERY');
          const auxiliary=await ResourceJournal.resume(filename,registration.applianceUid);
          requireSafe(auxiliary.runId===match[1]&&!journals.some(item=>item.runId===auxiliary.runId),'RECOVERY');
          journals.push(auxiliary);
        } else if(name==='borrowed-module.json') {
          const value=JSON.parse(await readPrivate(filename));
          requireSafe(value.version===1&&value.original?.metadata?.namespace==='ai-system'&&
            value.original.spec?.enabled===false&&typeof value.original.spec?.module==='string'&&
            !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh/.test(value.original.spec.module),'RECOVERY');
          // Fully restored receipts are historical evidence, not borrowed state.
          if(value.state!=='restored')modules.push({filename,original:value.original,applied:value.applied});
        } else if(/^(?:gpu|mesh|cache|realtime)-sharing\.json$/.test(name)) {
          const value=JSON.parse(await readPrivate(filename));
          requireSafe(value.version===1&&runPattern.test(value.runId)&&value.targetUid===registration.applianceUid&&
            registration.nodeUids.includes(value.nodeUid)&&typeof value.nodeName==='string'&&Array.isArray(value.entries),'RECOVERY');
          if(value.entries.some((entry:{state:string})=>entry.state!=='restored'))sharing.push({filename,
            identity:{runId:value.runId,targetUid:value.targetUid,nodeName:value.nodeName,nodeUid:value.nodeUid}});
        } else if(/^(?:borrowed-amd-profile|license-transaction|license-baseline|federation|mesh-membership|unmanaged-key-fixture|network-baseline-restore|host-drill-[a-z0-9-]+|kube-(?:configmaps|secrets))\.json$/.test(name)) {
          const value=JSON.parse(await readPrivate(filename));
          requireSafe(value.version===1&&['restored','removed','verified'].includes(value.state),'RECOVERY');
        }
      }
    }
    const previous=join(directory,'automatic-recovery.json');
    let recoveryOwner:string|undefined;
    if(await lstat(previous).catch(()=>undefined)) {
      const value=JSON.parse(await readPrivate(previous));
      requireSafe(value.version===1&&value.runId===runId&&value.targetUid===registration.applianceUid&&
        value.leaseUid===lease.metadata.uid&&runPattern.test(value.recoveryOwner),'RECOVERY');recoveryOwner=value.recoveryOwner;
    }
    requireSafe(journals.some(journal=>journal.runId===lease.spec.holderIdentity)||recoveryOwner===lease.spec.holderIdentity||
      lease.metadata.annotations?.['regression.magicstick.dev/recovering']==='true'&&
      journals.some(journal=>journal.runId===lease.metadata.annotations?.['regression.magicstick.dev/recovery-original-owner'])||
      !lease.spec.holderIdentity&&journals.some(journal=>journal.runId===runId),'RECOVERY');
    if(!lease.spec.holderIdentity)requireSafe(journals.every(journal=>journal.recoveryPlan().length===0)&&
      modules.length===0&&sharing.length===0,'RECOVERY');
    return new AutomaticRecovery(runId,directory,lease,registration,journals,modules,sharing);
  }
  async execute(adapters:RecoveryAdapters) {
    await adapters.verifyTarget();
    if(!this.expected.spec.holderIdentity) {
      // Teardown may have failed once, then succeeded in afterAll. A free Lease
      // is not enough: exact durable journals and independent absence must agree.
      const free=async()=>{
        const current=await adapters.store.read();
        requireSafe(current.metadata.uid===this.expected.metadata.uid&&current.metadata.resourceVersion===this.expected.metadata.resourceVersion&&
          !current.spec.holderIdentity,'LOCK_BUSY');
      };
      await bounded(async()=>{
        await free();
        for(const journal of this.journals)for(const entry of journal.entries)if(entry.uid!==null) {
          await free();requireSafe(await adapters.cleanup(journal,free)[entry.kind].verifyRemoved(entry),'CLEANUP');
        }
        await adapters.verifyTarget();await free();
      },600_000,'cleanup',()=>adapters.cancel());
      return this.runId;
    }
    const owner=newRunId(),lease=new LabLease(adapters.store,owner,this.registration.applianceUid,Date.now,120);
    const readonly=async()=>{};
    // Validate every owned/borrowed object before claiming recovery or deleting
    // the first resource. A changed UID/generation never gets adopted.
    for(const journal of this.journals)for(const entry of journal.recoveryPlan()) {
      const current=await adapters.cleanup(journal,readonly)[entry.kind].lookup(entry);
      requireSafe(!current||entry.uid!==null&&entry.uid===current.uid,'OWNERSHIP');
    }
    for(const receipt of this.modules) {
      const borrowed=await BorrowedModule.resume(receipt.filename,adapters.module(receipt.original,readonly),readonly);
      // Read-only comparison, without changing the ambiguous receipt.
      const current=await adapters.module(receipt.original,readonly).read(),expected=receipt.applied??receipt.original;
      requireSafe(current.metadata.uid===expected.metadata.uid&&current.metadata.generation===expected.metadata.generation&&
        canonical(current.spec)===canonical(expected.spec),'CONFLICT');void borrowed;
    }
    for(const receipt of this.sharing)await (await BorrowedSharing.resume(receipt.filename,receipt.identity,
      adapters.sharing(receipt.identity,readonly),readonly)).verifyRecoverable();
    const filename=join(this.directory,'automatic-recovery.json'),receipt={version:1,runId:this.runId,targetUid:this.registration.applianceUid,
      leaseUid:this.expected.metadata.uid,recoveryOwner:owner,state:'verified',updatedAt:new Date().toISOString()};
    await lease.acquireRecovery(this.expected,this.runId);
    const heartbeat=new HeartbeatLoop(()=>lease.heartbeat()).start();
    let retired=false;
    const guard=async()=>{requireSafe(!retired,'LOCK_LOST');heartbeat.check();await lease.assertHeld();};
    try {
      // Only the CAS winner may replace the active recovery receipt. Lease
      // metadata bridges a process death between claim and durable file write.
      if(await lstat(filename).catch(()=>undefined))await writePrivate(join(this.directory,'automatic-recovery-'+owner+'.json'),
        JSON.parse(await readPrivate(filename)),true);
      await writePrivate(filename,receipt);
      await bounded(async()=>{
        for(const journal of [...this.journals].reverse()) {
          const cleanup=adapters.cleanup(journal,guard);
          for(const entry of journal.recoveryPlan())if(entry.uid===null) {
            await guard();requireSafe(!await cleanup[entry.kind].lookup(entry),'OWNERSHIP');
            requireSafe(await cleanup[entry.kind].verifyRemoved(entry),'CLEANUP');await journal.recoveredAbsent(entry.kind,entry.name);
          }
          await journal.cleanup(cleanup,guard);
        }
        for(const item of this.modules) {
          const borrowed=await BorrowedModule.resume(item.filename,adapters.module(item.original,guard),guard);
          await borrowed.reconcileUnchanged();await borrowed.restore();
        }
        // Models/apps are gone before changing GPU backends.
        for(const item of this.sharing) {
          const adapter=adapters.sharing(item.identity,guard),borrowed=await BorrowedSharing.resume(item.filename,item.identity,adapter,guard);
          await borrowed.reconcileUnchanged();await borrowed.restore();
          for(const entry of borrowed.entries)await poll(()=>adapter.read(entry.provider),value=>value.object.metadata.uid===entry.uid&&
            value.state.phase==='Ready'&&value.state.mode===entry.originalMode&&value.state.maxModels===entry.originalCount,
          {timeoutMs:180_000,intervalMs:1000,stage:'gpu-backend'});
        }
        await adapters.verifyTarget();await guard();
        requireSafe(this.journals.every(journal=>journal.recoveryPlan().length===0),'CLEANUP');
        await writePrivate(filename,{...receipt,state:'restored',updatedAt:new Date().toISOString()});
        await lease.release();
        await writePrivate(filename,{...receipt,state:'released',updatedAt:new Date().toISOString()});
      },600_000,'cleanup',async()=>{retired=true;await adapters.cancel();});
      return this.runId;
    } catch(error) {
      await writePrivate(filename,{...receipt,state:'blocked',updatedAt:new Date().toISOString()});
      if(error instanceof HarnessError)throw error;throw new HarnessError('RECOVERY');
    } finally {retired=true;await heartbeat.stop();}
  }
}
