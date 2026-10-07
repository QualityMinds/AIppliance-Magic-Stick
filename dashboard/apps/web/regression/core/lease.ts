import {HarnessError, requireSafe} from './errors.ts';

export interface Lease {
  apiVersion: 'coordination.k8s.io/v1'; kind: 'Lease';
  metadata: {name: string; namespace: string; resourceVersion: string; labels: Record<string, string>};
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
  async acquire() {
    requireSafe(!this.held && !this.fenced, 'LOCK_LOST');
    const lease = await this.store.read(); this.validate(lease);
    const holderReason = leaseHolderReason(lease, this.now());
    if (holderReason) throw new HarnessError(holderReason);
    const changed: Lease = {...lease, spec: {...lease.spec, holderIdentity: this.owner,
      renewTime: leaseTime(this.now()), leaseDurationSeconds: this.durationSeconds}};
    try { await this.store.replace(changed); } catch { throw new HarnessError('LOCK_BUSY'); }
    this.held = true; this.lastHeartbeat = this.now();
    await this.assertHeld();
  }
  async assertHeld() {
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
  async heartbeat() {
    await this.assertHeld();
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
  async reserveOfflineWindow(seconds: number) {
    requireSafe(!this.offlineReserved && Number.isInteger(seconds) && seconds >= this.ordinaryDurationSeconds && seconds <= 2100, 'CONFIG');
    await this.resize(seconds);
    this.offlineReserved = true;
  }
  async finishOfflineWindow() {
    requireSafe(this.offlineReserved, 'CONFIG');
    await this.resize(this.ordinaryDurationSeconds);
    this.offlineReserved = false;
  }
  private async resize(seconds: number) {
    await this.assertHeld();
    try {
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner && lease.spec.leaseDurationSeconds === this.durationSeconds &&
        this.now() < Date.parse(lease.spec.renewTime!) + this.durationSeconds * 1000, 'LOCK_LOST');
      await this.store.replace({...lease, spec: {...lease.spec, leaseDurationSeconds: seconds, renewTime: leaseTime(this.now())}});
      this.durationSeconds = seconds; this.lastHeartbeat = this.now();
    } catch { this.held = false; this.fenced = true; throw new HarnessError('LOCK_LOST'); }
  }
  async release() {
    await this.assertHeld();
    try {
      const lease = await this.store.read(); this.validate(lease);
      requireSafe(lease.spec.holderIdentity === this.owner, 'LOCK_LOST');
      await this.store.replace({...lease, spec: {...lease.spec, holderIdentity: '', renewTime: leaseTime(this.now())}});
    }
    catch { this.held = false; this.fenced = true; throw new HarnessError('LOCK_LOST'); }
    this.held = false;
  }
}
