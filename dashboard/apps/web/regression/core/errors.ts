export const reasons = {
  CONFIG: 'The private lab configuration is missing or invalid.',
  PREREQUISITE: 'This required live case needs a separately prepared identity, application, peer, runtime or maintenance fixture; it was not substituted by a mock or a read-only check.',
  PREPARATION_FAILED: 'Automatic preparation failed. This dependent live check could not start; inspect the original HAR-02 preparation failure.',
  DEPENDENCY: 'An earlier step in this scenario failed or was blocked. This dependent check was not reached.',
  PRIVATE_FILE: 'A private input or output is missing, unsafe, unreadable or a symbolic link.',
  TLS: 'A configured endpoint failed verified HTTPS/DNS connectivity.',
  AUTH: 'The real dashboard login or expected administrator identity could not be verified.',
  API: 'A required authenticated API read failed or returned an unexpected contract.',
  COMPONENT: 'An owning UI component suite failed or timed out. A bounded component-failure.json diagnostic is retained when available.',
  IDENTITY: 'The appliance or node does not match the pinned lab identity.',
  CAPABILITY: 'An expected compute target or engine is unavailable.',
  APPLICATION_MODEL: 'No small advertised CPU application model has verified native context for every selected application and its context edit within available RAM. The ordinary CPU smoke model is not a compatible substitute.',
  GPU_PROVIDER: 'This appliance has no physical GPU for the provider required by this scenario. Independent provider scenarios still run.',
  GPU_VALIDATION: 'The selected physical GPU and engine have not passed the required current-boot validation. Run Hardware verification for this exact GPU and engine.',
  REVISION: 'The requested deployed revision or image digest was not observed.',
  HOST: 'The host worker or node is unavailable, stale or has changed boot identity.',
  BUSY: 'A host operation, update or unrelated workload makes the selected lab busy.',
  OBSERVER: 'The Kubernetes observer is unavailable or has excessive permissions.',
  MUTATION: 'The requested API action is outside this test run\'s strict allowlist and was not sent.',
  LOCK_BUSY: 'Another run owns the lab lease.',
  LOCK_STALE: 'An expired lab lease cannot yet be recovered: its drain window or exact private run evidence is not verified.',
  LOCK_LOST: 'Lab lease ownership or heartbeat was lost; new mutations are forbidden.',
  OWNERSHIP: 'Cleanup ownership is ambiguous or the live resource UID has changed.',
  CLEANUP: 'Owned-resource cleanup could not be verified. Later writes are fenced; the next registered run inspects its recovery journal.',
  CONFLICT: 'An intervening revision prevents automatic restoration.',
  DEADLINE: 'The stage deadline expired without matching current-generation evidence.',
  UNEXPECTED: 'The harness failed unexpectedly; private diagnostics require review.',
  MISSING_EVIDENCE: 'The runner did not record a required test/layer result or a causal prerequisite. This is a harness reporting failure, not a missing lab prerequisite.',
  LAB: 'This target is not the registered disposable regression appliance. Live writes were refused.',
  RECOVERY: 'A previous test did not prove restoration. Dependent live writes are fenced; independent tests continue.',
  CANCELLED: 'The run was stopped by the operator. Remaining tests were not executed.',
  EXTERNAL_RUNNER: 'This test can restart, disconnect or replace the Appliance hosting this runner. Run it from the external Docker runner; it cannot be independently verified by an in-Appliance Job.',
} as const;

export type ReasonCode = keyof typeof reasons;
/** Absence of a lab prerequisite is not a product failure. API/authentication,
 * invalid generated configuration, timeouts and assertions are failures. */
export const blockedReasons: readonly ReasonCode[] = ['PREREQUISITE', 'PREPARATION_FAILED', 'DEPENDENCY', 'PRIVATE_FILE', 'TLS', 'IDENTITY', 'CAPABILITY', 'APPLICATION_MODEL', 'GPU_PROVIDER', 'GPU_VALIDATION',
  'HOST', 'BUSY', 'OBSERVER', 'LOCK_BUSY', 'LOCK_STALE', 'LOCK_LOST', 'LAB', 'RECOVERY', 'CANCELLED', 'EXTERNAL_RUNNER'];
export const stages = ['preflight', 'host-boot', 'host-readiness', 'login-form', 'login-return', 'login-session',
  'kubernetes-access', 'kubernetes-revoke', 'kubeconfig-export', 'kubeconfig-copy', 'kubeconfig-download',
  'model-estimate', 'model-create', 'model-ready', 'module-ready', 'app-ready', 'gateway-ready', 'model-stopped', 'model-failure', 'external-ready', 'external-stopped',
  'cleanup', 'recovery-barrier', 'recovery-journal', 'recovery-resource', 'recovery-module', 'recovery-sharing', 'report-evidence',
  'baseline-models', 'baseline-pods', 'baseline-intents', 'baseline-claims', 'baseline-routes', 'baseline-host', 'baseline-keys',
  'flux-ready', 'gpu-backend', 'gpu-binding', 'gpu-validation', 'gpu-slots', 'model-route', 'model-inference', 'model-update'] as const;

/** Fixed stage names expose which bounded operation failed, never its raw body. */
export async function atStage<T>(stage:Stage,action:()=>Promise<T>):Promise<T> {
  try{return await action();}catch(error){throw new HarnessError(error instanceof HarnessError?error.code:'UNEXPECTED',
    error instanceof HarnessError?error.outcome:'Failed',error instanceof HarnessError&&error.stage?error.stage:stage);}
}
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
