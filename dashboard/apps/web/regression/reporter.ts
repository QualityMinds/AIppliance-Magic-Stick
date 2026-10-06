import type {FullConfig, FullResult, Reporter, Suite, TestCase, TestResult} from '@playwright/test/reporter';
import {join} from 'node:path';
import {HarnessError, reasons, stages, blockedReasons, type ReasonCode, type Stage} from './core/errors.ts';
import {phase1FastVariants, phase1FixtureVariants, phase1LiveVariants} from './profiles/phase1-p0.ts';
import {phase2FastVariants, phase2FixtureVariants, phase2ModelIds, phase2ModelCases} from './profiles/phase2-p0.ts';
import {gpuModeIds} from './profiles/gpu-p0.ts';
import {remainingIds} from './profiles/remaining-p0.ts';
import {reportVariants, saveReport, type CaseResult} from './core/report.ts';
import {environmentFor, fileLayer, testLayers, type Evidence} from './core/evidence.ts';
import {caseDescription, durationDescription, layerDescriptions, publicScenarioTitle} from './core/case-descriptions.ts';

/** Playwright serializes Errors without our custom outcome property. Only a
 * fixed allowlisted marker can carry an explicit failure into safe reports. */
export function failureOutcome(code:ReasonCode|undefined,messages:readonly (string|undefined)[]) {
  if(messages.some(message=>message?.includes('[outcome:Failed]')))return 'Failed' as const;
  if(messages.some(message=>message?.includes('[outcome:Blocked]')))return 'Blocked' as const;
  return code && blockedReasons.includes(code) ? 'Blocked' as const : 'Failed' as const;
}

export default class SafeReporter implements Reporter {
  private cases: CaseResult[] = [];
  private unexpected = false;
  private total = 0;
  private started = 0;
  private positions = new Map<TestCase, number>();
  onBegin(_config: FullConfig, suite: Suite) {
    this.total = suite.allTests().length;
    process.stdout.write(`Selected ${this.total} executable tests. Catalogue goals describe case families, not full acceptance.\n`);
  }
  onError() { this.unexpected = true; process.stderr.write('Harness infrastructure error; no raw live details were printed.\n'); }
  private mapping(test: TestCase) {
    const ids = [...new Set(test.title.match(/\b[A-Z][A-Z0-9]+-\d{2}\b/g) ?? [])];
    const variant = test.title.match(/\[p[0-8]:([a-z0-9-]+)\]/)?.[1] as CaseResult['variant'];
    const annotations = test.annotations.filter(item => item.type === 'regression');
    let evidence: Evidence[] = [];
    try { evidence = annotations.map(item => JSON.parse(item.description ?? '')); } catch { this.unexpected = true; }
    if (!annotations.length) {
      const declared = test.title.match(/\[layer:([UCBAEON+]+)\]/)?.[1]?.split('+');
      const layers = declared ?? [fileLayer(test.location.file)].filter(Boolean);
      evidence = ids.flatMap(id => layers.map(layer => ({id, variant, layer: layer as Evidence['layer']})));
    }
    const safe = evidence.filter(item => {
      const valid = item && /^[A-Z][A-Z0-9]+-\d{2}$/.test(item.id) && testLayers.includes(item.layer) &&
        (!item.variant || reportVariants[item.variant] === item.id);
      if (!valid) this.unexpected = true;
      return valid;
    });
    return {ids, evidence: safe};
  }
  onTestBegin(test: TestCase) {
    const position = ++this.started;
    this.positions.set(test, position);
    const {ids, evidence} = this.mapping(test);
    process.stdout.write(`[${position}/${this.total}] START ${ids.join(', ') || 'Unmapped test'}\n`);
    const scenario = publicScenarioTitle(test.title, test.location.file);
    if (scenario) process.stdout.write(`  Scenario: ${scenario}\n`);
    for (const id of [...new Set(evidence.map(item => item.id))]) {
      const selected = evidence.filter(item => item.id === id);
      const variants = [...new Set(selected.map(item => item.variant).filter(Boolean))];
      const layers = [...new Set(selected.map(item => `${item.layer} — ${layerDescriptions[item.layer]}; ${environmentFor(item.layer)}`))];
      process.stdout.write(`  ${id} catalogue goal: ${caseDescription(id)}\n` +
        `  Evidence: ${layers.join(' | ')}${variants.length ? `; variant: ${variants.join(', ')}` : ''}\n`);
    }
  }
  onTestEnd(test: TestCase, result: TestResult) {
    const {ids, evidence} = this.mapping(test);
    const code = result.errors.map(error => error.message?.match(/\[([A-Z_]+)\]/)?.[1])
      .find(value => value && Object.hasOwn(reasons, value)) as ReasonCode | undefined;
    const outcome = result.status === 'passed' ? (result.retry > 0 ? 'Failed' : 'Passed') : result.status === 'skipped' ? 'Blocked' :
      failureOutcome(code,result.errors.map(error=>error.message));
    const stage = result.errors.map(error => error.message?.match(/\[stage:([a-z-]+)\]/)?.[1])
      .find(value => stages.includes(value as Stage)) as Stage | undefined;
    for (const item of evidence) {
      this.cases.push({id: item.id, outcome, layer: item.layer, environment: environmentFor(item.layer),
      durationMs: result.duration, ...(code ? {reason: code} : outcome === 'Failed' ? {reason: 'UNEXPECTED' as const} : {}),
      ...(item.variant ? {variant: item.variant as CaseResult['variant']} : {}), ...(stage ? {stage} : {})});
    }
    const position = this.positions.get(test);
    const reason = code ?? (outcome === 'Failed' ? 'UNEXPECTED' : undefined);
    process.stdout.write(`${position ? `[${position}/${this.total}] ` : ''}${ids.join(', ') || 'Unmapped test'}: ${outcome} — ${durationDescription(result.duration)}\n`);
    if (reason) process.stdout.write(`  Reason (${reason}): ${reasons[reason]}${stage ? ` Stage: ${stage}.` : ''}\n`);
    if (!ids.length || !evidence.length) this.unexpected = true;
  }
  async onEnd(result: FullResult) {
    const directory = process.env.REGRESSION_RUN_DIR, runId = process.env.REGRESSION_RUN_ID;
    if (!directory || !runId) throw new HarnessError('CONFIG');
    const modelCase = process.env.REGRESSION_MODEL_CASE as keyof typeof phase2ModelCases | undefined;
    if (modelCase && !Object.hasOwn(phase2ModelCases, modelCase)) throw new HarnessError('CONFIG');
    const required = remainingIds(process.env.REGRESSION_MODE) ?? gpuModeIds(process.env.REGRESSION_MODE,process.env.REGRESSION_GPU_CASE || undefined) ?? (process.env.REGRESSION_MODE === 'selftest' ? Array.from({length: 11}, (_, index) => `HAR-${String(index + 1).padStart(2, '0')}`) :
      process.env.REGRESSION_MODE === 'phase2-fast' ? [...new Set(Object.values(phase2FastVariants).map(item => item.id))] :
      process.env.REGRESSION_MODE === 'phase2-fixtures' ? [...new Set(Object.values(phase2FixtureVariants).map(item => item.id))] :
      process.env.REGRESSION_MODE === 'phase2-readonly' ? ['DISC-03'] :
      process.env.REGRESSION_MODE === 'phase2-models' ? modelCase ? [...phase2ModelCases[modelCase].ids] : phase2ModelIds :
      process.env.REGRESSION_MODE === 'phase2-faults' ? ['LIFE-12', 'NAV-06'] :
      process.env.REGRESSION_MODE === 'smoke-fast' ? [...new Set(Object.values(phase1FastVariants))] :
      process.env.REGRESSION_MODE === 'smoke-fixtures' ? [...new Set(Object.values(phase1FixtureVariants))] :
      process.env.REGRESSION_MODE === 'core-smoke' ? [...new Set(Object.entries(phase1LiveVariants).filter(([variant]) =>
        !['login-session', 'anonymous-api', 'anonymous-browser', 'logout-session', 'final-idle'].includes(variant)).map(([, id]) => id))] :
      process.env.REGRESSION_MODE === 'session-smoke' ? ['AUTH-01', 'AUTH-02', 'AUTH-06'] :
      process.env.REGRESSION_MODE === 'locktest' ? ['HAR-04', 'HAR-08', 'HAR-09'] :
      process.env.REGRESSION_MODE === 'ownedtest' ? ['HAR-05', 'HAR-06', 'HAR-07'] :
      process.env.REGRESSION_MODE === 'foundations' ? ['HAR-02', 'HAR-03', 'HAR-04', 'HAR-05', 'HAR-06', 'HAR-07', 'HAR-09'] :
      process.env.REGRESSION_MODE === 'gpu-recover' ? ['HAR-07','HAR-08'] : process.env.REGRESSION_MODE === 'recover' ? ['HAR-07'] :
      process.env.REGRESSION_MODE === 'model-edit' ? ['LIFE-01', 'ROUTE-01', 'LIFE-08', 'LIFE-07', 'LIFE-09', 'LIFE-03', 'LIFE-04', 'LIFE-06'] :
      process.env.REGRESSION_MODE === 'smoke' ? ['LIFE-01', 'ROUTE-01', 'LIFE-03', 'LIFE-04', 'LIFE-06'] : ['HAR-01', 'HAR-02', 'HAR-03']);
    const summary = await saveReport(directory, runId, this.cases, required, process.env.REGRESSION_SOURCE_REVISION,
      process.env.REGRESSION_MODE);
    process.stdout.write(`Private report: ${join(directory, 'summary.txt')}\n`);
    return {status: !summary.acceptable || this.unexpected || result.status !== 'passed' ? 'failed' as const : 'passed' as const};
  }
}
