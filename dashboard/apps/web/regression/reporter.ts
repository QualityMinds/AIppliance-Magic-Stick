import type {FullConfig, FullResult, Reporter, Suite, TestCase, TestResult,TestStep} from '@playwright/test/reporter';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {HarnessError, reasons, stages, blockedReasons, type ReasonCode, type Stage} from './core/errors.ts';
import {phase1FastVariants, phase1FixtureVariants, phase1LiveVariants} from './profiles/phase1-p0.ts';
import {phase2FastVariants, phase2FixtureVariants, phase2ModelIds, phase2ModelCases} from './profiles/phase2-p0.ts';
import {gpuModeIds} from './profiles/gpu-p0.ts';
import {remainingIds} from './profiles/remaining-p0.ts';
import {reportVariants, saveReport, type CaseResult} from './core/report.ts';
import {environmentFor, fileLayer, testLayers, type Evidence} from './core/evidence.ts';
import {caseDescription, durationDescription, layerDescriptions, publicScenarioTitle} from './core/case-descriptions.ts';
import {disabledExperimentalEngines} from './core/engine-policy.ts';
import {safeStepTitle,safeTraceSource,saveExecutionTrace,traceCategories,type ExecutionTrace,type TraceStep} from './core/execution-trace.ts';

/** Playwright serializes Errors without our custom outcome property. Only a
 * fixed allowlisted marker can carry an explicit failure into safe reports. */
export function failureOutcome(code:ReasonCode|undefined,messages:readonly (string|undefined)[]) {
  const failures=messages.map(harnessFailure);
  // An assertion may quote a caught HarnessError in its expected/received
  // diff. Such embedded text must never turn a failed assertion into Blocked.
  if(failures.some(failure=>!failure))return 'Failed' as const;
  if(failures.some(failure=>failure?.outcome === 'Failed'))return 'Failed' as const;
  if(failures.some(failure=>failure?.outcome === 'Blocked'))return 'Blocked' as const;
  return code && blockedReasons.includes(code) ? 'Blocked' as const : 'Failed' as const;
}

export function harnessFailure(message:string|undefined) {
  const value=message?.trim().replace(/^HarnessError:\s*/,''),match=value?.match(/^\[([A-Z_]+)\] [^\r\n]* \[outcome:(Failed|Blocked)\](?: \[stage:([a-z-]+)\])?$/);
  if(!match || !Object.hasOwn(reasons,match[1]!) || match[3] && !stages.includes(match[3] as Stage))return;
  const code=match[1] as ReasonCode,outcome=match[2] as 'Failed'|'Blocked',stage=match[3] as Stage|undefined;
  if(value !== new HarnessError(code,outcome,stage).message)return;
  return {code,outcome,stage};
}

export default class SafeReporter implements Reporter {
  private cases: CaseResult[] = [];
  private unexpected = false;
  private total = 0;
  private started = 0;
  private positions = new Map<TestCase, number>();
  private steps=new Map<TestCase,Map<TestStep,{index:number;finished:boolean}>>();
  private omittedSteps=new Map<TestCase,number>();
  private traces:ExecutionTrace[]=[];
  onStepBegin(test:TestCase,_result:TestResult,step:TestStep) {
    let items=this.steps.get(test);if(!items){items=new Map();this.steps.set(test,items);}
    if(items.size<2000)items.set(step,{index:items.size+1,finished:false});
    else this.omittedSteps.set(test,(this.omittedSteps.get(test)??0)+1);
  }
  onStepEnd(test:TestCase,_result:TestResult,step:TestStep) {
    const item=this.steps.get(test)?.get(step);if(item)item.finished=true;
  }
  onBegin(_config: FullConfig, suite: Suite) {
    this.total = suite.allTests().length;
    process.stdout.write(`Selected ${this.total} executable tests. Catalogue goals describe case families, not full acceptance.\n`);
    if(disabledExperimentalEngines.length)process.stdout.write(
      `Excluded experimental engine tests: ${disabledExperimentalEngines.join(', ')}. Product engines remain enabled.\n`);
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
    const failures=result.errors.map(error=>harnessFailure(error.message));
    const failure=failures.find(value=>value?.outcome === 'Failed') ?? failures.find(Boolean);
    // A primary assertion/timeout must not hide a secondary teardown fence.
    const recoveryRequired=failures.some(value=>value&&['CLEANUP','OWNERSHIP','CONFLICT','LOCK_LOST','LOCK_STALE','RECOVERY'].includes(value.code));
    const code=failures.some(value=>!value) ? 'UNEXPECTED' : failure?.code;
    const outcome = result.status === 'passed' ? (result.retry > 0 ? 'Failed' : 'Passed') : result.status === 'skipped' ? 'Blocked' :
      failureOutcome(code,result.errors.map(error=>error.message));
    const stage=failure?.stage;
    const key=(item:Evidence)=>`${item.id}/${item.variant ?? ''}/${item.layer}`;
    const progressed=new Map<string,{state:string;durationMs:number}>();
    const stepAnnotations=test.annotations.filter(item=>item.type === 'regression-step');
    for(const annotation of stepAnnotations)try {
      const step=JSON.parse(annotation.description ?? '');
      if(!['running','passed','failed'].includes(step.state) || !Number.isFinite(step.durationMs) || step.durationMs < 0 ||
        !Array.isArray(step.items) || !step.items.length || step.items.some((item:Evidence)=>!evidence.some(e=>key(e) === key(item)))) {
        this.unexpected=true;continue;
      }
      for(const item of step.items)progressed.set(key(item),step);
    }catch{this.unexpected=true;}
    const executionId=createHash('sha256').update(process.env.REGRESSION_RUN_ID ?? 'fixture')
      .update(String(test.id ?? test.title)).digest('hex').slice(0,24);
    const runId=process.env.REGRESSION_RUN_ID,traceRunId=this.positions.has(test)?runId:undefined,
      source=safeTraceSource(test.location),scenario=publicScenarioTitle(test.title,test.location.file);
    const recorded=this.steps.get(test)??new Map<TestStep,{index:number;finished:boolean}>();
    const steps:TraceStep[]=[...recorded].map(([step,entry])=>{
      const at=safeTraceSource(step.location),category=traceCategories.includes(step.category as TraceStep['category'])?
        step.category as TraceStep['category']:'test.step';
      const error=harnessFailure(step.error?.message),parent=step.parent?recorded.get(step.parent)?.index:undefined;
      return {index:entry.index,category,title:safeStepTitle(step.title,category,at),durationMs:Math.max(0,step.duration??0),
        outcome:!entry.finished?'Blocked' as const:!step.error||outcome==='Passed'?'Passed' as const:
          error?.outcome==='Blocked'?'Blocked' as const:'Failed' as const,
        ...(parent?{parentIndex:parent}:{}),...(at?{source:at}:{}),
        ...(step.error&&outcome==='Passed'?{handledError:true as const}:{}),
        ...(error?{reason:error.code,...(error.stage?{stage:error.stage}:{})}:
          step.error&&outcome!=='Passed'?{reason:'UNEXPECTED' as const}:{} )};
    });
    const omittedSteps=this.omittedSteps.get(test);
    if(traceRunId)this.traces.push({version:1,runId:traceRunId,executionId,outcome,durationMs:Math.max(0,result.duration),steps,
      ...(omittedSteps?{omittedSteps}:{}),...(source?{source}:{}),...(scenario?{scenario}:{}),
      ...(recoveryRequired?{recoveryRequired:true}:{} )});
    this.steps.delete(test);this.omittedSteps.delete(test);
    for (const item of evidence) {
      const step=progressed.get(key(item)),passed=step?.state === 'passed' && result.retry === 0;
      const dependent=stepAnnotations.length > 0 && !step;
      const itemOutcome=passed ? 'Passed' : dependent ? 'Blocked' : outcome;
      this.cases.push({id:item.id,outcome:itemOutcome,layer:item.layer,environment:environmentFor(item.layer),executionId,executionOutcome:outcome,
        ...(traceRunId?{traceRunId}:{}),...(recoveryRequired?{recoveryRequired:true}:{}),
        durationMs:step?.durationMs ?? (dependent ? 0 : result.duration),
        ...(passed ? {} : dependent ? {reason:'DEPENDENCY' as const} : code ? {reason:code} : itemOutcome === 'Failed' ? {reason:'UNEXPECTED' as const} : {}),
        ...(item.variant ? {variant:item.variant as CaseResult['variant']} : {}),...(!passed && !dependent && stage ? {stage} : {})});
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
    for(const trace of this.traces)await saveExecutionTrace(directory,trace);
    const modelCase = process.env.REGRESSION_MODEL_CASE as keyof typeof phase2ModelCases | undefined;
    if (modelCase && !Object.hasOwn(phase2ModelCases, modelCase)) throw new HarnessError('CONFIG');
    const required = remainingIds(process.env.REGRESSION_MODE) ?? gpuModeIds(process.env.REGRESSION_MODE,process.env.REGRESSION_GPU_CASE || undefined) ?? (process.env.REGRESSION_MODE==='campaign-recover'?['HAR-07']:process.env.REGRESSION_MODE === 'selftest' ? Array.from({length: 11}, (_, index) => `HAR-${String(index + 1).padStart(2, '0')}`) :
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
