import type {ReasonCode, Stage} from './errors.ts';
import {reasons, requireSafe, stages} from './errors.ts';
import {phase0Coverage, phase0Variants, type Phase0Variant} from '../profiles/phase0-p0.ts';
import {phase1Coverage, phase1Variants, type Phase1Variant} from '../profiles/phase1-p0.ts';
import {phase2Coverage, phase2Variants, type Phase2Variant} from '../profiles/phase2-p0.ts';
import {writePrivate} from './private-files.ts';
import {join} from 'node:path';
import {environmentFor, testLayers, type TestEnvironment, type TestLayer} from './evidence.ts';

export type Outcome = 'Passed' | 'Failed' | 'Blocked' | 'Skipped' | 'Not run' | 'Flaky';
export interface CaseResult {id: string; outcome: Outcome; layer: TestLayer; environment?: TestEnvironment; durationMs: number; reason?: ReasonCode;
  stage?: Stage; variant?: Phase0Variant | Phase1Variant | Phase2Variant}

export const reportVariants: Record<string, string> = {...phase0Variants, ...phase1Variants,
  ...Object.fromEntries(Object.entries(phase2Variants).map(([variant, definition]) => [variant, definition.id]))};

/** A teardown/infrastructure error can happen after all mapped cases passed. */
export function stepCases(cases: CaseResult[], exitCode: number, acceptable: boolean, fixture: boolean): CaseResult[] {
  // A known blocked/failed case already makes the aggregate fail closed. Only
  // add infrastructure evidence when the child otherwise looks entirely green.
  return (exitCode === 0 && acceptable) || cases.some(item => item.outcome !== 'Passed') ? cases : [...cases,
    {id: 'HAR-10', outcome: 'Failed', layer: fixture ? 'U' : 'A', environment: fixture ? 'fixture' : 'live', durationMs: 0, reason: 'UNEXPECTED'}];
}

export function summarize(required: string[], cases: CaseResult[]) {
  const missing = required.filter(id => !cases.some(item => item.id === id));
  const counts = Object.fromEntries(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].map(
    outcome => [outcome, cases.filter(item => item.outcome === outcome).length]));
  const acceptable = required.length > 0 && cases.length > 0 && missing.length === 0 &&
    required.every(id => cases.filter(item => item.id === id).every(item => item.outcome === 'Passed')) &&
    cases.every(item => item.outcome === 'Passed');
  return {acceptable, required: required.length, selected: cases.length, executed: cases.filter(item => ['Passed', 'Failed', 'Flaky'].includes(item.outcome)).length,
    counts, missing};
}

function xml(value: string) { return value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]!)); }

export function liveReportScope(mode?: string) {
  return mode === 'phase2' ? 'Phase 2 P0 installed CPU model control: Ollama and vLLM forms, persistence, conflicts, memory controls, logs, external routing and one run-owned failure; no GPU/global setting changes' :
    mode === 'phase2-readonly' ? 'Phase 2 read-only live model discovery through API and dashboard; no appliance mutations' :
    mode === 'phase2-models' ? 'Phase 2 run-owned CPU Ollama, CPU vLLM and loopback external-provider lifecycle, persistence, logs and routed inference; no GPU/global setting changes' :
    mode === 'phase2-faults' ? 'Phase 2 one run-owned CPU failure fixture and actionable status; no unrelated workload or global setting changes' :
    mode === 'phase1' ? 'Phase 1 P0 installed CPU/Ollama smoke: real OIDC, access/session, non-mutating navigation, owned model/key lifecycle, logs and routed inference; fault/unknown UI states are isolated browser fixtures; no GPU/global setting changes' :
    mode === 'core-smoke' ? 'Phase 1 owned CPU/Ollama lifecycle, UI keys/logs and real LiteLLM inference; no GPU/global setting changes' :
    mode === 'session-smoke' ? 'Phase 1 real login, unauthenticated access and logout; read-only product state' :
    mode === 'phase0' ? 'Phase 0 P0 harness acceptance: pinned lab, safety faults, owned CPU model/key cleanup and process recovery; no GPU/global product setting changes' :
    mode === 'foundations' ? 'live Phase 0 safety faults using only owned CPU models, keys and the test Lease' :
    mode === 'locktest' ? 'live lease, revision and Flux-polling safety; no product configuration change' :
    mode === 'ownedtest' ? 'live API-key ownership and cleanup subset; no model/app lifecycle acceptance' :
    mode === 'smoke' ? 'live run-owned CPU Ollama lifecycle and routed inference; no GPU/global setting changes' :
    mode === 'model-edit' ? 'live run-owned CPU Ollama model edit, lifecycle and routed inference; no GPU/global setting changes' :
    mode === 'recover' ? 'explicit recovery of one journal-owned run; no new model/app resources' :
    'read-only live preflight';
}

/** Allowlisted output only. Never serialize a Playwright response, error or attachment. */
export async function saveReport(directory: string, runId: string, cases: CaseResult[], required: string[], sourceRevision = 'unknown', mode = process.env.REGRESSION_MODE) {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId), 'CONFIG');
  const safe = cases.map(item => {
    requireSafe(/^[A-Z]+-\d{2}$/.test(item.id), 'CONFIG');
    requireSafe(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].includes(item.outcome) &&
      testLayers.includes(item.layer) && Number.isFinite(item.durationMs) && item.durationMs >= 0, 'CONFIG');
    const environment = item.environment ?? environmentFor(item.layer);
    requireSafe(['fixture', 'live'].includes(environment) && (!['U', 'C', 'B', 'A', 'E'].includes(item.layer) ||
      environment === environmentFor(item.layer)), 'CONFIG');
    const reason = item.reason && Object.hasOwn(reasons, item.reason) ? item.reason : undefined;
    const stage = item.stage && stages.includes(item.stage) ? item.stage : undefined;
    const variant = item.variant && Object.hasOwn(reportVariants, item.variant) && reportVariants[item.variant] === item.id ? item.variant : undefined;
    return {id: item.id, outcome: item.outcome, layer: item.layer, environment, durationMs: Math.max(0, Math.round(item.durationMs)),
      ...(reason ? {reason} : {}), ...(stage ? {stage} : {}), ...(variant ? {variant} : {})};
  });
  const selectedSummary = summarize(required, safe);
  const coverage = phase0Coverage(safe);
  const smokeCoverage = phase1Coverage(safe);
  const controlCoverage = phase2Coverage(safe);
  const summary = {...selectedSummary, acceptable: selectedSummary.acceptable && (mode !== 'phase0' || coverage.complete) &&
    (mode !== 'phase1' || smokeCoverage.complete) && (mode !== 'phase2' || controlCoverage.complete)};
  const revision = /^[0-9a-f]{40,64}$/.test(sourceRevision) ? sourceRevision : 'unknown';
  const liveScope = liveReportScope(mode);
  const fullPhase0Accepted = mode === 'phase0' && summary.acceptable && coverage.complete;
  const fullPhase1Accepted = mode === 'phase1' && summary.acceptable && smokeCoverage.complete;
  const fullPhase2Accepted = mode === 'phase2' && summary.acceptable && controlCoverage.complete;
  await writePrivate(join(directory, 'summary.json'), {version: 2, runId, sourceRevision: revision,
    scope: safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning-layer tests; no appliance acceptance',
    fullPhase0Accepted,
    fullPhase1Accepted,
    fullPhase2Accepted,
    ...(mode === 'phase0' ? {phase0Coverage: coverage} : {}),
    ...(mode === 'phase1' ? {phase1Coverage: smokeCoverage} : {}),
    ...(mode === 'phase2' ? {phase2Coverage: controlCoverage} : {}),
    ...summary, cases: safe});
  const missing = summary.missing.map(id => ({id, outcome: 'Not run' as const, layer: 'A' as const, environment: 'live' as const, durationMs: 0}));
  const profileMissing = mode === 'phase0' ? [
    ...coverage.missingFixtures.map(id => ({id, outcome: 'Not run' as const, layer: 'U' as const, environment: 'fixture' as const, durationMs: 0})),
    ...coverage.missingVariants.map(variant => ({id: phase0Variants[variant as Phase0Variant], variant: variant as Phase0Variant,
      outcome: 'Not run' as const, layer: 'A' as const, environment: 'live' as const, durationMs: 0})),
  ] : mode === 'phase1' ? smokeCoverage.missingLayers.map(item => ({id: item.id, variant: item.variant,
    layer: item.layer, environment: item.environment, outcome: 'Not run' as const, durationMs: 0})) :
    mode === 'phase2' ? controlCoverage.missingLayers.map(item => ({id: item.id, variant: item.variant,
      layer: item.layer, environment: item.environment, outcome: 'Not run' as const, durationMs: 0})) : [];
  const entries = [...safe, ...missing, ...profileMissing];
  const suite = entries.map(item => {
    const failed = item.outcome !== 'Passed';
    const detail = 'reason' in item && item.reason ? reasons[item.reason] : item.outcome;
    return `<testcase classname="${item.environment}.${item.layer}" name="${xml(item.id + ('variant' in item && item.variant ? '/' + item.variant : ''))}" time="${(item.durationMs / 1000).toFixed(3)}">` +
      (failed ? `<failure type="${xml(item.outcome)}" message="${xml(detail)}"/>` : '') + '</testcase>';
  }).join('\n');
  await writePrivate(join(directory, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="magicstick-selected-regression" tests="${entries.length}" failures="${entries.filter(item => item.outcome !== 'Passed').length}">\n${suite}\n</testsuite>\n`);
  await writePrivate(join(directory, 'summary.txt'), `Magic Stick selected regression cases: ${summary.acceptable ? 'PASSED' : 'NOT ACCEPTED'}\n` +
    `Full Phase 0 P0 gate: ${mode === 'phase0' ? fullPhase0Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 1 P0 gate: ${mode === 'phase1' ? fullPhase1Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 2 P0 gate: ${mode === 'phase2' ? fullPhase2Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Scope: ${safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning layers only'}\n` +
    `Selected: ${summary.selected}; executed: ${summary.executed}; missing: ${summary.missing.length}\n` +
    safe.map(item => `${item.id}${item.variant ? ` / ${item.variant}` : ''} [${item.layer}; ${item.environment}]: ${item.outcome}${item.reason ? ` (${item.reason})` : ''}${item.stage ? ` [${item.stage}]` : ''}`).join('\n') + '\n');
  return {...summary, fullPhase0Accepted, fullPhase1Accepted, fullPhase2Accepted};
}

/** Defense in depth for explicitly reviewed text; reports use allowlisting instead. */
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => redact(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|cookie|password|secret|token|credential|storageState|license|invitation/i.test(key) ? '[REDACTED]' : redact(item, secrets)]));
  if (typeof value !== 'string') return value;
  let text = value;
  for (const secret of secrets.filter(item => item.length > 0)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[URL REDACTED]');
}
