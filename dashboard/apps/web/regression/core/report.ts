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
import {disabledExperimentalEngines} from './engine-policy.ts';
import {preparationDiagnostic, preparationDescription, parsePreparationDiagnostic, type PreparationDiagnostic} from './preparation-diagnostic.ts';
import {collectReportArtifacts,archiveReport} from './report-artifacts.ts';
import {junitReport} from './junit.ts';
import {blockerDescription} from './blocker-description.ts';
import type {RegressionBlocker, RegressionBlockedKind} from '@magicstick/dashboard-contracts';
import {regressionBlockedKind,regressionBlockedLabel, regressionBlockedSummary} from '../../../../packages/core/src/regression-blocking.ts';
import {blockedCounts,blockerFrom,checkedBlocker,withBlockedCauses,recoveryCause} from './blocking.ts';
import {testMode,excludedSteps,isolatedStep} from './test-mode.ts';
import {nonDestructiveVariants} from './non-destructive.ts';

export type Outcome = 'Passed' | 'Failed' | 'Blocked' | 'Skipped' | 'Not run' | 'Flaky';
export interface CaseResult {id: string; outcome: Outcome; layer: TestLayer; environment?: TestEnvironment; durationMs: number; reason?: ReasonCode;
  executionId?:string; executionOutcome?:'Passed'|'Failed'|'Blocked';
  traceRunId?:string;recoveryRequired?:true;
  blockedBy?:RegressionBlocker;
  stage?: Stage; variant?: Phase0Variant | Phase1Variant | Phase2Variant | GpuVariant | `p${5|6|7|8}-${string}` | `p${0|1|2|3|4}-non-destructive-${'tls'|'read'}`}
export interface RecoveryAttempt {runId:string;state:'restored'|'blocked';reason?:ReasonCode}
export function needsRecovery(cases:CaseResult[]) {
  return cases.some(item=>item.recoveryRequired===true||item.reason&&
    ['CLEANUP','OWNERSHIP','CONFLICT','LOCK_LOST','LOCK_STALE','RECOVERY'].includes(item.reason));
}

export const reportVariants: Record<string, string> = {...phase0Variants, ...phase1Variants,...nonDestructiveVariants,
  ...Object.fromEntries(Object.entries({...phase2Variants,...phase3Variants,...phase4Variants,...remainingVariants}).map(([variant, definition]) => [variant, definition.id]))};

export function terminalOutcome(value: Outcome): 'Passed'|'Failed'|'Blocked' {
  return value === 'Passed' ? 'Passed' : value === 'Failed' || value === 'Flaky' ? 'Failed' : 'Blocked';
}
export function summarizeExecutions(cases:Array<{executionId?:string;executionOutcome?:'Passed'|'Failed'|'Blocked';outcome:Outcome}>) {
  const executions=new Map<string,'Passed'|'Failed'|'Blocked'>();
  for(const item of cases)if(item.executionId && /^[a-f0-9]{24}$/.test(item.executionId)) {
    // The scenario can fail during cleanup after every mapped check passed.
    // Preserve completed checks, but never infer a green execution from them.
    const prior=executions.get(item.executionId),current=item.executionOutcome ?? terminalOutcome(item.outcome);
    executions.set(item.executionId,prior === 'Failed' || current === 'Failed' ? 'Failed' :
      prior === 'Blocked' || current === 'Blocked' ? 'Blocked' : 'Passed');
  }
  const counts={Passed:0,Failed:0,Blocked:0};
  for(const outcome of executions.values())counts[outcome]++;
  return counts;
}
/** Fill the finite matrix, not just one row per catalogue family. A missing
 * prerequisite or interrupted serial group must remain visible in JSON/JUnit. */
export function completeCases(mode:string|undefined,cases:CaseResult[],required:string[],reason:ReasonCode='PREREQUISITE',
  recoveryFenceAtStart=false):CaseResult[] {
  const result=cases.map(item=>({...item,outcome:terminalOutcome(item.outcome)}));
  const missingCause=(id:string,variant?:string):RegressionBlocker=>{
    const peers=cases.filter(item=>variant?item.variant===variant:item.id===id);
    const root=peers.find(item=>['Failed','Flaky'].includes(item.outcome)) ?? peers.find(item=>item.outcome==='Blocked');
    return reason==='PREREQUISITE' ? root ? checkedBlocker(root.blockedBy) ?? blockerFrom(root) : {kind:'unknown'} : {kind:regressionBlockedKind(reason),reason};
  };
  const missingEnvironments=new Set<TestEnvironment>();
  const absent=(id:string,variant:string|undefined,environment:TestEnvironment)=>{
    const cause=missingCause(id,variant);
    // This phase entered with a recorded recovery fence, so its live steps
    // were refused before mutation. Do not infer this from a fence introduced
    // later in the phase, or attribute absent fixture layers to that fence.
    const guard=cases.find(item=>item.outcome==='Blocked' && item.reason==='RECOVERY');
    if(environment==='live' && recoveryFenceAtStart && reason==='PREREQUISITE' && cause.kind==='unknown' && guard) {
      return {reason:'RECOVERY' as const,blockedBy:checkedBlocker(guard.blockedBy)??blockerFrom(guard)};
    }
    if(reason==='PREREQUISITE'&&cause.kind==='unknown') {
      missingEnvironments.add(environment);
      return {reason:'DEPENDENCY' as const,blockedBy:{kind:'failure' as const,caseId:'HAR-10',reason:'MISSING_EVIDENCE',stage:'report-evidence'}};
    }
    return {reason,blockedBy:cause};
  };
  const limited=testMode(process.env.REGRESSION_TEST_MODE??'full')==='non-destructive';
  const matrix=limited?[]:mode === 'phase1' ? phase1Requirements : mode === 'phase2' ? phase2Requirements :
    mode === 'phase3' || mode === 'phase4' ? gpuRequirements(Number(mode[5]) as 3|4) :
    mode && remainingPhase(mode) ? remainingRequirements(mode) ?? [] : [];
  for(const item of matrix)if(!result.some(proof=>proof.id === item.id && proof.variant === item.variant &&
    proof.layer === item.layer && (proof.environment ?? environmentFor(proof.layer)) === item.environment))
    result.push({id:item.id,variant:item.variant as CaseResult['variant'],layer:item.layer,environment:item.environment,
      outcome:'Blocked',durationMs:0,...absent(item.id,item.variant,item.environment)});
  if(mode === 'phase0'&&!limited) {
    for(const id of phase0IdsForReport)if(!result.some(item=>item.id === id && (item.environment ?? environmentFor(item.layer)) === 'fixture'))
      result.push({id,layer:'U',environment:'fixture',outcome:'Blocked',durationMs:0,...absent(id,undefined,'fixture')});
    for(const [variant,id] of Object.entries(phase0Variants))if(!result.some(item=>item.id === id && item.variant === variant &&
      (item.environment ?? environmentFor(item.layer)) === 'live'))result.push({id,variant:variant as Phase0Variant,
        layer:'A',environment:'live',outcome:'Blocked',durationMs:0,...absent(id,variant,'live')});
  }
  for(const id of required)if(!result.some(item=>item.id === id))result.push({id,layer:'A',environment:'live',outcome:'Blocked',durationMs:0,...absent(id,undefined,'live')});
  for(const environment of missingEnvironments)if(!result.some(item=>item.reason==='MISSING_EVIDENCE'&&item.environment===environment))
    result.push({id:'HAR-10',layer:environment==='live'?'A':'U',environment,outcome:'Failed',durationMs:0,
      reason:'MISSING_EVIDENCE',stage:'report-evidence'});
  return result;
}
const phase0IdsForReport=Array.from({length:11},(_,index)=>`HAR-${String(index+1).padStart(2,'0')}`);

/** The launcher calls this only when its explicit inherited recovery fence
 * refuses a live child before execution. Preserve those selected tuples at
 * their source, rather than guessing a cause for missing results afterwards. */
export function guardedLiveCases(mode:string,required:string[],cause?:RegressionBlocker):CaseResult[] {
  requireSafe(!['all','selftest'].includes(mode) && !/(?:-fast|-fixtures)$/.test(mode) && !/^phase[0-8]$/.test(mode),'CONFIG');
  const inherited=checkedBlocker(cause);
  const blockedBy=inherited?.kind==='failure'?inherited:{kind:'failure' as const,reason:'RECOVERY'};
  const matrix=(remainingRequirements(mode)??[]).filter(item=>item.environment==='live'&&required.includes(item.id));
  const rows:CaseResult[]=matrix.map(item=>({id:item.id,variant:item.variant as CaseResult['variant'],layer:item.layer,
    environment:'live',outcome:'Blocked',durationMs:0,reason:'RECOVERY',stage:'recovery-barrier',blockedBy}));
  for(const id of required)if(!rows.some(item=>item.id===id))
    rows.push({id,layer:'A',environment:'live',outcome:'Blocked',durationMs:0,reason:'RECOVERY',stage:'recovery-barrier',blockedBy});
  return rows;
}

export function reportExitCode(cases:Array<{outcome:Outcome}>) {
  return cases.some(item=>terminalOutcome(item.outcome) === 'Failed') ? 1 :
    !cases.length || cases.some(item=>terminalOutcome(item.outcome) === 'Blocked') ? 2 : 0;
}
export function blockedAction(reason:ReasonCode='PREREQUISITE',kind?:RegressionBlockedKind) {
  if(reason==='MISSING_EVIDENCE')return 'Repair the runner selection/evidence mapping or interrupted child report. Do not configure a prerequisite or reuse an older result to fill this gap.';
  if(kind==='unknown'&&reason==='PREREQUISITE')return 'Inspect the missing evidence and preceding runner steps; no causal prerequisite or failure was recorded.';
  if(reason === 'UNEXPECTED')return 'Inspect the filtered scenario/step trace and runner status, correct the failing assertion or harness error, then repeat the suite.';
  if(reason === 'COMPONENT')return 'Inspect the archived owning component diagnostic and its source test, then repeat the isolated component check.';
  if(reason === 'CONFIG' || reason === 'PRIVATE_FILE')return 'Repeat automatic setup with the same retained storage; verify runner version, file permissions and available storage. Do not manually delete recovery receipts.';
  if(reason === 'REVISION')return 'Verify the selected source revision, image promotion and healthy Flux/Deployment convergence, then repeat automatic preparation. Do not accept stale images or bypass revision checks.';
  if(reason === 'OBSERVER')return 'Restore the generated read-only Kubernetes observer and its scoped permissions through automatic setup; never substitute an administrator kubeconfig.';
  if(reason === 'API' || reason === 'AUTH')return 'Restore the required authenticated Dashboard/API contract or test identity. Inspect the failed stage; do not bypass authorization.';
  if(reason === 'DEADLINE')return 'Inspect the stalled stage and model/service status, correct the failure, then repeat; an older Ready state is not sufficient.';
  if(['OWNERSHIP','CLEANUP','CONFLICT'].includes(reason))return 'Keep the private journal and inspect the exact resource UID/revision and restoration result. Never delete a foreign or replaced resource to clear the test.';
  if(reason === 'EXTERNAL_RUNNER')return 'Run the same suite from the external Docker runner to independently observe host restart, disconnection and recovery. No in-Appliance override can certify this test.';
  if(reason === 'PREPARATION_FAILED')return 'Fix the original HAR-02 automatic preparation failure, then repeat the suite; this check did not execute.';
  if(reason === 'DEPENDENCY')return kind==='prerequisite' ? 'Provide the missing prerequisite from the earlier blocked step, then repeat the scenario.' :
    kind==='cancelled' ? 'Repeat the cancelled scenario when ready, after verified restoration.' :
    kind==='failure' ? 'Fix the earlier failed step in this scenario, then repeat it. This check needs no additional setup.' :
    'Inspect the earlier blocked step or scenario trace, resolve its recorded cause, then repeat the scenario.';
  if(reason === 'CANCELLED')return 'Repeat all when ready. Interrupted live mutations must prove restoration before further writes.';
  if(reason === 'LAB' || reason === 'IDENTITY')return 'Use the registered test appliance; setup is needed only when intentionally replacing that installation.';
  if(reason === 'TLS')return 'Restore connectivity or the trusted appliance certificate; the runner never disables TLS validation.';
  if(reason === 'RECOVERY' || reason === 'LOCK_LOST' || reason === 'LOCK_STALE')return 'Repeat all with the same persistent private run directory. Automatic recovery inspects the exact previous run; missing journals or changed resources still require review. Do not delete the Lease.';
  if(reason === 'LOCK_BUSY' || reason === 'BUSY')return 'Wait for the other run or host operation to finish; then repeat all.';
  if(reason === 'CAPABILITY')return 'Supply the missing real hardware/runtime; available providers are tested independently.';
  if(reason === 'GPU_PROVIDER')return 'Use an appliance with physical GPUs from this provider. No provider setting or approval can substitute absent hardware; independent provider cases continue.';
  if(reason === 'APPLICATION_MODEL')return 'Check the deployed small CPU Ollama model catalog, native context metadata and available system RAM. The runner automatically sizes a separate application fixture; do not raise the ordinary smoke-model context or bypass memory admission.';
  if(reason === 'GPU_VALIDATION')return 'Open System → Hardware and verify this exact physical GPU and engine for the current boot. Inspect a failed verification; do not reuse another device or engine result.';
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
  const selected=/^phase[5-8]-live$/.test(mode??'')?process.env.REGRESSION_REMAINING_CASE:undefined;
  if(selected&&remainingRequirements(mode!)?.some(item=>item.id===selected))
    return `Phase ${phase} diagnostic subset: ${selected} only on the registered disposable lab; normal lock, identity and cleanup rules; not full-phase acceptance`;
  if(phase) return `Phase ${phase} P0 catalogue/layer matrix on the registered disposable lab; fixed lab policy permits owned resources and bounded host operations; missing real prerequisites are Blocked, not passes`;
  if(mode === 'all')return 'All implemented Phase 0–8 P0 scenarios on the registered disposable lab; independent tests continue, missing prerequisites are Blocked and unproved recovery fences later live writes';
  if(mode === 'campaign-recover')return 'Automatic restoration of the exact finished campaign child after real lease expiry and drain; owned UID receipts only; no new workloads or rewritten test outcomes';
  if(mode === 'phase3-gpu' && process.env.REGRESSION_GPU_CASE === 'vllm-lifecycle')
    return 'Phase 3 diagnostic subset: AMD/NVIDIA vLLM inference, logs, browser Stop/Start and exact restoration; not complete installed Phase 3 acceptance';
  if(mode === 'phase3-gpu' && process.env.REGRESSION_GPU_CASE === 'nvidia-lifecycle')
    return 'Phase 3 diagnostic subset: three independent NVIDIA Ollama and vLLM inference/logs/Stop/Start cycles each; AMD sharing unchanged; not complete installed Phase 3 acceptance';
  if(mode === 'phase4-sharing' && process.env.REGRESSION_GPU_CASE === 'remaining')
    return 'Phase 4 diagnostic subset: verification consumer, provider/CPU independence, last-slot races, reload and exact restoration; not complete installed Phase 4 acceptance';
  if(mode === 'gpu-recover') return 'explicit recovery of one reviewed GPU journal; same node/boot/source/image pins; no Lease takeover, resource adoption or new inference workloads';
  if (mode?.startsWith('phase3')) return 'Phase 3 P0 installed AMD/NVIDIA Ollama/vLLM exclusive runtimes, physical inventory, memory, logs and scoped validation; borrowed sharing restored; Intel and reboot acceptance separate';
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
export async function saveReport(directory: string, runId: string, cases: CaseResult[], required: string[], sourceRevision = 'unknown', mode = process.env.REGRESSION_MODE,
  preparation?: PreparationDiagnostic,lifecycle?:{recoveryFenceActive:boolean;recoveryAttempts:RecoveryAttempt[];recoveryFenceAtStart?:boolean}) {
  requireSafe(/^reg-[0-9a-f-]{36}$/.test(runId), 'CONFIG');
  const runTestMode=testMode(process.env.REGRESSION_TEST_MODE??'full'),limited=runTestMode==='non-destructive';
  const selectionPhases=/^phase[0-8]$/.test(mode??'')?[Number(mode!.slice(-1))]:mode==='all'?
    (process.env.REGRESSION_PHASES??'0,1,2,3,4,5,6,7,8').split(',').map(Number):[];
  const omittedSteps=excludedSteps(runTestMode,selectionPhases);
  const selectionText=limited?'Non-destructive tests only: existing workloads/settings/caches are unchanged; destructive and preparation-dependent live steps are excluded, not passed. Full-phase acceptance is not assessed.':isolatedStep(mode??'')?'Isolated tests only; no appliance changes or installed acceptance.':'Full tests, including destructive scenarios.';
  const portableArchive=mode==='all'||mode==='selftest'||mode==='recover'||/^phase[0-8](?:-(?:fast|fixtures))?$/.test(mode??'');
  const prepared = preparation ? parsePreparationDiagnostic(preparation) : await preparationDiagnostic();
  const safe = withBlockedCauses(completeCases(mode,cases,required,'PREREQUISITE',lifecycle?.recoveryFenceAtStart===true).map(item => {
    requireSafe(/^[A-Z][A-Z0-9]+-\d{2}$/.test(item.id), 'CONFIG');
    requireSafe(['Passed', 'Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'].includes(item.outcome) &&
      testLayers.includes(item.layer) && Number.isFinite(item.durationMs) && item.durationMs >= 0, 'CONFIG');
    const environment = item.environment ?? environmentFor(item.layer);
    requireSafe(['fixture', 'live'].includes(environment) && (!['U', 'C', 'B', 'A', 'E'].includes(item.layer) ||
      environment === environmentFor(item.layer)), 'CONFIG');
    const reason = item.reason && Object.hasOwn(reasons, item.reason) ? item.reason : item.outcome === 'Blocked' ? 'PREREQUISITE' as const : undefined;
    const stage = item.stage && stages.includes(item.stage) ? item.stage : undefined;
    const variant = item.variant && Object.hasOwn(reportVariants, item.variant) && reportVariants[item.variant] === item.id ? item.variant : undefined;
    const executionId=item.executionId && /^[a-f0-9]{24}$/.test(item.executionId) ? item.executionId : undefined;
    const executionOutcome=executionId && ['Passed','Failed','Blocked'].includes(item.executionOutcome ?? '') ? item.executionOutcome : undefined;
    return {id: item.id, description: caseDescription(item.id), outcome: item.outcome, layer: item.layer, environment, durationMs: Math.max(0, Math.round(item.durationMs)),
      ...(reason ? {reason} : {}), ...(stage ? {stage} : {}), ...(variant ? {variant} : {}),...(executionId ? {executionId} : {}),
      ...(executionOutcome ? {executionOutcome} : {}),
      ...(item.outcome==='Blocked' && environment==='live' && prepared?.outcome==='Failed' && ['PREPARATION_FAILED','PREREQUISITE'].includes(reason ?? '') ?
        {blockedBy:checkedBlocker({kind:'failure',caseId:'HAR-02',reason:prepared.reason ?? 'PREPARATION_FAILED'})} :
        item.outcome==='Blocked' && environment==='live' && prepared?.outcome==='Blocked' && reason==='PREREQUISITE' ?
        {blockedBy:checkedBlocker({kind:regressionBlockedKind(prepared.reason ?? 'PREREQUISITE'),reason:prepared.reason ?? 'PREREQUISITE'})} :
        item.outcome==='Blocked'&&reason==='RECOVERY'&&recoveryCause(process.env.REGRESSION_RECOVERY_CAUSE)?
          {blockedBy:recoveryCause(process.env.REGRESSION_RECOVERY_CAUSE)}:
        item.outcome==='Blocked' && checkedBlocker(item.blockedBy) ? {blockedBy:checkedBlocker(item.blockedBy)} :
        item.outcome==='Blocked'&&reason==='PREREQUISITE'?{blockedBy:{kind:'prerequisite' as const,reason}}:{}),
      ...(executionId&&item.traceRunId&&/^reg-[0-9a-f-]{36}$/.test(item.traceRunId)?{traceRunId:item.traceRunId}:{}),
      ...(item.recoveryRequired===true?{recoveryRequired:true as const}:{})};
  }));
  const artifacts=await collectReportArtifacts(directory,runId,safe);
  const recoveryFenceActive=lifecycle?.recoveryFenceActive??needsRecovery(safe);
  const recoveryAttempts=(lifecycle?.recoveryAttempts??[]).map(item=>{
    requireSafe(/^reg-[0-9a-f-]{36}$/.test(item.runId)&&['restored','blocked'].includes(item.state),'CONFIG');
    return {runId:item.runId,state:item.state,...(item.reason&&Object.hasOwn(reasons,item.reason)?{reason:item.reason}:{})};
  });
  const executionCounts=summarizeExecutions(safe);
  const evidenceBlockedCounts=blockedCounts(safe),executionBlockedCounts=blockedCounts(safe,true);
  const selectedSummary = summarize(required, safe);
  const coverage = phase0Coverage(safe);
  const smokeCoverage = phase1Coverage(safe);
  const controlCoverage = phase2Coverage(safe);
  const phase3Coverage = gpuCoverage(3,safe), phase4Coverage = gpuCoverage(4,safe);
  const laterPhase=limited?undefined:remainingPhase(mode);
  const laterCoverage=laterPhase ? remainingCoverage(mode!,safe) : undefined;
  const summary = {...selectedSummary, acceptable: selectedSummary.acceptable && !recoveryFenceActive && executionCounts.Failed === 0 && executionCounts.Blocked === 0 &&
    (limited || mode !== 'phase0' || coverage.complete) &&
    (limited || mode !== 'phase1' || smokeCoverage.complete) && (limited || mode !== 'phase2' || controlCoverage.complete) &&
    (limited || mode !== 'phase3' || phase3Coverage.complete) && (limited || mode !== 'phase4' || phase4Coverage.complete) &&
    (!laterCoverage || laterCoverage.complete)};
  const revision = /^[0-9a-f]{40,64}$/.test(sourceRevision) ? sourceRevision : 'unknown';
  const liveScope = liveReportScope(mode);
  const fullPhase0Accepted = !limited && mode === 'phase0' && summary.acceptable && coverage.complete;
  const fullPhase1Accepted = !limited && mode === 'phase1' && summary.acceptable && smokeCoverage.complete;
  const fullPhase2Accepted = !limited && mode === 'phase2' && summary.acceptable && controlCoverage.complete;
  const fullPhase3Accepted = !limited && mode === 'phase3' && summary.acceptable && phase3Coverage.complete;
  const installedPhase4Accepted = !limited && mode === 'phase4' && summary.acceptable && phase4Coverage.complete;
  // The installed profile never performs a host reboot. Keep historic CDI
  // maintenance gates visible rather than silently calling all Phase 4 P0 done.
  const fullPhase4Accepted = false;
  const openGates = limited?[]:laterCoverage ? [...new Set(laterCoverage.missingLayers.map(item=>`${item.id}/${item.layer}: ${item.gate ?? item.group} evidence required`))] : mode?.startsWith('phase4') ? ['BOOT-04: separately authorized live driver restart/CDI recovery'] :
    mode?.startsWith('phase3') ? ['Intel: unavailable lab hardware'] : [];
  await writePrivate(join(directory, 'summary.json'), {version: 2, runId, sourceRevision: revision,testMode:runTestMode,excludedSteps:omittedSteps,
    ...(prepared ? {automaticPreparation: prepared} : {}),
    scope: limited?selectionText:safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning-layer tests; no appliance acceptance',
    fullPhase0Accepted,
    fullPhase1Accepted,
    fullPhase2Accepted,
    fullPhase3Accepted,fullPhase4Accepted,installedPhase4Accepted,openGates,
    ...Object.fromEntries([5,6,7,8].map(phase=>[`fullPhase${phase}Accepted`,!limited && mode === `phase${phase}` && summary.acceptable && laterCoverage?.complete === true])),
    ...(laterCoverage ? {[`phase${laterPhase}Coverage`]:laterCoverage} : {}),
    ...(mode === 'phase0' ? {phase0Coverage: coverage} : {}),
    ...(mode === 'phase1' ? {phase1Coverage: smokeCoverage} : {}),
    ...(mode === 'phase2' ? {phase2Coverage: controlCoverage} : {}),
    ...(mode === 'phase3' ? {phase3Coverage} : {}), ...(mode === 'phase4' ? {phase4Coverage} : {}),
    ...summary,executionCounts,blockedCounts:evidenceBlockedCounts,executionBlockedCounts,recoveryFenceActive,recoveryAttempts,excludedEngineTests:disabledExperimentalEngines, cases: safe});
  await writePrivate(join(directory, 'junit.xml'),junitReport(safe,artifacts,disabledExperimentalEngines,{testMode:runTestMode,excludedSteps:omittedSteps}));
  await writePrivate(join(directory,'summary.html'),'<!doctype html><html lang="en"><meta charset="utf-8">'+
    '<title>Magic Stick regression results</title><style>body{font:16px system-ui;max-width:1100px;margin:2rem auto;padding:1rem}'+
    'table{border-collapse:collapse;width:100%}td,th{padding:.6rem;border-bottom:1px solid #ddd;text-align:left}'+
    '.Passed{color:#087343}.Failed{color:#b42030}.Blocked{color:#906100}</style><h1>Regression results</h1>'+
    `<p>${xml(selectionText)}</p>`+(omittedSteps.length?`<details><summary>Not selected in this mode (${omittedSteps.length} steps)</summary><ul>${omittedSteps.map(step=>`<li>${xml(step)}</li>`).join('')}</ul></details>`:'')+
    (prepared ? `<p>${xml(preparationDescription(prepared))}${prepared.outcome==='Passed'?'':' '+xml(reasons[prepared.reason ?? 'PREREQUISITE'])}</p>` : '')+
    `<p>Excluded experimental engine tests: ${xml(disabledExperimentalEngines.join(', '))}. Product engines are unchanged.</p>`+
    `<p>Recorded executable scenarios: ${executionCounts.Passed} passed · ${executionCounts.Failed} failed · ${executionCounts.Blocked} blocked. ${safe.filter(item=>!item.executionId).length} evidence rows have no executable scenario ID (missing or legacy evidence).</p>`+
    `<p>Blocked executable scenarios: ${regressionBlockedSummary(executionBlockedCounts)}.</p>`+
    `<p>Evidence rows (case × variant × layer): ${summary.counts.Passed} passed · ${summary.counts.Failed} failed · ${summary.counts.Blocked} blocked.</p>`+
    `<p>Blocked evidence: ${regressionBlockedSummary(evidenceBlockedCounts)}.</p>`+
    `<p>Live restoration fence: ${recoveryFenceActive?'active':'clear'}. Historical failed outcomes are retained.</p>`+
    recoveryAttempts.map(item=>`<p>Automatic recovery ${item.runId}: ${item.state}${item.reason?` (${item.reason})`:''}.</p>`).join('')+
    '<table><tr><th>Case / variant</th><th>Layer</th><th>Result</th><th>Goal / reason</th></tr>'+
    safe.map(item=>`<tr><td>${xml(item.id+(item.variant ? '/'+item.variant : ''))}</td><td>${item.layer} / ${item.environment}</td>`+
      `<td class="${item.blockedBy?.kind==='failure'?'Failed':item.outcome}">${item.blockedBy ? regressionBlockedLabel(item.blockedBy.kind) : item.outcome}</td><td>${xml(item.description)}`+
      (item.reason ? `<br>${item.reason}: ${xml(blockerDescription(item.reason,item.id,item.variant,item.layer))}` : '')+
      (item.blockedBy?.caseId ? `<br>Blocking check: ${xml(item.blockedBy.caseId)}${item.blockedBy.reason ? ` (${xml(item.blockedBy.reason)})` : ''}${item.blockedBy.stage ? ` · Stage: ${xml(item.blockedBy.stage)}` : ''}` : '')+
      (item.outcome === 'Blocked' ? `<br>Next: ${xml(blockedAction(item.reason,item.blockedBy?.kind))}` : '')+'</td></tr>').join('')+'</table>'+
    '<h2>Execution steps and diagnostics</h2><p>Filtered call traces omit credentials, selectors, URLs and raw responses.</p>'+
    (portableArchive?'<p><a href="report-artifacts.tar.gz">Download sanitized report archive</a></p>':'')+
    artifacts.map(({trace,path,componentPath})=>`<details><summary>${xml(trace.scenario??trace.executionId)} — ${trace.outcome}</summary>`+
      `<p><a href="${path}">Filtered trace JSON</a>${componentPath?` · <a href="${componentPath}">Component diagnostic</a>`:''}</p><ol>`+
      trace.steps.map(step=>`<li class="${step.outcome}">${xml(step.title)} — ${step.outcome} · ${durationDescription(step.durationMs)}`+
        (step.reason?` · ${step.reason}`:'')+(step.stage?` · ${step.stage}`:'')+
        (step.source?` · ${xml(step.source.file)}:${step.source.line}`:'')+'</li>').join('')+'</ol>'+
      (trace.omittedSteps?`<p>Trace limit reached: ${trace.omittedSteps} additional steps omitted; scenario outcome is retained.</p>`:'')+'</details>').join('')+'</html>');
  await writePrivate(join(directory, 'summary.txt'), `Magic Stick selected regression cases: ${summary.acceptable ? 'PASSED' : 'NOT ACCEPTED'}\n` +
    selectionText+'\n'+(omittedSteps.length?'Not selected in this mode: '+omittedSteps.join(', ')+'\n':'')+
    (prepared ? preparationDescription(prepared)+'\n' : '')+
    `Full Phase 0 P0 gate: ${!limited && mode === 'phase0' ? fullPhase0Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 1 P0 gate: ${!limited && mode === 'phase1' ? fullPhase1Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Full Phase 2 P0 gate: ${!limited && mode === 'phase2' ? fullPhase2Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Installed Phase 3 P0 gate: ${!limited && mode === 'phase3' ? fullPhase3Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    `Installed Phase 4 P0 gate: ${!limited && mode === 'phase4' ? installedPhase4Accepted ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n` +
    [5,6,7,8].map(phase=>`Full Phase ${phase} P0 gate: ${!limited && mode === `phase${phase}` ? summary.acceptable ? 'PASSED' : 'NOT ACCEPTED' : 'NOT ASSESSED'}\n`).join('') +
    (openGates.length ? `Separate open gates: ${openGates.join('; ')}\n` : '') +
    `Scope: ${safe.some(item => item.environment === 'live') ? liveScope : 'isolated owning layers only'}\n` +
    'Catalogue goals describe case families; Passed applies only to the recorded variant, layer and environment.\n' +
    `Excluded experimental engine tests: ${disabledExperimentalEngines.join(', ')}. Product engines are unchanged.\n`+
    `Recorded executable scenarios: ${executionCounts.Passed} passed; ${executionCounts.Failed} failed; ${executionCounts.Blocked} blocked.\n`+
    `Blocked executable scenarios: ${regressionBlockedSummary(executionBlockedCounts)}\n`+
    `Evidence rows without executable scenario ID (missing or legacy evidence): ${safe.filter(item=>!item.executionId).length}\n`+
    `Passed: ${summary.counts.Passed}; Failed: ${summary.counts.Failed}; Blocked: ${summary.counts.Blocked}\n` +
    `Blocked evidence: ${regressionBlockedSummary(evidenceBlockedCounts)}\n`+
    `Live restoration fence: ${recoveryFenceActive?'active':'clear'}. Historical failed outcomes are retained.\n`+
    recoveryAttempts.map(item=>`Automatic recovery ${item.runId}: ${item.state}${item.reason?` (${item.reason})`:''}.\n`).join('')+
    safe.map(item => `${item.id}${item.variant ? ` / ${item.variant}` : ''} [${item.layer} — ${layerDescriptions[item.layer]}; ${item.environment}]: ${item.blockedBy ? regressionBlockedLabel(item.blockedBy.kind) : item.outcome} — ${durationDescription(item.durationMs)}${item.reason ? ` (${item.reason})` : ''}${item.stage ? ` [${item.stage}]` : ''}\n` +
      `  Catalogue goal: ${item.description}${item.reason ? `\n  Reason: ${blockerDescription(item.reason,item.id,item.variant,item.layer)}` : ''}`+
      (item.blockedBy?.caseId ? `\n  Blocking check: ${item.blockedBy.caseId}${item.blockedBy.reason ? ` (${item.blockedBy.reason})` : ''}${item.blockedBy.stage ? ` [${item.blockedBy.stage}]` : ''}` : '')+
      (item.outcome === 'Blocked' ? `\n  Next: ${blockedAction(item.reason,item.blockedBy?.kind)}` : '')).join('\n') + '\n');
  await archiveReport(directory,runId,artifacts,portableArchive);
  return {...summary, executionCounts,blockedCounts:evidenceBlockedCounts,executionBlockedCounts,recoveryFenceActive,recoveryAttempts, fullPhase0Accepted, fullPhase1Accepted, fullPhase2Accepted,fullPhase3Accepted,fullPhase4Accepted,installedPhase4Accepted,
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
