import {test, expect} from '@playwright/test';
import type {FullConfig, Suite, TestCase, TestResult} from '@playwright/test/reporter';
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
import {disabledExperimentalEngines,freeTokenRegressionEnabled} from '../core/engine-policy.ts';
import {completeCases,reportExitCode,reportVariants, saveReport, type CaseResult} from '../core/report.ts';
import {newRunId} from '../core/journal.ts';
import {childEvidence} from '../core/campaign-evidence.ts';
import {writePrivate} from '../core/private-files.ts';
import {verifyCapabilities} from '../core/preflight.ts';
import type {LabConfig} from '../core/config.ts';
import type {ModelsPayload} from '@magicstick/dashboard-contracts';
import {parsePreparationDiagnostic, preparationDescription} from '../core/preparation-diagnostic.ts';

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
  expect(output).toContain('Excluded experimental engine tests: FreeToken. Product engines remain enabled.');
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

test('HAR-10 disabled experimental FreeToken tests are excluded rather than fabricated as Blocked or Passed',()=>{
  expect(disabledExperimentalEngines).toEqual(['FreeToken']);
  expect(freeTokenRegressionEnabled).toBe(false);
  expect(phase3Requirements.some(item=>item.variant.startsWith('p3-ft-'))).toBe(false);
  expect(gpuModeIds('phase3-gpu')?.some(id=>id.startsWith('FT-') || id === 'DISC-08')).toBe(false);
  expect(remainingRequirements('phase6')?.some(item=>item.id === 'CACHE-07')).toBe(false);
  expect(completeCases('phase3',[],gpuModeIds('phase3')!).some(item=>item.id.startsWith('FT-') || item.id === 'DISC-08')).toBe(false);
  expect(phase3Requirements.some(item=>item.variant === 'p3-nvidia-vllm')).toBe(true);
  expect(phase3Requirements.some(item=>item.variant === 'p3-amd-ollama')).toBe(true);
});

test('HAR-02 unavailable excluded FreeToken capability pins never block classic engines',()=>{
  const config={expected:{capabilities:[{target:'nvidia-gpu',engines:['VLLM','FreeToken']},
    {target:'experimental-only',engines:['FreeToken']}]}} as LabConfig;
  const models={activations:[],computeTargets:{targets:[{id:'nvidia-gpu',available:true,engines:['VLLM'],
    engineAvailability:{VLLM:{available:true},FreeToken:{available:false}}}]}} as unknown as ModelsPayload;
  expect(()=>verifyCapabilities(config,models)).not.toThrow();
  models.computeTargets.targets[0]!.engineAvailability!.VLLM!.available=false;
  expect(()=>verifyCapabilities(config,models)).toThrow('[CAPABILITY]');
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
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({outcome:'Passed',executionOutcome:'Failed'});
  const directory=await mkdtemp(join(tmpdir(),'magicstick-report-cleanup-'));
  try {
    const summary=await saveReport(directory,newRunId(),cases,['ENG-01'],'unknown','phase3-gpu');
    expect(summary.counts.Passed).toBe(1);
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
  expect(reportExitCode(cases)).toBe(2);
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
