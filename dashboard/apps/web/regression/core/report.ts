import type {ReasonCode, Stage} from './errors.ts';
import {reasons, requireSafe, stages} from './errors.ts';
import {phase0Coverage, phase0Variants, type Phase0Variant} from '../profiles/phase0-p0.ts';
import {phase1Coverage, phase1Variants, phase1Requirements, type Phase1Variant} from '../profiles/phase1-p0.ts';
import {phase2Coverage, phase2Variants, phase2Requirements, type Phase2Variant} from '../profiles/phase2-p0.ts';
import {gpuCoverage,gpuRequirements,phase3Variants,phase4Variants,type GpuVariant} from '../profiles/gpu-p0.ts';
import {remainingCoverage,remainingRequirements,remainingPhase,remainingVariants} from '../profiles/remaining-p0.ts';
import {writePrivate} from './private-files.ts';
import {join} from 'node:path';
import {environmentFor, testLayers, type TestEnvironment, type TestLayer} from './evidence.ts';
import {caseDescription, durationDescription, layerDescriptions} from './case-descriptions.ts';

export type Outcome = 'Passed' | 'Failed' | 'Blocked' | 'Skipped' | 'Not run' | 'Flaky';
export interface CaseResult {id: string; outcome: Outcome; layer: TestLayer; environment?: TestEnvironment; durationMs: number; reason?: ReasonCode;
  stage?: Stage; variant?: Phase0Variant | Phase1Variant | Phase2Variant | GpuVariant | `p${5|6|7|8}-${string}`}

export const reportVariants: Record<string, string> = {...phase0Variants, ...phase1Variants,
  ...Object.fromEntries(Object.entries({...phase2Variants,...phase3Variants,...phase4Variants,...remainingVariants}).map(([variant, definition]) => [variant, definition.id]))};

export function terminalOutcome(value: Outcome): 'Passed'|'Failed'|'Blocked' {
  return value === 'Passed' ? 'Passed' : value === 'Failed' || value === 'Flaky' ? 'Failed' : 'Blocked';
}
/** Fill the finite matrix, not just one row per catalogue family. A missing
 * prerequisite or interrupted serial group must remain visible in JSON/JUnit. */
export function completeCases(mode:string|undefined,cases:CaseResult[],required:string[],reason:ReasonCode='PREREQUISITE'):CaseResult[] {
  const result=cases.map(item=>({...item,outcome:terminalOutcome(item.outcome)}));
  const matrix=mode === 'phase1' ? phase1Requirements : mode === 'phase2' ? phase2Requirements :
    mode === 'phase3' || mode === 'phase4' ? gpuRequirements(Number(mode[5]) as 3|4) :
    mode && remainingPhase(mode) ? remainingRequirements(mode) ?? [] : [];
  for(const item of matrix)if(!result.some(proof=>proof.id === item.id && proof.variant === item.variant &&
    proof.layer === item.layer && (proof.environment ?? environmentFor(proof.layer)) === item.environment))
    result.push({id:item.id,variant:item.variant as CaseResult['variant'],layer:item.layer,environment:item.environment,
      outcome:'Blocked',durationMs:0,reason});
  if(mode === 'phase0') {
    for(const id of phase0IdsForReport)if(!result.some(item=>item.id === id && (item.environment ?? environmentFor(item.layer)) === 'fixture'))
      result.push({id,layer:'U',environment:'fixture',outcome:'Blocked',durationMs:0,reason});
    for(const [variant,id] of Object.entries(phase0Variants))if(!result.some(item=>item.id === id && item.variant === variant &&
      (item.environment ?? environmentFor(item.layer)) === 'live'))result.push({id,variant:variant as Phase0Variant,
        layer:'A',environment:'live',outcome:'Blocked',durationMs:0,reason});
  }
  for(const id of required)if(!result.some(item=>item.id === id))result.push({id,layer:'A',environment:'live',outcome:'Blocked',durationMs:0,reason});
  return result;
}
const phase0IdsForReport=Array.from({length:11},(_,index)=>`HAR-${String(index+1).padStart(2,'0')}`);
export function reportExitCode(cases:Array<{outcome:Outcome}>) {
  return cases.some(item=>terminalOutcome(item.outcome) === 'Failed') ? 1 :
    !cases.length || cases.some(item=>terminalOutcome(item.outcome) === 'Blocked') ? 2 : 0;
}
export function blockedAction(reason:ReasonCode='PREREQUISITE') {
  if(reason === 'CANCELLED')return 'Repeat all when ready. Interrupted live mutations must prove restoration before further writes.';
  if(reason === 'LAB' || reason === 'IDENTITY')return 'Use the registered test appliance; setup is needed only when intentionally replacing that installation.';
  if(reason === 'TLS')return 'Restore connectivity or the trusted appliance certificate; the runner never disables TLS validation.';
  if(reason === 'RECOVERY' || reason === 'LOCK_LOST' || reason === 'LOCK_STALE')return 'Restore the recorded test baseline. Do not delete a live operation or take over its Lease.';
  if(reason === 'LOCK_BUSY' || reason === 'BUSY')return 'Wait for the other run or host operation to finish; then repeat all.';
  if(reason === 'CAPABILITY')return 'Supply the missing real hardware/runtime; available providers are tested independently.';
  return 'See the automatic preparation report for the missing external prerequisite; no approval form or manual test JSON is required.';
}

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
  const phase=remainingPhase(mode);
  if(phase) return `Phase ${phase} P0 catalogue/layer matrix on the registered disposable lab; fixed lab policy permits owned resources and bounded host operations; missing real prerequisites are Blocked, not passes`;
  if(mode === 'all')return 'All implemented Phase 0–8 P0 scenarios on the registered disposable lab; independent tests continue, missing prerequisites are Blocked and unproved recovery fences later live writes';
  if(mode === 'phase4-sharing' && process.env.REGRESSION_GPU_CASE === 'remaining')
    return 'Phase 4 diagnostic subset: verification consumer, provider/CPU independence, last-slot races, reload and exact restoration; not complete installed Phase 4 acceptance';
  if(mode === 'gpu-recover') return 'explicit recovery of one reviewed GPU journal; same node/boot/source/image pins; no Lease takeover, resource adoption or new inference workloads';
  if (mode?.startsWith('phase3')) return 'Phase 3 P0 installed AMD/NVIDIA exclusive runtimes, FreeToken whole-device runtime, physical inventory, memory, logs and scoped validation; borrowed sharing restored; Intel and reboot acceptance separate';
  if (mode?.startsWith('phase4')) return 'Phase 4 P0 installed AMD DRA/NVIDIA time-slicing transitions, mixed/same-engine pairs, full/released slots, races and cross-provider independence; borrowed sharing restored; reboot/CDI recovery acceptance separate';
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
  const safe = completeCases(mode,cases,required).map(item => {
    requireSafe(/^[A-Z][A-Z0-9]+-\d{2}$/.test(item.id), 'CONFIG');
    requireSafe(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].includes(item.outcome) &&
      testLayers.includes(item.layer) && Number.isFinite(item.durationMs) && item.durationMs >= 0, 'CONFIG');
    const environment = item.environment ?? environmentFor(item.layer);
    requireSafe(['fixture', 'live'].includes(environment) && (!['U', 'C', 'B', 'A', 'E'].includes(item.layer) ||
      environment === environmentFor(item.layer)), 'CONFIG');
    const reason = item.reason && Object.hasOwn(reasons, item.reason) ? item.reason : undefined;
    const stage = item.stage && stages.includes(item.stage) ? item.stage : undefined;
    const variant = item.variant && Object.hasOwn(reportVariants, item.variant) && reportVariants[item.variant] === item.id ? item.variant : undefined;
    return {id: item.id, description: caseDescription(item.id), outcome: item.outcome, layer: item.layer, environment, durationMs: Math.max(0, Math.round(item.durationMs)),
      ...(reason ? {reason} : {}), ...(stage ? {stage} : {}), ...(variant ? {variant} : {})};
  });
  const selectedSummary = summarize(required, safe);
  const coverage = phase0Coverage(safe);
  const smokeCoverage = phase1Coverage(safe);
  const controlCoverage = phase2Coverage(safe);
  const phase3Coverage = gpuCoverage(3,safe), phase4Coverage = gpuCoverage(4,safe);
  const laterPhase=remainingPhase(mode);
  const laterCoverage=laterPhase ? remainingCoverage(mode!,safe) : undefined;
  const summary = {...selectedSummary, acceptable: selectedSummary.acceptable && (mode !== 'phase0' || coverage.complete) &&
    (mode !== 'phase1' || smokeCoverage.complete) && (mode !== 'phase2' || controlCoverage.complete) &&
    (mode !== 'phase3' || phase3Coverage.complete) && (mode !== 'phase4' || phase4Coverage.complete) &&
    (!laterCoverage || laterCoverage.complete)};
  const revision = /^[0-9a-f]{40,64}$/.test(sourceRevision) ? sourceRevision : 'unknown';
  const liveScope = liveReportScope(mode);
  const fullPhase0Accepted = mode === 'phase0' && summary.acceptable && coverage.complete;
  const fullPhase1Accepted = mode === 'phase1' && summary.acceptable && smokeCoverage.complete;
  const fullPhase2Accepted = mode === 'phase2' && summary.acceptable && controlCoverage.complete;
  const fullPhase3Accepted = mode === 'phase3' && summary.acceptable && phase3Coverage.complete;
  const installedPhase4Accepted = mode === 'phase4' && summary.acceptable && phase4Coverage.complete;
  // The installed profile never performs a host reboot. Keep historic CDI
  // maintenance gates visible rather than silently calling all Phase 4 P0 done.
  const fullPhase4Accepted = false;
  const openGates = laterCoverage ? [...new Set(laterCoverage.missingLayers.map(item=>`${item.id}/${item.layer}: ${item.gate ?? item.group} evidence required`))] : mode?.startsWith('phase4') ? ['BOOT-04: separately authorized live driver restart/CDI recovery'] :
    mode?.startsWith('phase3') ? ['Intel: unavailable lab hardware'] : [];
  await writePrivate(join(directory, 'summary.json'), {version: 2, runId, sourceRevision: revision,
    scope: safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning-layer tests; no appliance acceptance',
    fullPhase0Accepted,
    fullPhase1Accepted,
    fullPhase2Accepted,
    fullPhase3Accepted,fullPhase4Accepted,installedPhase4Accepted,openGates,
    ...Object.fromEntries([5,6,7,8].map(phase=>[`fullPhase${phase}Accepted`,mode === `phase${phase}` && summary.acceptable && laterCoverage?.complete === true])),
    ...(laterCoverage ? {[`phase${laterPhase}Coverage`]:laterCoverage} : {}),
    ...(mode === 'phase0' ? {phase0Coverage: coverage} : {}),
    ...(mode === 'phase1' ? {phase1Coverage: smokeCoverage} : {}),
    ...(mode === 'phase2' ? {phase2Coverage: controlCoverage} : {}),
    ...(mode === 'phase3' ? {phase3Coverage} : {}), ...(mode === 'phase4' ? {phase4Coverage} : {}),
    ...summary, cases: safe});
  const entries = safe;
  const suite = entries.map(item => {
    const failed = item.outcome === 'Failed',blocked=item.outcome === 'Blocked';
    const detail = 'reason' in item && item.reason ? reasons[item.reason] : item.outcome;
    return `<testcase classname="${item.environment}.${item.layer}" name="${xml(item.id + ('variant' in item && item.variant ? '/' + item.variant : ''))}" time="${(item.durationMs / 1000).toFixed(3)}">` +
      `<properties><property name="catalogueGoal" value="${xml(caseDescription(item.id))}"/></properties>` +
      (failed ? `<failure type="Failed" message="${xml(detail)}"/>` : blocked ? `<skipped type="Blocked" message="${xml(detail)}"/>` : '') + '</testcase>';
  }).join('\n');
  await writePrivate(join(directory, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="magicstick-selected-regression" tests="${entries.length}" failures="${entries.filter(item => item.outcome === 'Failed').length}" skipped="${entries.filter(item=>item.outcome === 'Blocked').length}">\n${suite}\n</testsuite>\n`);
  await writePrivate(join(directory,'summary.html'),'<!doctype html><html lang="en"><meta charset="utf-8">'+
    '<title>Magic Stick regression results</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}'+
    'table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}'+
    '.Passed{color:#087343}.Failed{color:#b42030}.Blocked{color:#906100}</style><h1>Regression results</h1>'+
    `<p>Passed: ${summary.counts.Passed} · Failed: ${summary.counts.Failed} · Blocked: ${summary.counts.Blocked}</p>`+
    '<table><tr><th>Case / variant</th><th>Layer</th><th>Result</th><th>Goal / reason</th></tr>'+
    safe.map(item=>`<tr><td>${xml(item.id+(item.variant ? '/'+item.variant : ''))}</td><td>${item.layer} / ${item.environment}</td>`+
      `<td class="${item.outcome}">${item.outcome}</td><td>${xml(item.description)}`+
      (item.reason ? `<br>${xml(reasons[item.reason])}` : '')+(item.outcome === 'Blocked' ? `<br>Next: ${xml(blockedAction(item.reason))}` : '')+'</td></tr>').join('')+'</table></html>');
  await writePrivate(join(directory, 'summary.txt'), `Magic Stick selected regression cases: ${summary.acceptable ? 'PASSED' : 'NOT ACCEPTED'}\n` +
    `Full Phase 0 P0 gate: ${mode === 'phase0' ? fullPhase0Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 1 P0 gate: ${mode === 'phase1' ? fullPhase1Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 2 P0 gate: ${mode === 'phase2' ? fullPhase2Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Installed Phase 3 P0 gate: ${mode === 'phase3' ? fullPhase3Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Installed Phase 4 P0 gate: ${mode === 'phase4' ? installedPhase4Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    [5,6,7,8].map(phase=>`Full Phase ${phase} P0 gate: ${mode === `phase${phase}` ? summary.acceptable ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n`).join('') +
    (openGates.length ? `Separate open gates: ${openGates.join('; ')}\n` : '') +
    `Scope: ${safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning layers only'}\n` +
    'Catalogue goals describe case families; Passed applies only to the recorded variant, layer and environment.\n' +
    `Passed: ${summary.counts.Passed}; Failed: ${summary.counts.Failed}; Blocked: ${summary.counts.Blocked}\n` +
    safe.map(item => `${item.id}${item.variant ? ` / ${item.variant}` : ''} [${item.layer} — ${layerDescriptions[item.layer]}; ${item.environment}]: ${item.outcome} — ${durationDescription(item.durationMs)}${item.reason ? ` (${item.reason})` : ''}${item.stage ? ` [${item.stage}]` : ''}\n` +
      `  Catalogue goal: ${item.description}${item.reason ? `\n  Reason: ${reasons[item.reason]}` : ''}${item.outcome === 'Blocked' ? `\n  Next: ${blockedAction(item.reason)}` : ''}`).join('\n') + '\n');
  return {...summary, fullPhase0Accepted, fullPhase1Accepted, fullPhase2Accepted,fullPhase3Accepted,fullPhase4Accepted,installedPhase4Accepted,
    ...Object.fromEntries([5,6,7,8].map(phase=>[`fullPhase${phase}Accepted`,mode === `phase${phase}` && summary.acceptable && laterCoverage?.complete === true]))};
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
