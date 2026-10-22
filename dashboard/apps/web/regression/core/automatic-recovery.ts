import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {newRunId,ResourceJournal,type CleanupAdapter,type ResourceKind} from './journal.ts';
import {LabLease,leaseHolderReason,type Lease,type LeaseStore} from './lease.ts';
import {HeartbeatLoop,bounded} from './run-lifecycle.ts';
import {readPrivate,writePrivate} from './private-files.ts';
import {HarnessError,requireSafe,atStage} from './errors.ts';
import type {LabRegistration} from './lab-policy.ts';
import {BorrowedModule} from './borrowed-module.ts';
import {BorrowedSharing,canonical,type SharingAdapter} from './borrowed-sharing.ts';
import type {KubeObject} from './observer.ts';
import type {RunnerSession} from './runner-session.ts';
import {poll} from './poll.ts';
import {recoveryInventory,type ModuleReceipt,type SharingReceipt} from './recovery-inventory.ts';
import {attestCleanup,verifyReservationReleased} from './cleanup-state.ts';
import {progressEvent} from './progress.ts';

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
    return atStage('recovery-journal',()=>this.prepareJournal(root,lease,registration,now));
  }
  private static async prepareJournal(root:string,lease:Lease,registration:LabRegistration,now:number) {
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
    const inventory=await recoveryInventory(directory,registration),{journals}=inventory;
    requireSafe(journals[0]?.runId===runId,'RECOVERY');
    requireSafe(inventory.unfinished===0,'RECOVERY');
    const modules=inventory.modules.filter(item=>item.state!=='restored'),sharing=inventory.sharing.filter(item=>item.pending);
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
    progressEvent({event:'cleanup-state',cleanup:{state:'running',checkedAt:new Date().toISOString(),stage:'recovery-journal'}});
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
        await verifyRecoveryClosed(this.directory,this.registration,adapters,free);
        await adapters.verifyTarget();await free();
      },600_000,'cleanup',()=>adapters.cancel());
      await verifyReservationReleased(this.directory,this.registration,()=>adapters.store.read());
      await attestCleanup(this.directory,this.registration,true);
      return this.runId;
    }
    const owner=newRunId(),lease=new LabLease(adapters.store,owner,this.registration.applianceUid,Date.now,120);
    const readonly=async()=>{};
    // Validate every owned/borrowed object before claiming recovery or deleting
    // the first resource. A changed UID/generation never gets adopted.
    for(const journal of this.journals)for(const entry of journal.recoveryPlan()) {
      await atStage('recovery-resource',async()=>{
        const current=await adapters.cleanup(journal,readonly)[entry.kind].lookup(entry);
        requireSafe(!current||entry.uid!==null&&entry.uid===current.uid,'OWNERSHIP');
      });
    }
    for(const receipt of this.modules) {
      await atStage('recovery-module',async()=>{
      const borrowed=await BorrowedModule.resume(receipt.filename,adapters.module(receipt.original,readonly),readonly);
      // Read-only comparison, without changing the ambiguous receipt.
      const current=await adapters.module(receipt.original,readonly).read(),expected=receipt.applied??receipt.original;
      requireSafe(current.metadata.uid===expected.metadata.uid&&current.metadata.generation===expected.metadata.generation&&
        canonical(current.spec)===canonical(expected.spec),'CONFLICT');void borrowed;
      });
    }
    for(const receipt of this.sharing)await atStage('recovery-sharing',async()=> (await BorrowedSharing.resume(receipt.filename,receipt.identity,
      adapters.sharing(receipt.identity,readonly),readonly)).verifyRecoverable());
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
          await atStage('recovery-resource',()=>journal.cleanup(cleanup,guard));
        }
        for(const item of this.modules) {
          const borrowed=await BorrowedModule.resume(item.filename,adapters.module(item.original,guard),guard);
          await atStage('recovery-module',async()=>{await borrowed.reconcileUnchanged();await borrowed.restore();});
        }
        // Models/apps are gone before changing GPU backends.
        for(const item of this.sharing) {
          const adapter=adapters.sharing(item.identity,guard),borrowed=await BorrowedSharing.resume(item.filename,item.identity,adapter,guard);
          await atStage('recovery-sharing',async()=>{await borrowed.reconcileUnchanged();await borrowed.restore();});
          for(const entry of borrowed.entries)await poll(()=>adapter.read(entry.provider),value=>value.object.metadata.uid===entry.uid&&
            value.state.phase==='Ready'&&value.state.mode===entry.originalMode&&value.state.maxModels===entry.originalCount,
          {timeoutMs:180_000,intervalMs:1000,stage:'gpu-backend'});
        }
        await adapters.verifyTarget();await guard();
        requireSafe(this.journals.every(journal=>journal.recoveryPlan().length===0),'CLEANUP');
        await verifyRecoveryClosed(this.directory,this.registration,adapters,guard);
        await writePrivate(filename,{...receipt,state:'restored',updatedAt:new Date().toISOString()});
        await lease.release();
        await writePrivate(filename,{...receipt,state:'released',updatedAt:new Date().toISOString()});
        await verifyReservationReleased(this.directory,this.registration,()=>adapters.store.read());
        await attestCleanup(this.directory,this.registration,true);
      },600_000,'cleanup',async()=>{retired=true;await adapters.cancel();});
      return this.runId;
    } catch(error) {
      await writePrivate(filename,{...receipt,state:'blocked',reason:error instanceof HarnessError?error.code:'RECOVERY',
        stage:error instanceof HarnessError?error.stage??'cleanup':'cleanup',updatedAt:new Date().toISOString()});
      if(error instanceof HarnessError)throw error;throw new HarnessError('RECOVERY');
    } finally {retired=true;await heartbeat.stop();}
  }
}

/** Reuse the recovery adapters for positive, read-only closure evidence. Older
 * restored receipts can precede later legitimate scenarios; verify only the
 * newest confirmed revision of each borrowed object, never adopt a new one. */
export async function verifyRecoveryClosed(directory:string,identity:{applianceUid:string;nodeUids:string[]},adapters:RecoveryAdapters,
  guard:()=>Promise<void>) {
  const inventory=await recoveryInventory(directory,identity);requireSafe(inventory.open===0,'CLEANUP');
  for(const journal of inventory.journals)for(const entry of journal.entries) {
    await guard();requireSafe(await adapters.cleanup(journal,guard)[entry.kind].verifyRemoved(entry),'CLEANUP');
  }
  const modules=new Map<string,ModuleReceipt>();
  for(const item of inventory.modules) {
    const uid=item.original.metadata.uid!,previous=modules.get(uid);
    if(!previous||Number((item.restored??item.original).metadata.generation)>Number((previous.restored??previous.original).metadata.generation))modules.set(uid,item);
  }
  for(const item of modules.values()) {
    await guard();const current=await adapters.module(item.original,guard).read(),expected=item.restored??item.original;
    requireSafe(current.metadata.uid===expected.metadata.uid&&current.metadata.generation===expected.metadata.generation&&
      canonical(current.spec)===canonical(item.original.spec),'CONFLICT');
  }
  const latest=new Map<string,{receipt:SharingReceipt;provider:'amd'|'nvidia';generation:number}>();
  for(const receipt of inventory.sharing) {
    const sharing=await BorrowedSharing.resume(receipt.filename,receipt.identity,adapters.sharing(receipt.identity,guard),guard);
    for(const entry of sharing.entries) {
      const key=entry.provider+':'+entry.uid;
      if(!latest.has(key)||entry.generation>latest.get(key)!.generation)latest.set(key,{receipt,provider:entry.provider,generation:entry.generation});
    }
  }
  for(const {receipt,provider}of latest.values())await (await BorrowedSharing.resume(receipt.filename,receipt.identity,
    adapters.sharing(receipt.identity,guard),guard)).verifyRestored([provider]);
}
