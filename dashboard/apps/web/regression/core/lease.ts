import {HarnessError, requireSafe} from './errors.ts';

export interface Lease {
  apiVersion: 'coordination.k8s.io/v1'; kind: 'Lease';
  metadata: {name: string; namespace: string; resourceVersion: string; labels: Record<string, string>};
  spec: {holderIdentity?: string; renewTime?: string; leaseDurationSeconds?: number};
}
export interface LeaseStore {read(): Promise<Lease>; replace(lease: Lease): Promise<Lease>}

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
  private readonly durationSeconds: number;
  private held = false;
  private fenced = false;
  private lastHeartbeat = 0;
  constructor(store: LeaseStore, owner: string, targetUid: string,
    now: () => number = Date.now, durationSeconds = 60) {
    this.store = store; this.owner = owner; this.targetUid = targetUid;
    this.now = now; this.durationSeconds = durationSeconds;
  }

  private validate(lease: Lease) {
    requireSafe(lease.kind === 'Lease' && lease.apiVersion === 'coordination.k8s.io/v1' &&
      lease.metadata.namespace === 'magicstick-regression' && lease.metadata.name === 'lab-lock' && lease.metadata.resourceVersion &&
      lease.metadata.labels['regression.magicstick.dev/appliance-uid'] === this.targetUid, 'IDENTITY');
  }
  async acquire() {
    requireSafe(!this.held && !this.fenced, 'LOCK_LOST');
    const lease = await this.store.read(); this.validate(lease);
    if (lease.spec.holderIdentity) {
      const expires = Date.parse(lease.spec.renewTime ?? '') + Number(lease.spec.leaseDurationSeconds) * 1000;
      throw new HarnessError(Number.isFinite(expires) && this.now() >= expires ? 'LOCK_STALE' : 'LOCK_BUSY');
    }
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
