import {test, expect} from '@playwright/test';
import type {FullConfig, Suite, TestCase, TestResult, TestStep} from '@playwright/test/reporter';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import SafeReporter, {failureOutcome, harnessFailure} from '../reporter.ts';
import {caseDescription, caseDescriptions, durationDescription, layerDescriptions, modeDescription,
  parseCaseDescriptions, publicScenarioTitle, staticScenarioTitles} from '../core/case-descriptions.ts';
import {HarnessError,reasons} from '../core/errors.ts';
import {evidenceAnnotations,evidenceStep} from '../core/evidence.ts';
import {phase3Requirements,gpuModeIds} from '../profiles/gpu-p0.ts';
import {remainingRequirements} from '../profiles/remaining-p0.ts';
import {disabledExperimentalEngines} from '../core/engine-policy.ts';
import {completeCases,reportExitCode,reportVariants, saveReport, type CaseResult} from '../core/report.ts';
import {newRunId} from '../core/journal.ts';
import {childEvidence} from '../core/campaign-evidence.ts';
import {writePrivate} from '../core/private-files.ts';
import {parsePreparationDiagnostic, preparationDescription,requirePreparation} from '../core/preparation-diagnostic.ts';
import {blockedCounts,checkedBlocker,withBlockedCauses,inheritRecoveryCause,recoveryCause} from '../core/blocking.ts';
import {regressionBlockedKind} from '../../../../packages/core/src/regression-blocking.ts';
import {saveExecutionTrace} from '../core/execution-trace.ts';
import type {ExecutionTrace} from '../core/execution-trace.ts';

function capture(action: () => void): string {
  const chunks: string[] = [], original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { action(); } finally { process.stdout.write = original; }
  return chunks.join('');
}
function specimen(title: string, annotations: TestCase['annotations'] = []): TestCase {
  return {title, annotations, location: {file: fileURLToPath(import.meta.url), line: 1, column: 1}} as TestCase;
}
function result(status: TestResult['status'] = 'passed', message?: string): TestResult {
  return {status, duration: 1250, retry: 0, errors: message ? [{message}] : []} as TestResult;
}

test('HAR-06 HAR-09 HAR-10 primary scenario failure retains the separately recorded cleanup fence', () => {
  const selected = specimen('HAR-09'), primary = result('failed', new HarnessError('DEADLINE', 'Failed', 'model-ready').message);
  const step = {title: 'Verify owned foundation cleanup', category: 'test.step', duration: 1,
    error: {message: new HarnessError('CLEANUP', 'Failed', 'cleanup').message}} as TestStep;
  const reporter = new SafeReporter();
  reporter.onStepBegin(selected, primary, step); reporter.onStepEnd(selected, primary, step);
  capture(() => reporter.onTestEnd(selected, primary));
  const cases = (reporter as unknown as {cases: CaseResult[]}).cases;
  expect(cases[0]).toMatchObject({id: 'HAR-09', outcome: 'Failed', reason: 'DEADLINE', stage: 'model-ready', recoveryRequired: true});
  const blocked = new SafeReporter(), prerequisite = result('failed', new HarnessError('PREREQUISITE').message);
  blocked.onStepBegin(selected, prerequisite, step); blocked.onStepEnd(selected, prerequisite, step);
  capture(() => blocked.onTestEnd(selected, prerequisite));
  expect((blocked as unknown as {cases: CaseResult[]}).cases[0])
    .toMatchObject({outcome: 'Failed', reason: 'CLEANUP', stage: 'cleanup', recoveryRequired: true});
  const handled = new SafeReporter();
  handled.onStepBegin(selected, primary, step); handled.onStepEnd(selected, primary, step);
  capture(() => handled.onTestEnd(selected, result()));
  expect((handled as unknown as {cases: CaseResult[]}).cases[0]).not.toHaveProperty('recoveryRequired');
});

test('HAR-10 blocked dependencies inherit only their own scenario cause, preserving unknown and cancellation',()=>{
  const executionId='a'.repeat(24),other='b'.repeat(24),traceRunId=newRunId();
  const cases:CaseResult[]=[
    {id:'LIFE-03',layer:'E',outcome:'Failed',durationMs:1,reason:'DEADLINE',stage:'model-stopped',executionId,traceRunId},
    {id:'LIFE-04',layer:'E',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',executionId,traceRunId},
    {id:'HW-01',layer:'A',outcome:'Blocked',durationMs:0,reason:'CAPABILITY',executionId:other,traceRunId},
    {id:'ENG-01',layer:'E',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',executionId:other,traceRunId},
    {id:'HAR-10',layer:'U',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY'},
    {id:'HAR-11',layer:'U',outcome:'Blocked',durationMs:0,reason:'CANCELLED'},
    {id:'LIFE-04',layer:'E',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',executionId,traceRunId:newRunId()},
  ];
  const rows=withBlockedCauses(cases);
  expect(rows[1]!.blockedBy).toMatchObject({kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped',executionId,traceRunId});
  expect(rows[3]!.blockedBy).toMatchObject({kind:'prerequisite',caseId:'HW-01',reason:'CAPABILITY'});
  expect(rows[4]!.blockedBy?.kind).toBe('unknown');expect(rows[5]!.blockedBy?.kind).toBe('cancelled');
  expect(rows[6]!.blockedBy?.kind).toBe('unknown');
  expect(blockedCounts(cases)).toEqual({prerequisite:2,failure:1,cancelled:1,unknown:2});
  expect(blockedCounts(cases,true)).toEqual({prerequisite:1,failure:0,cancelled:0,unknown:1});
  expect(regressionBlockedKind('EXTERNAL_RUNNER')).toBe('prerequisite');
  expect(regressionBlockedKind('RECOVERY')).toBe('failure');
  expect(withBlockedCauses([{id:'HAR-10',outcome:'Blocked',reason:'PREREQUISITE'}])[0]?.blockedBy?.kind).toBe('unknown');
});

test('HAR-10 blocker metadata discards private text and non-catalogue causal identifiers',()=>{
  const secret='synthetic-secret-never-export';
  expect(checkedBlocker({kind:'failure',caseId:secret,reason:secret,stage:secret,traceRunId:secret,executionId:secret,message:secret}))
    .toEqual({kind:'failure'});
  expect(checkedBlocker({kind:secret})).toBeUndefined();
  expect(checkedBlocker({kind:'failure',reason:['API'],executionId:12345})).toEqual({kind:'failure'});
});

test('HAR-10 serial sibling skips retain the original failure while explicit and unrelated skips stay independent',()=>{
  const sharedRoot={} as Suite,parent={parent:sharedRoot} as Suite,other={parent:sharedRoot} as Suite,reporter=new SafeReporter();
  const root=specimen('LIFE-02',evidenceAnnotations({id:'LIFE-02',layer:'E'}).annotation);root.parent=parent;
  const dependent=specimen('MEM-05',evidenceAnnotations({id:'MEM-05',layer:'E'}).annotation);dependent.parent=parent;
  const explicit=specimen('ENG-10',[...evidenceAnnotations({id:'ENG-10',layer:'E'}).annotation,{type:'skip',description:'Missing fixture'}]);explicit.parent=parent;
  const independent=specimen('RT-01',evidenceAnnotations({id:'RT-01',layer:'E'}).annotation);independent.parent=other;
  capture(()=>{
    reporter.onTestBegin(root);reporter.onTestEnd(root,result('failed',new HarnessError('API','Failed','model-inference').message));
    for(const selected of [dependent,explicit,independent]) {reporter.onTestBegin(selected);reporter.onTestEnd(selected,result('skipped'));}
  });
  const rows=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(rows[1]).toMatchObject({outcome:'Blocked',reason:'DEPENDENCY',blockedBy:{kind:'failure',caseId:'LIFE-02',reason:'API',stage:'model-inference'}});
  expect(rows[1]!.blockedBy?.executionId).toBe(rows[0]!.executionId);
  expect(rows[2]!.blockedBy?.kind).toBe('unknown');expect(rows[3]!.blockedBy?.kind).toBe('unknown');
});

for(const reason of ['PREREQUISITE','DEADLINE'] as const)test(`HAR-10 dependent evidence retains the original ${reason} step cause`,async()=>{
  const root={id:'LIFE-03',variant:'p3-runtime-stop',layer:'E' as const},dependent={id:'LIFE-04',variant:'p3-runtime-start',layer:'E' as const};
  const selected=specimen('LIFE-03 LIFE-04',evidenceAnnotations(root,dependent).annotation),error=new HarnessError(reason,reason==='PREREQUISITE'?'Blocked':'Failed','model-stopped');
  await expect(evidenceStep(selected,[root],async()=>{throw error;})).rejects.toThrow(error.message);
  const reporter=new SafeReporter();capture(()=>reporter.onTestEnd(selected,result('failed',error.message)));
  const cases=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(cases[0]!.outcome).toBe(reason==='PREREQUISITE'?'Blocked':'Failed');
  expect(cases[1]).toMatchObject({outcome:'Blocked',reason:'DEPENDENCY',blockedBy:{kind:reason==='PREREQUISITE'?'prerequisite':'failure',caseId:'LIFE-03',reason,stage:'model-stopped'}});
});

test('HAR-10 JSON HTML text and JUnit distinguish prerequisites, failure dependencies and cancellation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-blocked-cause-')),runId=newRunId(),executionId='a'.repeat(24);
  try{
    await saveExecutionTrace(directory,{version:1,runId,executionId,outcome:'Failed',durationMs:1,steps:[]});
    const cases:CaseResult[]=[
      {id:'LIFE-03',layer:'E',outcome:'Failed',durationMs:1,reason:'DEADLINE',stage:'model-stopped',executionId,traceRunId:runId},
      {id:'LIFE-04',layer:'E',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',executionId,traceRunId:runId},
      {id:'HW-01',layer:'A',outcome:'Blocked',durationMs:0,reason:'CAPABILITY',executionId:'b'.repeat(24)},
      {id:'HAR-10',layer:'U',outcome:'Blocked',durationMs:0,reason:'RECOVERY',executionId:'c'.repeat(24)},
      {id:'HAR-11',layer:'U',outcome:'Blocked',durationMs:0,reason:'CANCELLED'},
    ];
    await saveReport(directory,runId,cases,cases.map(row=>row.id),'unknown','all');
    const json=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    expect(json.counts).toMatchObject({Failed:1,Blocked:4});
    expect(json.blockedCounts).toEqual({prerequisite:1,failure:2,cancelled:1,unknown:0});
    expect(json.executionCounts).toEqual({Passed:0,Failed:1,Blocked:2});
    expect(json.executionBlockedCounts).toEqual({prerequisite:1,failure:1,cancelled:0,unknown:0});
    expect(json.cases[1].blockedBy).toMatchObject({kind:'failure',caseId:'LIFE-03',stage:'model-stopped'});
    for(const name of ['summary.html','summary.txt','junit.xml']){
      const value=await readFile(join(directory,name),'utf8');
      expect(value).toContain('Blocked by prerequisite');expect(value).toContain('Blocked by failure');
      expect(value).toContain('Blocked by cancellation');expect(value).toContain('LIFE-03');
    }
    const junit=await readFile(join(directory,'junit.xml'),'utf8');
    expect(junit).toContain('failures="1" skipped="4"');
    expect(junit).toContain('name="blockedKind" value="failure"');
    expect(junit).toContain('name="blockedByCase" value="LIFE-03"');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-02 HAR-10 a preparation failure blocks dependent live checks as failure causes without failing every check',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-prepare-cause-')),previous=process.env.REGRESSION_PREPARATION_FAILED;
  try{
    process.env.REGRESSION_PREPARATION_FAILED='Failed';
    await expect(requirePreparation()).rejects.toThrow('[PREPARATION_FAILED]');
    const diagnostic=parsePreparationDiagnostic({version:1,outcome:'Failed',reason:'AUTH',setupStage:'login'});
    await saveReport(directory,newRunId(),[
      {id:'HAR-02',layer:'A',outcome:'Failed',durationMs:0,reason:'AUTH'},
      {id:'LIFE-01',layer:'E',outcome:'Blocked',durationMs:0,reason:'PREPARATION_FAILED'},
    ],['HAR-02','LIFE-01'],'unknown','all',diagnostic);
    const json=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    expect(json.counts).toMatchObject({Failed:1,Blocked:1});
    expect(json.cases[1].blockedBy).toEqual({kind:'failure',caseId:'HAR-02',reason:'AUTH'});
  }finally{
    if(previous===undefined)delete process.env.REGRESSION_PREPARATION_FAILED;else process.env.REGRESSION_PREPARATION_FAILED=previous;
    await rm(directory,{recursive:true,force:true});
  }
});

test('HAR-10 aggregate child imports preserve causal evidence while discarding private blocker fields',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-blocked-child-')),runId=newRunId(),directory=join(output,runId),receipt=join(output,'phase-result.json');
  try{
    await saveReport(directory,runId,[{id:'HAR-10',outcome:'Blocked',layer:'U',environment:'fixture',durationMs:0,reason:'DEPENDENCY',
      blockedBy:{kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped'}}],['HAR-10'],'unknown','selftest');
    const summary=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    summary.cases[0].blockedBy.message='synthetic-secret';await writePrivate(join(directory,'summary.json'),summary);
    await writePrivate(receipt,{version:1,mode:'selftest',runId,directory,exitCode:2});
    const child=await childEvidence({output,receipt,mode:'selftest',required:['HAR-10'],fixture:true,sourceRevision:'unknown'});
    expect(child.report.cases[0]!.blockedBy).toEqual({kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped'});
    expect(JSON.stringify(child)).not.toContain('synthetic-secret');
  }finally{await rm(output,{recursive:true,force:true});}
});

test('HAR-10 fresh explicit prerequisites remain distinct from synthesized missing coverage',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-missing-cause-'));
  try{
    await saveReport(directory,newRunId(),[{id:'HW-01',outcome:'Blocked',layer:'A',environment:'live',durationMs:0,reason:'PREREQUISITE'}],
      ['HW-01','HAR-10'],'unknown','all',{version:1,outcome:'Passed'});
    const json=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    expect(json.cases[0].blockedBy.kind).toBe('prerequisite');expect(json.cases[1].blockedBy).toMatchObject({kind:'failure',reason:'MISSING_EVIDENCE'});
    expect(json.blockedCounts).toEqual({prerequisite:1,failure:1,cancelled:0,unknown:0});
    expect(json.cases.some((row:CaseResult)=>row.outcome==='Failed'&&row.reason==='MISSING_EVIDENCE')).toBe(true);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-10 synthetic prerequisite reports are isolated from inherited live preparation status',async()=>{
  const previousFailed=process.env.REGRESSION_PREPARATION_FAILED,previousDiagnostic=process.env.REGRESSION_PREPARATION_DIAGNOSTIC;
  try {
    for(const inherited of ['Passed','Blocked','Failed']) {
      const directory=await mkdtemp(join(tmpdir(),'magicstick-isolated-report-'));
      process.env.REGRESSION_PREPARATION_FAILED=inherited;
      process.env.REGRESSION_PREPARATION_DIAGNOSTIC='synthetic-private-diagnostic-must-not-be-read';
      try {
        await saveReport(directory,newRunId(),[{id:'HW-01',outcome:'Blocked',layer:'A',environment:'live',durationMs:0,reason:'PREREQUISITE'}],
          ['HW-01','HAR-10'],'unknown','all',{version:1,outcome:'Passed'});
        const json=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
        expect(json.automaticPreparation).toEqual({version:1,outcome:'Passed'});
        expect(json.blockedCounts).toEqual({prerequisite:1,failure:1,cancelled:0,unknown:0});
        expect(json.cases[0].blockedBy.kind).toBe('prerequisite');expect(json.cases[1].blockedBy.reason).toBe('MISSING_EVIDENCE');
        expect(process.env.REGRESSION_PREPARATION_FAILED).toBe(inherited);
        expect(process.env.REGRESSION_PREPARATION_DIAGNOSTIC).toBe('synthetic-private-diagnostic-must-not-be-read');
      } finally {await rm(directory,{recursive:true,force:true});}
    }
  } finally {
    if(previousFailed===undefined)delete process.env.REGRESSION_PREPARATION_FAILED;else process.env.REGRESSION_PREPARATION_FAILED=previousFailed;
    if(previousDiagnostic===undefined)delete process.env.REGRESSION_PREPARATION_DIAGNOSTIC;else process.env.REGRESSION_PREPARATION_DIAGNOSTIC=previousDiagnostic;
  }
});

test('HAR-10 missing live tuples inherit a recovery fence present before the phase, not a later failure or a fixture gap',()=>{
  const guard:CaseResult={id:'HAR-10',layer:'A',environment:'live',outcome:'Blocked',durationMs:0,reason:'RECOVERY'};
  const before=completeCases('phase4',[guard],[],'PREREQUISITE',true);
  expect(before.filter(row=>row.environment==='live' && row.id!=='HAR-10').every(row=>
    row.reason==='RECOVERY' && row.blockedBy?.kind==='failure' && row.blockedBy.reason==='RECOVERY')).toBe(true);
  expect(before.filter(row=>row.environment==='fixture'&&row.outcome==='Blocked').every(row=>row.blockedBy?.reason==='MISSING_EVIDENCE')).toBe(true);
  expect(before.some(row=>row.environment==='fixture'&&row.outcome==='Failed'&&row.reason==='MISSING_EVIDENCE')).toBe(true);
  const later=completeCases('phase4',[guard],[]);
  expect(later.filter(row=>row.id!=='HAR-10').every(row=>row.reason==='DEPENDENCY' && row.blockedBy?.reason==='MISSING_EVIDENCE')).toBe(true);
  const cancelled=completeCases('phase4',[guard],[],'CANCELLED',true);
  expect(cancelled.filter(row=>row.id!=='HAR-10').every(row=>row.reason==='CANCELLED' && row.blockedBy?.kind==='cancelled')).toBe(true);
  const unobserved=completeCases('phase4',[],[],'PREREQUISITE',true);
  expect(unobserved.filter(row=>row.outcome==='Blocked').every(row=>row.blockedBy?.reason==='MISSING_EVIDENCE')).toBe(true);
  expect(unobserved.some(row=>row.outcome==='Failed'&&row.reason==='MISSING_EVIDENCE')).toBe(true);
});

test('HAR-10 cleanup cause survives later phase guards and only verified restoration clears it',()=>{
  const environment:Record<string,string|undefined>={},traceRunId=newRunId(),executionId='a'.repeat(24);
  const root:CaseResult={id:'MOD-04',outcome:'Failed',layer:'E',durationMs:1,reason:'CONFLICT',stage:'recovery-module',traceRunId,executionId};
  inheritRecoveryCause(environment,[root],true);
  inheritRecoveryCause(environment,[{id:'HAR-10',outcome:'Blocked',reason:'RECOVERY'}],true);
  expect(recoveryCause(environment.REGRESSION_RECOVERY_CAUSE)).toEqual({kind:'failure',caseId:'MOD-04',reason:'CONFLICT',stage:'recovery-module',traceRunId,executionId});
  const rows=completeCases('phase4',[{id:'HAR-10',outcome:'Blocked',reason:'RECOVERY',durationMs:0,layer:'A',
    blockedBy:recoveryCause(environment.REGRESSION_RECOVERY_CAUSE)}],[],'PREREQUISITE',true);
  expect(rows.filter(row=>row.outcome==='Blocked'&&row.environment==='live').every(row=>row.blockedBy?.caseId==='MOD-04')).toBe(true);
  inheritRecoveryCause(environment,[],false);expect(environment).toEqual({});expect(root.outcome).toBe('Failed');
});

test('HAR-10 exact blocked variants retain a known missing prerequisite instead of an invented failure',()=>{
  const source:CaseResult={id:'MGPU-01',variant:'p3-multigpu-vllm-4',layer:'A',environment:'live',durationMs:0,
    outcome:'Blocked',reason:'CAPABILITY',blockedBy:{kind:'prerequisite',reason:'CAPABILITY'}};
  const rows=completeCases('phase3',[source],[],'PREREQUISITE',true);
  expect(rows.find(row=>row.variant===source.variant && row.layer==='E')?.blockedBy).toEqual({kind:'prerequisite',reason:'CAPABILITY'});
});

test('HAR-10 late CPU Start failure does not rewrite completed creation, edit or log evidence',async()=>{
  const create={id:'LIFE-02',variant:'local-create-ollama',layer:'A' as const},edit={id:'LIFE-07',variant:'edit-ollama',layer:'E' as const},
    persistence={id:'LIFE-13',variant:'persistence-ollama',layer:'E' as const};
  const selected=specimen('LIFE-02 LIFE-07 LIFE-13',evidenceAnnotations(create,edit,persistence).annotation);
  await evidenceStep(selected,[create],async()=>{});await evidenceStep(selected,[edit],async()=>{});
  const error=new HarnessError('DEADLINE','Failed','model-ready');
  await expect(evidenceStep(selected,[persistence],async()=>{throw error;})).rejects.toThrow(error.message);
  const reporter=new SafeReporter();capture(()=>reporter.onTestEnd(selected,result('failed',error.message)));
  const rows=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(rows.map(row=>row.outcome)).toEqual(['Passed','Passed','Failed']);
  expect(rows.every(row=>row.executionOutcome==='Failed')).toBe(true);
});

test('HAR-10 an unannotated inference failure cannot become an overall Blocked report with no failed case',async()=>{
  const create={id:'LIFE-02',layer:'E' as const},edit={id:'LIFE-07',layer:'E' as const};
  const selected=specimen('LIFE-02 LIFE-07',evidenceAnnotations(create,edit).annotation);
  await evidenceStep(selected,[create],async()=>{});
  const reporter=new SafeReporter();capture(()=>reporter.onTestEnd(selected,result('failed',new HarnessError('API','Failed','model-inference').message)));
  const rows=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(rows[0]!.outcome).toBe('Passed');
  expect(rows[1]).toMatchObject({outcome:'Blocked',blockedBy:{kind:'failure',caseId:'HAR-10',reason:'API',stage:'model-inference'}});
  expect(rows[2]).toMatchObject({id:'HAR-10',outcome:'Failed',reason:'API',stage:'model-inference'});
  expect(reportExitCode(rows)).toBe(1);
});

test('HAR-10 HAR-11 sanitized runtime diagnostics survive trace archives and JUnit without exporting attachment secrets',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-runtime-report-')),runId=newRunId(),executionId='f'.repeat(24);
  const previousRunId=process.env.REGRESSION_RUN_ID;
  const diagnostic={version:1 as const,engine:'VLLM' as const,target:'nvidia-gpu' as const,deployment:'split' as const,
    gpuCount:4,generation:2,currentStatus:true,phase:'Degraded',credentials:'synthetic-secret',
    pods:[{phase:'Running',ready:false,scheduled:true,containers:[{ready:false,restarts:3,state:'waiting' as const,
      cause:'CrashLoopBackOff',lastCause:'OOMKilled',exitCode:137,message:'synthetic-secret'}]}]};
  try {
    await saveExecutionTrace(directory,{version:1,runId,executionId,outcome:'Failed',durationMs:1,steps:[],runtimeDiagnostics:[diagnostic]});
    await saveReport(directory,runId,[{id:'LIFE-12',layer:'E',outcome:'Failed',durationMs:1,reason:'DEADLINE',
      stage:'model-ready',executionId,traceRunId:runId}],['LIFE-12'],'unknown','selftest');
    const trace=await readFile(join(directory,'report-artifacts',runId,'traces',executionId+'.json'),'utf8');
    const junit=await readFile(join(directory,'junit.xml'),'utf8');
    for(const text of [trace,junit]){expect(text).toContain('OOMKilled');expect(text).toContain('137');expect(text).not.toContain('synthetic-secret');}
    expect(junit).toContain('name="runtimeDiagnosticCount" value="1"');
    const selected=specimen('LIFE-12'),failure=result('failed',new HarnessError('DEADLINE','Failed','model-ready').message);
    failure.attachments=[{name:'magicstick-runtime-diagnostic',contentType:'application/json',body:Buffer.from(JSON.stringify(diagnostic))},
      {name:'unapproved-diagnostic',contentType:'application/json',body:Buffer.from('synthetic-secret')},
      {name:'magicstick-runtime-diagnostic',contentType:'application/json',body:Buffer.from('{"version":99,"secret":"synthetic-secret"}')}];
    process.env.REGRESSION_RUN_ID=runId;
    const reporter=new SafeReporter();capture(()=>{reporter.onTestBegin(selected);reporter.onTestEnd(selected,failure);});
    const traces=(reporter as unknown as {traces:ExecutionTrace[]}).traces;
    expect(traces[0]?.runtimeDiagnostics).toHaveLength(1);expect(JSON.stringify(traces)).not.toContain('synthetic-secret');
  }finally{
    if(previousRunId===undefined)delete process.env.REGRESSION_RUN_ID;else process.env.REGRESSION_RUN_ID=previousRunId;
    await rm(directory,{recursive:true,force:true});
  }
});

test('HAR-02 HAR-10 HAR-11 failed refresh reason and setup stage survive aggregate reports without raw logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'magicstick-preparation-report-'));
  const secret = 'synthetic-secret-never-store';
  try {
    const diagnostic = parsePreparationDiagnostic({version: 1, outcome: 'Blocked', reason: 'LOCK_STALE',
      setupStage: 'lab-bootstrap', detail: secret, message: secret, stderr: secret});
    expect(diagnostic).toEqual({version: 1, outcome: 'Blocked', reason: 'LOCK_STALE', setupStage: 'lab-bootstrap'});
    expect(preparationDescription(diagnostic)).toContain('setup stage: lab-bootstrap');
    await saveReport(directory, newRunId(), [{id: 'HAR-02', layer: 'A', environment: 'live', durationMs: 0,
      outcome: 'Blocked', reason: 'LOCK_STALE'}], ['HAR-02'], 'unknown', 'all', diagnostic);
    const json = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(json.automaticPreparation).toEqual(diagnostic);
    for (const name of ['summary.json', 'summary.txt', 'summary.html']) {
      const value = await readFile(join(directory, name), 'utf8');
      expect(value).toContain('LOCK_STALE'); expect(value).toContain('lab-bootstrap'); expect(value).not.toContain(secret);
    }
    expect(() => parsePreparationDiagnostic({version: 1, outcome: secret})).toThrow('[CONFIG]');
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('HAR-07 HAR-10 successful automatic recovery is lifecycle evidence and never changes a failed test result',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-recovery-report-')),runId=newRunId(),previous=newRunId();
  try {
    const diagnostic=parsePreparationDiagnostic({version:1,outcome:'Passed',setupStage:'run-recovery',recoveredRunIds:[previous,previous],raw:'synthetic-secret'});
    expect(diagnostic.recoveredRunIds).toEqual([previous]);
    expect(preparationDescription(diagnostic)).toContain('original test outcomes retained');
    expect(preparationDescription(diagnostic)).not.toContain('PREREQUISITE');
    expect(parsePreparationDiagnostic({version:1,outcome:'Passed',recoveredRunIds:['../foreign']})).not.toHaveProperty('recoveredRunIds');
    await saveReport(directory,runId,[{id:'HAR-07',layer:'U',environment:'fixture',durationMs:0,outcome:'Failed',reason:'CLEANUP'}],['HAR-07'],'unknown','all',diagnostic);
    const value=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    expect(value.automaticPreparation).toEqual(diagnostic);expect(value.acceptable).toBe(false);expect(value.counts.Failed).toBe(1);
    expect(await readFile(join(directory,'summary.txt'),'utf8')).not.toContain('synthetic-secret');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('HAR-10 catalogue descriptions cover every registered variant without a duplicate registry', () => {
  expect(Object.keys(caseDescriptions).length).toBeGreaterThan(200);
  for (const id of Object.values(reportVariants)) expect(Object.hasOwn(caseDescriptions, id), id).toBe(true);
  expect(caseDescription('SEC-03')).toContain('dependency vulnerabilities');
  expect(caseDescription('LIFE-03')).toContain('Stop');
  expect(Object.keys(layerDescriptions)).toEqual(['U', 'C', 'B', 'A', 'E', 'O', 'N']);
  expect(modeDescription('selftest')).toContain('isolated fixtures');
  expect(modeDescription('preflight')).toContain('read-only');
  expect(modeDescription('phase6-fast')).toContain('no appliance access');
  expect(modeDescription('phase8-fixtures')).toContain('isolated browser');
  expect(modeDescription('phase7-live')).toContain('installed-appliance');
  expect(durationDescription(1250)).toBe('1.3s');
  expect(durationDescription(65000)).toBe('1m 5.0s');
});

test('HAR-10 catalogue parsing ignores implementation ledgers and rejects duplicate or empty input', () => {
  const row = '| HAR-10 | Check `reports` and **required gaps**. | U+C | P0 · fast |';
  expect(parseCaseDescriptions(row)).toEqual({'HAR-10': 'Check reports and required gaps.'});
  expect(parseCaseDescriptions(row + '\r\n| HAR-10 | historical ledger | Implemented |')).toEqual(parseCaseDescriptions(row));
  expect(() => parseCaseDescriptions(row + '\n' + row)).toThrow('[CONFIG]');
  expect(() => parseCaseDescriptions('No public case definitions')).toThrow('[CONFIG]');
  expect(() => parseCaseDescriptions(row.replace('reports', 'unsafe\x1b[31m'))).toThrow('[CONFIG]');
});

test('HAR-11 only literal public-source scenario names can become console descriptions', () => {
  const source = 'test("HAR-10 public scenario", () => {});\ntest(`HAR-11 public template`, () => {});\n' +
    'test(`HAR-11 private ${secret}`, () => {});\ntest("HAR-11 private " + secret, () => {});';
  expect([...staticScenarioTitles(source)]).toEqual(['HAR-10 public scenario', 'HAR-11 public template']);
  const title = 'HAR-11 only literal public-source scenario names can become console descriptions';
  expect(publicScenarioTitle(title, fileURLToPath(import.meta.url))).toBe(title);
  expect(publicScenarioTitle(title + ' synthetic-secret', fileURLToPath(import.meta.url))).toBeUndefined();
  expect(publicScenarioTitle(title, fileURLToPath(new URL('../../../../../tools/regression_inputs.py', import.meta.url)))).toBeUndefined();
});

test('HAR-10 reporter shows test progress, exact public scenario, layer, goal and completion duration', () => {
  const title = 'HAR-10 reporter shows test progress, exact public scenario, layer, goal and completion duration';
  const first = specimen(title), second = specimen('HAR-03 [p2:final-idle]');
  const output = capture(() => {
    const reporter = new SafeReporter();
    reporter.onBegin({} as FullConfig, {allTests: () => [first, second]} as Suite);
    reporter.onTestBegin(first);
    reporter.onTestEnd(first, result());
    reporter.onTestBegin(second);
    reporter.onTestEnd(second, result());
  });
  expect(output).toContain('Selected 2 executable tests');
  expect(output).not.toContain('Excluded experimental engine tests:');
  expect(output).toContain('[1/2] START HAR-10');
  expect(output).toContain(`Scenario: ${title}`);
  expect(output).toContain(`HAR-10 catalogue goal: ${caseDescription('HAR-10')}`);
  expect(output).toContain('U — unit/component; fixture');
  expect(output).toContain('[1/2] HAR-10: Passed — 1.3s');
  expect(output).toContain('[2/2] START HAR-03');
  expect(output).toContain('variant: final-idle');
});

test('HAR-11 reporter explains safe failure reasons without printing private titles, errors or annotation fields', () => {
  const secret = 'synthetic-secret-never-print';
  const first = specimen(`HAR-11 https://private.example.test/?token=${secret}`, [{type: 'regression',
    description: JSON.stringify({id: 'HAR-11', layer: 'U', raw: secret, description: secret})}]);
  const output = capture(() => {
    const reporter = new SafeReporter();
    reporter.onBegin({} as FullConfig, {allTests: () => [first]} as Suite);
    reporter.onTestBegin(first);
    reporter.onTestEnd(first, result('failed', new HarnessError('TLS','Blocked','model-ready').message));
  });
  expect(output).toContain('HAR-11: Blocked');
  expect(output).toContain(`Reason (TLS): ${reasons.TLS}`);
  expect(output).toContain('Stage: model-ready.');
  expect(output).not.toContain(secret);
  expect(output).not.toContain('https://private.example.test');
  expect(output).not.toContain('Scenario:');
});

test('HAR-10 nested HarnessError text in an assertion never changes Failed to Blocked',()=>{
  const blocked=new HarnessError('PREREQUISITE').message;
  expect(harnessFailure(blocked)).toMatchObject({code:'PREREQUISITE',outcome:'Blocked'});
  expect(harnessFailure('HarnessError: '+blocked)).toMatchObject({code:'PREREQUISITE',outcome:'Blocked'});
  expect(failureOutcome('PREREQUISITE',[blocked])).toBe('Blocked');
  const assertion=`expect(received).toThrow(expected)\nExpected substring: "[CONFIG]"\nReceived message: "${blocked}"`;
  expect(harnessFailure(assertion)).toBeUndefined();
  expect(failureOutcome('PREREQUISITE',[assertion])).toBe('Failed');
  expect(failureOutcome('PREREQUISITE',[blocked,assertion])).toBe('Failed');
  expect(harnessFailure(`[TLS] unreviewed upstream text [outcome:Blocked]`)).toBeUndefined();
});

test('HAR-10 late Stop failure preserves inference evidence and blocks only unreached Start checks',async()=>{
  const ready={id:'ENG-01',variant:'p3-amd-vllm',layer:'A' as const},
    route={id:'ROUTE-01',variant:'p3-route',layer:'A' as const},
    stop={id:'LIFE-03',variant:'p3-runtime-stop',layer:'E' as const},
    start={id:'LIFE-04',variant:'p3-runtime-start',layer:'E' as const};
  const selected=specimen('ENG-01 ROUTE-01 LIFE-03 LIFE-04',evidenceAnnotations(ready,route,stop,start).annotation);
  await evidenceStep(selected,[ready,route],async()=>42);
  const error=new HarnessError('DEADLINE','Failed','model-stopped');
  await expect(evidenceStep(selected,[stop],async()=>{throw error;})).rejects.toBe(error);
  const reporter=new SafeReporter();capture(()=>reporter.onTestEnd(selected,result('failed',error.message)));
  const cases=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(cases.map(item=>({id:item.id,outcome:item.outcome,reason:item.reason,stage:item.stage}))).toEqual([
    {id:'ENG-01',outcome:'Passed',reason:undefined,stage:undefined},
    {id:'ROUTE-01',outcome:'Passed',reason:undefined,stage:undefined},
    {id:'LIFE-03',outcome:'Failed',reason:'DEADLINE',stage:'model-stopped'},
    {id:'LIFE-04',outcome:'Blocked',reason:'DEPENDENCY',stage:undefined}]);
  expect(new Set(cases.map(item=>item.executionId)).size).toBe(1);
  expect(cases[0]?.executionId).toMatch(/^[a-f0-9]{24}$/);
});

test('HAR-10 retired FreeToken cases are absent from executable coverage',()=>{
  expect(disabledExperimentalEngines).toEqual([]);
  expect(phase3Requirements.some(item=>item.variant.startsWith('p3-ft-'))).toBe(false);
  expect(gpuModeIds('phase3-gpu')?.some(id=>id.startsWith('FT-') || id === 'DISC-08')).toBe(false);
  expect(remainingRequirements('phase6')?.some(item=>item.id === 'CACHE-07')).toBe(false);
  expect(completeCases('phase3',[],gpuModeIds('phase3')!).some(item=>item.id.startsWith('FT-') || item.id === 'DISC-08')).toBe(false);
  expect(phase3Requirements.some(item=>item.variant === 'p3-nvidia-vllm')).toBe(true);
  expect(phase3Requirements.some(item=>item.variant === 'p3-amd-ollama')).toBe(true);
});

test('HAR-10 reports count executable scenarios independently of their case variant layer evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-report-counts-'));
  try {
    const executionId='a'.repeat(24),second='b'.repeat(24);
    const cases:CaseResult[]=[{id:'ENG-01',variant:'p3-amd-vllm',layer:'A',outcome:'Passed',durationMs:1,executionId},
      {id:'ENG-01',variant:'p3-amd-vllm',layer:'E',outcome:'Passed',durationMs:1,executionId},
      {id:'LIFE-03',variant:'p3-runtime-stop',layer:'E',outcome:'Failed',durationMs:1,reason:'DEADLINE',executionId},
      {id:'LIFE-04',variant:'p3-runtime-start',layer:'E',outcome:'Blocked',durationMs:0,reason:'DEPENDENCY',executionId},
      {id:'HAR-10',layer:'U',outcome:'Passed',durationMs:1,executionId:second}];
    const summary=await saveReport(directory,newRunId(),cases,['ENG-01','LIFE-03','LIFE-04','HAR-10'],'unknown','selftest');
    expect(summary.counts).toMatchObject({Passed:3,Failed:1,Blocked:1});
    expect(summary.executionCounts).toEqual({Passed:1,Failed:1,Blocked:0});
    const json=JSON.parse(await readFile(join(directory,'summary.json'),'utf8'));
    expect(json.executionCounts).toEqual(summary.executionCounts);
    const html=await readFile(join(directory,'summary.html'),'utf8');
    expect(html).toContain('Recorded executable scenarios: 1 passed · 1 failed · 0 blocked');
    expect(html).toContain('Evidence rows (case × variant × layer): 3 passed · 1 failed · 1 blocked');
    expect(html).toContain('Fix the earlier failed step');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-10 a cleanup failure cannot turn completed checks into a successful executable scenario',async()=>{
  const ready={id:'ENG-01',variant:'p3-amd-vllm',layer:'A' as const};
  const selected=specimen('ENG-01',evidenceAnnotations(ready).annotation);
  await evidenceStep(selected,[ready],async()=>42);
  const reporter=new SafeReporter();
  capture(()=>reporter.onTestEnd(selected,result('failed',new HarnessError('CLEANUP','Failed','cleanup').message)));
  const cases=(reporter as unknown as {cases:CaseResult[]}).cases;
  expect(cases).toHaveLength(2);
  expect(cases[0]).toMatchObject({outcome:'Passed',executionOutcome:'Failed'});
  expect(cases[1]).toMatchObject({id:'HAR-10',outcome:'Failed',reason:'CLEANUP',stage:'cleanup'});
  const directory=await mkdtemp(join(tmpdir(),'magicstick-report-cleanup-'));
  try {
    const summary=await saveReport(directory,newRunId(),cases,['ENG-01'],'unknown','phase3-gpu');
    expect(summary.counts.Passed).toBe(1);
    expect(summary.counts.Failed).toBe(1);
    expect(summary.executionCounts).toEqual({Passed:0,Failed:1,Blocked:0});
    expect(summary.acceptable).toBe(false);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-10 reporter describes each complementary case layer separately', () => {
  const selected = specimen('HAR-01 HAR-02', [{type: 'regression', description: JSON.stringify({id: 'HAR-01', layer: 'A'})},
    {type: 'regression', description: JSON.stringify({id: 'HAR-02', layer: 'E'})}]);
  const output = capture(() => new SafeReporter().onTestBegin(selected));
  expect(output).toContain(`HAR-01 catalogue goal: ${caseDescription('HAR-01')}`);
  expect(output).toContain(`HAR-02 catalogue goal: ${caseDescription('HAR-02')}`);
  expect(output).toContain('A — live API/integration; live');
  expect(output).toContain('E — live browser and independent observations; live');
});

test('HAR-11 saved reports derive descriptions from the catalogue, not caller-supplied private text', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'magicstick-report-description-'));
  try {
    const secret = 'synthetic-secret-never-store';
    const cases: Array<CaseResult & {description: string}> = [
      {id: 'APP-05', layer: 'C', outcome: 'Passed', durationMs: 1250, description: secret},
      {id: 'HAR-01', layer: 'A', outcome: 'Blocked', durationMs: 1250, reason: 'TLS', description: secret}];
    const summary = await saveReport(directory, newRunId(), cases, ['APP-05', 'HAR-01'], 'unknown', 'selftest');
    expect(summary.acceptable).toBe(false);
    const json = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
    expect(json.version).toBe(2);
    expect(json.cases[0].description).toBe(caseDescription('APP-05'));
    const text = await readFile(join(directory, 'summary.txt'), 'utf8');
    expect(text).toContain(`Catalogue goal: ${caseDescription('APP-05')}`);
    expect(text).toContain('C — API/render contract; fixture');
    expect(text).toContain(reasons.TLS);
    expect(text).toContain('Passed — 1.3s');
    const xml = await readFile(join(directory, 'junit.xml'), 'utf8');
    expect(xml).toContain('name="APP-05"');
    expect(xml).toContain('name="catalogueGoal"');
    expect(xml).toContain('&lt;name&gt;.&lt;type&gt;.&lt;domain&gt;');
    const html=await readFile(join(directory,'summary.html'),'utf8');
    expect(html).toContain('Blocked');expect(html).toContain('Restore connectivity');
    for (const content of [JSON.stringify(json), text, xml,html]) expect(content).not.toContain(secret);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('HAR-10 reports complete every finite phase variant and use only three terminal outcomes',()=>{
  const cases=completeCases('phase2',[{id:'LIFE-01',layer:'A',outcome:'Passed',durationMs:1}],['LIFE-01']);
  expect(cases.length).toBeGreaterThan(20);expect(cases.some(item=>item.outcome === 'Blocked')).toBe(true);
  expect(cases.every(item=>['Passed','Failed','Blocked'].includes(item.outcome))).toBe(true);
  expect(reportExitCode(cases)).toBe(1); // Missing execution evidence is a runner defect, not missing equipment.
  expect(reportExitCode([...cases,{outcome:'Failed'}])).toBe(1);
  expect(reportExitCode([{outcome:'Passed'}])).toBe(0);
  expect(completeCases(undefined,[{id:'HAR-10',layer:'U',outcome:'Flaky',durationMs:1}],[])[0]?.outcome).toBe('Failed');
});

test('HAR-10 missing child evidence records a failed harness and fences only dependent live writes',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-child-evidence-'));
  try {
    const installed=await childEvidence({output,receipt:join(output,'missing.json'),mode:'phase2',required:['LIFE-01'],fixture:false});
    expect(installed.recoveryFence).toBe(true);expect(installed.report.cases.some(item=>item.outcome === 'Failed')).toBe(true);
    expect(installed.report.cases.some(item=>item.id === 'LIFE-01' && item.outcome === 'Blocked')).toBe(true);
    const isolated=await childEvidence({output,receipt:join(output,'missing.json'),mode:'selftest',required:['HAR-10'],fixture:true});
    expect(isolated.recoveryFence).toBe(false);expect(isolated.report.cases[0]?.outcome).toBe('Failed');
    const cancelled=await childEvidence({output,receipt:join(output,'missing.json'),mode:'selftest',required:['HAR-10'],fixture:true,cancelled:true});
    expect(cancelled.report.cases[0]?.outcome).toBe('Blocked');expect(cancelled.report.cases[0]?.reason).toBe('CANCELLED');
  }finally{await rm(output,{recursive:true,force:true});}
});

test('HAR-10 valid blocked child evidence is retained and a later independent child can still pass',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-child-results-'));
  try {
    const receipt=join(output,'child.json'),runId=newRunId(),directory=join(output,runId);
    await (await import('../core/private-files.ts')).privateDirectory(directory);
    await saveReport(directory,runId,[{id:'HAR-10',layer:'U',outcome:'Blocked',durationMs:1,reason:'PREREQUISITE'}],['HAR-10'],undefined,'selftest');
    await writePrivate(receipt,{version:1,mode:'selftest',runId,directory,exitCode:2});
    const blocked=await childEvidence({output,receipt,mode:'selftest',required:['HAR-10'],fixture:true});
    expect(blocked.recoveryFence).toBe(false);expect(blocked.report.cases[0]?.outcome).toBe('Blocked');
    await saveReport(directory,runId,[{id:'HAR-10',layer:'U',outcome:'Passed',durationMs:1}],['HAR-10'],undefined,'selftest');
    await writePrivate(receipt,{version:1,mode:'selftest',runId,directory,exitCode:0});
    const passed=await childEvidence({output,receipt,mode:'selftest',required:['HAR-10'],fixture:true});
    expect(passed.report.acceptable).toBe(true);expect(passed.report.cases[0]?.outcome).toBe('Passed');
    await writePrivate(receipt,{version:1,mode:'selftest',runId,directory:'/foreign/private',exitCode:0});
    const forged=await childEvidence({output,receipt,mode:'selftest',required:['HAR-10'],fixture:true});
    expect(forged.report.acceptable).toBe(false);expect(forged.report.cases[0]?.outcome).toBe('Failed');
  }finally{await rm(output,{recursive:true,force:true});}
});

test('HAR-07 HAR-10 proven campaign restoration clears only the live fence while retaining failed history',async()=>{
  const output=await mkdtemp(join(tmpdir(),'magicstick-campaign-restored-'));
  try {
    const runId=newRunId(),previous=newRunId(),directory=join(output,runId),receipt=join(output,'phase-result.json');
    const rows:CaseResult[]=[{id:'HAR-07',layer:'A',environment:'live',durationMs:1,outcome:'Failed',reason:'CLEANUP',recoveryRequired:true}];
    await saveReport(directory,runId,rows,['HAR-07'],'unknown','all',undefined,
      {recoveryFenceActive:false,recoveryAttempts:[{runId:previous,state:'restored'}]});
    await writePrivate(receipt,{version:1,mode:'all',runId,directory,exitCode:1});
    const value=await childEvidence({output,receipt,mode:'all',required:['HAR-07'],fixture:false});
    expect(value.recoveryFence).toBe(false);expect(value.report.acceptable).toBe(false);
    expect(value.report.cases[0]).toMatchObject({outcome:'Failed',reason:'CLEANUP',recoveryRequired:true});
    expect(value.report.recoveryAttempts).toEqual([{runId:previous,state:'restored'}]);
    expect(await readFile(join(directory,'summary.txt'),'utf8')).toContain('Live restoration fence: clear');
    expect(await readFile(join(directory,'summary.html'),'utf8')).toContain('Historical failed outcomes are retained');
  }finally{await rm(output,{recursive:true,force:true});}
});

test('HAR-07 HAR-10 an active restoration fence prevents accepting otherwise passed evidence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-active-fence-'));
  try {
    const value=await saveReport(directory,newRunId(),[{id:'HAR-07',layer:'U',durationMs:1,outcome:'Passed',recoveryRequired:true}],
      ['HAR-07'],'unknown','selftest');
    expect(value.recoveryFenceActive).toBe(true);expect(value.acceptable).toBe(false);expect(value.counts.Passed).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
