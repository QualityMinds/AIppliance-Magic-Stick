/** Selection is explicit and fail-closed. File names describe behavior, not phases. */
export const selections: Record<string, string[]> = {
  selftest: ['harness/safety.unit.spec.ts'],
  'smoke-fast': ['auth/session.contract.spec.ts', 'api-access/keys.contract.spec.ts',
    'models/lifecycle.contract.spec.ts', 'navigation/status.unit.spec.ts', 'navigation/status.contract.spec.ts',
    'observability/logs.contract.spec.ts', 'components/installed.unit.spec.ts'],
  'smoke-fixtures': ['navigation/status.browser.spec.ts', 'navigation/navigation.browser.spec.ts',
    'auth/session.browser.spec.ts', 'api-access/keys.browser.spec.ts', 'models/forms.browser.spec.ts',
    'observability/logs.browser.spec.ts'],
  'phase2-fast': ['components/phase2.unit.spec.ts', 'models/control.contract.spec.ts'],
  'phase2-fixtures': ['models/control.browser.spec.ts'],
  'phase2-readonly': ['models/discovery.e2e.spec.ts'],
  'phase2-models': ['models/cpu-model-control.e2e.spec.ts'],
  'phase2-faults': ['models/failure.e2e.spec.ts'],
  'session-smoke': ['auth/session.e2e.spec.ts'],
  locktest: ['harness/lease.api.spec.ts'], ownedtest: ['harness/ownership.api.spec.ts'],
  foundations: ['harness/safety.api.spec.ts'], recover: ['harness/recovery.api.spec.ts'],
  preflight: ['harness/preflight.e2e.spec.ts'], smoke: ['models/cpu-ollama.e2e.spec.ts'],
  'model-edit': ['models/cpu-ollama.e2e.spec.ts'], 'core-smoke': ['models/cpu-ollama.e2e.spec.ts'],
};

export const phaseSteps = {
  phase0: ['selftest', 'preflight', 'locktest', 'foundations', 'preflight'],
  phase1: ['selftest', 'smoke-fast', 'smoke-fixtures', 'preflight', 'session-smoke', 'core-smoke', 'preflight'],
  phase2: ['selftest', 'phase2-fast', 'phase2-fixtures', 'preflight', 'phase2-readonly', 'phase2-models',
    'phase2-faults', 'preflight'],
};

export const cpuWorkflowProfile = (mode?: string) => ({
  edit: mode === 'model-edit', phase1: mode === 'core-smoke',
});
