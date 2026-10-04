export const reasons = {
  CONFIG: 'The private lab configuration is missing or invalid.',
  PRIVATE_FILE: 'A private input or output is missing, unsafe, unreadable or a symbolic link.',
  TLS: 'A configured endpoint failed verified HTTPS/DNS connectivity.',
  AUTH: 'The real dashboard login or expected administrator identity could not be verified.',
  API: 'A required authenticated API read failed or returned an unexpected contract.',
  IDENTITY: 'The appliance or node does not match the pinned lab identity.',
  CAPABILITY: 'An expected compute target or engine is unavailable.',
  REVISION: 'The requested deployed revision or image digest was not observed.',
  HOST: 'The host worker or node is unavailable, stale or has changed boot identity.',
  BUSY: 'A host operation, update or unrelated workload makes the selected lab busy.',
  OBSERVER: 'The Kubernetes observer is unavailable or has excessive permissions.',
  MUTATION: 'The requested API action is outside this test run\'s strict allowlist and was not sent.',
  LOCK_BUSY: 'Another run owns the lab lease.',
  LOCK_STALE: 'A stale lab lease requires owner inspection; it was not taken over.',
  LOCK_LOST: 'Lab lease ownership or heartbeat was lost; new mutations are forbidden.',
  OWNERSHIP: 'Cleanup ownership is ambiguous or the live resource UID has changed.',
  CLEANUP: 'Owned-resource cleanup could not be verified; manual recovery is required.',
  CONFLICT: 'An intervening revision prevents automatic restoration.',
  DEADLINE: 'The stage deadline expired without matching current-generation evidence.',
  UNEXPECTED: 'The harness failed unexpectedly; private diagnostics require review.',
} as const;

export type ReasonCode = keyof typeof reasons;
export const stages = ['preflight', 'host-boot', 'host-readiness', 'login-form', 'login-return', 'login-session',
  'model-ready', 'model-stopped', 'model-failure', 'external-ready', 'external-stopped',
  'cleanup', 'recovery-barrier', 'flux-ready'] as const;
export type Stage = typeof stages[number];

/** Messages are fixed, public-safe strings. Never include an upstream body/token. */
export class HarnessError extends Error {
  readonly code: ReasonCode;
  readonly outcome: 'Blocked' | 'Failed';
  readonly stage?: Stage;

  constructor(code: ReasonCode, outcome: 'Blocked' | 'Failed' = 'Blocked', stage?: Stage) {
    super(`[${code}] ${reasons[code]}${stage && stages.includes(stage) ? ` [stage:${stage}]` : ''}`);
    this.name = 'HarnessError';
    this.code = code;
    this.outcome = outcome;
    this.stage = stage;
  }
}

export function requireSafe(condition: unknown, code: ReasonCode): asserts condition {
  if (!condition) throw new HarnessError(code);
}
