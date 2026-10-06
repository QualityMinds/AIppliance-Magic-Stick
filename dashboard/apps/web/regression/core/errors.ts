export const reasons = {
  CONFIG: 'The private lab configuration is missing or invalid.',
  PREREQUISITE: 'This required live case needs a separately prepared identity, application, peer, runtime or maintenance fixture; it was not substituted by a mock or a read-only check.',
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
  LAB: 'This target is not the registered disposable regression appliance. Live writes were refused.',
  RECOVERY: 'A previous test did not prove restoration. Dependent live writes are fenced; independent tests continue.',
  CANCELLED: 'The run was stopped by the operator. Remaining tests were not executed.',
} as const;

export type ReasonCode = keyof typeof reasons;
/** Absence of a lab prerequisite is not a product failure. API/authentication,
 * invalid generated configuration, timeouts and assertions are failures. */
export const blockedReasons: readonly ReasonCode[] = ['PREREQUISITE', 'PRIVATE_FILE', 'TLS', 'IDENTITY', 'CAPABILITY',
  'HOST', 'BUSY', 'OBSERVER', 'LOCK_BUSY', 'LOCK_STALE', 'LOCK_LOST', 'LAB', 'RECOVERY', 'CANCELLED'];
export const stages = ['preflight', 'host-boot', 'host-readiness', 'login-form', 'login-return', 'login-session',
  'model-ready', 'model-stopped', 'model-failure', 'external-ready', 'external-stopped',
  'cleanup', 'recovery-barrier', 'flux-ready', 'gpu-backend', 'gpu-binding', 'gpu-validation', 'gpu-slots', 'model-inference', 'model-update'] as const;
export type Stage = typeof stages[number];

/** Messages are fixed, public-safe strings. Never include an upstream body/token. */
export class HarnessError extends Error {
  readonly code: ReasonCode;
  readonly outcome: 'Blocked' | 'Failed';
  readonly stage?: Stage;

  constructor(code: ReasonCode, outcome: 'Blocked' | 'Failed' = blockedReasons.includes(code) ? 'Blocked' : 'Failed', stage?: Stage) {
    super(`[${code}] ${reasons[code]} [outcome:${outcome}]${stage && stages.includes(stage) ? ` [stage:${stage}]` : ''}`);
    this.name = 'HarnessError';
    this.code = code;
    this.outcome = outcome;
    this.stage = stage;
  }
}

export function requireSafe(condition: unknown, code: ReasonCode): asserts condition {
  if (!condition) throw new HarnessError(code);
}

/** After prerequisites are established, a violated product postcondition is
 * a failed regression, not an unavailable lab. Fixed messages remain redacted. */
export function requireProof(condition:unknown,code:ReasonCode):asserts condition {
  if(!condition)throw new HarnessError(code, code === 'PREREQUISITE' ? 'Blocked' : 'Failed');
}
