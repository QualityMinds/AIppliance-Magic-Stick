/** Selection is explicit and fail-closed. File names describe behavior, not phases. */
export const selections: Record<string, string[]> = {
  ...Object.fromEntries([5,6,7,8].flatMap(phase=>[
    [`phase${phase}-fast`,['administration/owning.unit.spec.ts','administration/matrix.unit.spec.ts','administration/safety.unit.spec.ts']],
    [`phase${phase}-fixtures`,['administration/configuration.browser.spec.ts']],
    [`phase${phase}-live`,['administration/installed.e2e.spec.ts']],
  ])),
  'phase6-drill':['administration/installed.e2e.spec.ts'],
  selftest: ['harness/safety.unit.spec.ts','harness/input-preparation.unit.spec.ts','harness/reporting.unit.spec.ts','harness/setup-bootstrap.unit.spec.ts','harness/setup-suite.unit.spec.ts'],
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
  'phase3-fast': ['hardware/owning.unit.spec.ts','hardware/borrowed-settings.unit.spec.ts','hardware/safety.unit.spec.ts'],
  'phase4-fast': ['hardware/owning.unit.spec.ts','hardware/borrowed-settings.unit.spec.ts','hardware/safety.unit.spec.ts'],
  'phase3-fixtures': ['hardware/configuration.browser.spec.ts'],
  'phase4-fixtures': ['hardware/configuration.browser.spec.ts'],
  'phase3-gpu': ['hardware/runtime.e2e.spec.ts'],
  'phase3-validation': ['hardware/validation.e2e.spec.ts'],
  'phase4-sharing': ['hardware/sharing.e2e.spec.ts'],
  'gpu-recover': ['hardware/recovery.api.spec.ts'],
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
  phase3: ['selftest','phase3-fast','phase3-fixtures','preflight','phase3-gpu','phase3-validation','preflight'],
  phase4: ['selftest','phase4-fast','phase4-fixtures','preflight','phase4-sharing','preflight'],
  phase5: ['selftest','phase5-fast','phase5-fixtures','preflight','phase5-live','preflight'],
  phase6: ['selftest','phase6-fast','phase6-fixtures','preflight','phase6-live','preflight'],
  phase7: ['selftest','phase7-fast','phase7-fixtures','preflight','phase7-live','preflight'],
  phase8: ['selftest','phase8-fast','phase8-fixtures','preflight','phase8-live','preflight'],
};

export const cpuWorkflowProfile = (mode?: string) => ({
  edit: mode === 'model-edit', phase1: mode === 'core-smoke',
});
