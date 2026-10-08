import {HarnessError, requireSafe} from './errors.ts';

export interface Lease {
  apiVersion: 'coordination.k8s.io/v1'; kind: 'Lease';
  metadata: {name: string; namespace: string; uid?:string; resourceVersion: string; labels: Record<string, string>;annotations?:Record<string,string>};
  spec: {holderIdentity?: string; renewTime?: string; leaseDurationSeconds?: number};
}
export interface LeaseStore {read(): Promise<Lease>; replace(lease: Lease): Promise<Lease>}

/** Shared by ordinary acquisition and registration refresh. Invalid expiry
 * evidence is busy, never authority to take over or erase a holder. */
export function leaseHolderReason(lease: Pick<Lease, 'spec'>, now = Date.now()) {
  if (!lease.spec?.holderIdentity) return undefined;
  const duration = lease.spec.leaseDurationSeconds;
  const renewed = Date.parse(lease.spec.renewTime ?? '');
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0 &&
    Number.isFinite(renewed) && now >= renewed + duration * 1000 ? 'LOCK_STALE' : 'LOCK_BUSY';
}

// Kubernetes metav1.MicroTime requires six fractional digits on Lease writes;
// Date#toISOString emits only three and the API rejects that otherwise-valid
// looking timestamp before CAS can take place.
function leaseTime(milliseconds: number) {
  return new Date(milliseconds).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** CAS on a pre-provisioned, appliance-labelled Lease. Never creates or steals one. */
export class LabLease {
  readonly owner: string;
  private readonly store: LeaseStore;
  private readonly targetUid: string;
  private readonly now: () => number;
  private durationSeconds: number;
  private readonly ordinaryDurationSeconds: number;
  private offlineReserved = false;
  private held = false;
  private fenced = false;
  private lastHeartbeat = 0;
  private operation:Promise<unknown>=Promise.resolve();
  private exclusive<T>(action:()=>Promise<T>) {
    const next=this.operation.catch(()=>{}).then(action);this.operation=next;return next;
  }
  constructor(store: LeaseStore, owner: string, targetUid: string,
    now: () => number = Date.now, durationSeconds = 60) {
    this.store = store; this.owner = owner; this.targetUid = targetUid;
    this.now = now; this.durationSeconds = durationSeconds; this.ordinaryDurationSeconds = durationSeconds;
  }

  private validate(lease: Lease) {
    requireSafe(lease.kind === 'Lease' && lease.apiVersion === 'coordination.k8s.io/v1' &&
      lease.metadata.namespace === 'magicstick-regression' && lease.metadata.name === 'lab-lock' && lease.metadata.resourceVersion &&
      lease.metadata.labels['regression.magicstick.dev/appliance-uid'] === this.targetUid, 'IDENTITY');
  }
  acquire(recoveryRunId?:string) {return this.exclusive(()=>this.acquireInternal(recoveryRunId));}
  private async acquireInternal(recoveryRunId?:string) {
    requireSafe(!this.held && !this.fenced, 'LOCK_LOST');
    const lease = await this.store.read(); this.validate(lease);
    const holderReason = leaseHolderReason(lease, this.now());
    if (holderReason) throw new HarnessError(holderReason);
    requireSafe(!recoveryRunId||/^reg-[0-9a-f-]{36}$/.test(recoveryRunId),'CONFIG');
    const changed: Lease = {...lease,metadata:{...lease.metadata,annotations:{...lease.metadata.annotations,
      'regression.magicstick.dev/recovering':'false','regression.magicstick.dev/recovery-original-owner':'',
      'regression.magicstick.dev/run-id':recoveryRunId??this.owner}},spec: {...lease.spec, holderIdentity: this.owner,
      renewTime: leaseTime(this.now()), leaseDurationSeconds: this.durationSeconds}};
    try { await this.store.replace(changed); } catch { throw new HarnessError('LOCK_BUSY'); }
    this.held = true; this.lastHeartbeat = this.now();
    await this.assertHeldInternal();
  }
  /** Used only by registered-lab recovery after validating the exact private
   * run/session/journals. Ordinary acquire() still never steals a stale lease.
   * A 60s drain after expiry outlasts the runner's bounded HTTP writes. */
  acquireRecovery(expected:Lease,runId:string) {return this.exclusive(()=>this.acquireRecoveryInternal(expected,runId));}
  private async acquireRecoveryInternal(expected:Lease,runId:string) {
    requireSafe(!this.held&&!this.fenced&&/^reg-[0-9a-f-]{36}$/.test(runId),'RECOVERY');
    this.validate(expected);
    const lease=await this.store.read();this.validate(lease);
    requireSafe(expected.metadata.uid&&lease.metadata.uid===expected.metadata.uid&&
      lease.metadata.resourceVersion===expected.metadata.resourceVersion&&lease.spec.holderIdentity===expected.spec.holderIdentity&&
      lease.spec.renewTime===expected.spec.renewTime&&lease.spec.leaseDurationSeconds===expected.spec.leaseDurationSeconds&&
      leaseHolderReason(lease,this.now())==='LOCK_STALE'&&
      this.now()>=Date.parse(lease.spec.renewTime!)+lease.spec.leaseDurationSeconds!*1000+60_000,'LOCK_STALE');
    try {await this.store.replace({...lease,metadata:{...lease.metadata,annotations:{...lease.metadata.annotations,
      'regression.magicstick.dev/run-id':runId,'regression.magicstick.dev/recovering':'true',
      'regression.magicstick.dev/recovery-original-owner':lease.metadata.annotations?.['regression.magicstick.dev/recovering']==='true'?
        lease.metadata.annotations['regression.magicstick.dev/recovery-original-owner']!:lease.spec.holderIdentity!}},spec:{...lease.spec,holderIdentity:this.owner,
      renewTime:leaseTime(this.now()),leaseDurationSeconds:this.durationSeconds}});}catch{throw new HarnessError('LOCK_BUSY');}
    this.held=true;this.lastHeartbeat=this.now();await this.assertHeldInternal();
  }
  assertHeld() {return this.exclusive(()=>this.assertHeldInternal());}
  private async assertHeldInternal() {
    try {
      requireSafe(this.held && !this.fenced && this.now() >= this.lastHeartbeat &&
        this.now() - this.lastHeartbeat < this.durationSeconds * 1000, 'LOCK_LOST');
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner && lease.spec.leaseDurationSeconds === this.durationSeconds &&
        Number.isFinite(Date.parse(lease.spec.renewTime ?? '')) &&
        this.now() < Date.parse(lease.spec.renewTime!) + this.durationSeconds * 1000, 'LOCK_LOST');
    } catch {
      this.held = false; this.fenced = true;
      throw new HarnessError('LOCK_LOST');
    }
  }
  heartbeat() {return this.exclusive(()=>this.heartbeatInternal());}
  /** A reserved physical outage intentionally makes the API unavailable.
   * Keep the local expiry fence, but do not probe it from the background loop
   * until the foreground has independently verified the appliance is back. */
  backgroundHeartbeat() {return this.exclusive(async()=>{
    if(this.offlineReserved) {
      if(!this.held||this.fenced||this.now()<this.lastHeartbeat||this.now()-this.lastHeartbeat>=this.durationSeconds*1000) {
        this.held=false;this.fenced=true;throw new HarnessError('LOCK_LOST');
      }
      return;
    }
    await this.heartbeatInternal();
  });}
  private async heartbeatInternal() {
    await this.assertHeldInternal();
    try {
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner, 'LOCK_LOST');
      await this.store.replace({...lease, spec: {...lease.spec, renewTime: leaseTime(this.now())}});
    }
    catch { this.held = false; this.fenced = true; throw new HarnessError('LOCK_LOST'); }
    this.lastHeartbeat = this.now();
  }
  /** A maintenance test may reserve one bounded outage BEFORE its write. This
   * is a CAS of our unexpired lease, never takeover or revival after an outage.
   * Offline observation is read-only; mutations resume only after assertHeld. */
  reserveOfflineWindow(seconds: number) {return this.exclusive(async()=>{
    requireSafe(!this.offlineReserved && Number.isInteger(seconds) && seconds >= this.ordinaryDurationSeconds && seconds <= 2100, 'CONFIG');
    await this.resizeInternal(seconds);
    this.offlineReserved = true;
  });}
  finishOfflineWindow() {return this.exclusive(async()=>{
    requireSafe(this.offlineReserved, 'CONFIG');
    await this.resizeInternal(this.ordinaryDurationSeconds);
    this.offlineReserved = false;
  });}
  private async resizeInternal(seconds: number) {
    await this.assertHeldInternal();
    try {
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner && lease.spec.leaseDurationSeconds === this.durationSeconds &&
        this.now() < Date.parse(lease.spec.renewTime!) + this.durationSeconds * 1000, 'LOCK_LOST');
      await this.store.replace({...lease, spec: {...lease.spec, leaseDurationSeconds: seconds, renewTime: leaseTime(this.now())}});
      this.durationSeconds = seconds; this.lastHeartbeat = this.now();
    } catch { this.held = false; this.fenced = true; throw new HarnessError('LOCK_LOST'); }
  }
  release() {return this.exclusive(()=>this.releaseInternal());}
  private async releaseInternal() {
    await this.assertHeldInternal();
    try {
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner, 'LOCK_LOST');
      await this.store.replace({...lease, spec: {...lease.spec, holderIdentity: '', renewTime: leaseTime(this.now())}});
    }
    catch { this.held = false; this.fenced = true; throw new HarnessError('LOCK_LOST'); }
    this.held = false;
  }
}
