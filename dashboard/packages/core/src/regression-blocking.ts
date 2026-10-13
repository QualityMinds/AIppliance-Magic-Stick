import type {RegressionBlockedCounts, RegressionBlockedKind} from '@magicstick/dashboard-contracts';

export const regressionBlockedKinds = ['prerequisite', 'failure', 'cancelled', 'unknown'] as const;
export const emptyBlockedCounts = (): RegressionBlockedCounts => ({prerequisite: 0, failure: 0, cancelled: 0, unknown: 0});

/** Legacy DEPENDENCY evidence is ambiguous until its original step is known. */
export function regressionBlockedKind(reason?: string): RegressionBlockedKind {
  if (reason === 'CANCELLED') return 'cancelled';
  if (['PREPARATION_FAILED', 'CONFIG', 'AUTH', 'API', 'COMPONENT', 'MUTATION', 'OWNERSHIP', 'CLEANUP',
    'CONFLICT', 'DEADLINE', 'UNEXPECTED', 'LOCK_LOST', 'RECOVERY'].includes(reason ?? '')) return 'failure';
  if (['PREREQUISITE', 'PRIVATE_FILE', 'TLS', 'IDENTITY', 'CAPABILITY', 'HOST', 'BUSY', 'OBSERVER',
    'LOCK_BUSY', 'LOCK_STALE', 'LAB', 'EXTERNAL_RUNNER'].includes(reason ?? '')) return 'prerequisite';
  return 'unknown';
}

export function regressionBlockedLabel(kind: RegressionBlockedKind): string {
  return {prerequisite: 'Blocked by prerequisite', failure: 'Blocked by failure',
    cancelled: 'Blocked by cancellation', unknown: 'Blocked — cause unknown'}[kind];
}

export function regressionBlockedSummary(counts: RegressionBlockedCounts): string {
  return `${counts.prerequisite} by prerequisite · ${counts.failure} by failure` +
    (counts.cancelled ? ` · ${counts.cancelled} cancelled` : '') + (counts.unknown ? ` · ${counts.unknown} cause unknown` : '');
}
