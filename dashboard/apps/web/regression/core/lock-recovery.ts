import {requireSafe} from './errors.ts';
import {leaseHolderReason, type Lease} from './lease.ts';

export interface RecoveryLock {uid: string; resourceVersion: string; runId: string}

export function parseRecoveryLock(value: unknown): RecoveryLock {
  const expected = value as RecoveryLock;
  requireSafe(expected && Object.keys(expected).sort().join(',') === 'resourceVersion,runId,uid' &&
    typeof expected.uid === 'string' && typeof expected.resourceVersion === 'string' && typeof expected.runId === 'string' &&
    /^[a-f0-9-]{36}$/.test(expected.uid) && /^\d{1,32}$/.test(expected.resourceVersion) &&
    /^reg-[a-f0-9-]{36}$/.test(expected.runId), 'CONFIG');
  return expected;
}

/** A UI-confirmed expired lock is a snapshot, not permission to clear whichever
 * owner exists when a queued Job finally starts. Exact journals still apply. */
export function exactRecoveryLock(lease: Lease | undefined, expected: RecoveryLock, now = Date.now()) {
  parseRecoveryLock(expected);
  requireSafe(lease?.metadata.uid === expected.uid && lease.metadata.resourceVersion === expected.resourceVersion &&
    (lease.metadata.annotations?.['regression.magicstick.dev/run-id'] ?? lease.spec.holderIdentity) === expected.runId &&
    lease.spec.holderIdentity, 'CONFLICT');
  requireSafe(leaseHolderReason(lease, now) === 'LOCK_STALE' &&
    now >= Date.parse(lease.spec.renewTime!) + lease.spec.leaseDurationSeconds! * 1000 + 60_000, 'LOCK_STALE');
}
