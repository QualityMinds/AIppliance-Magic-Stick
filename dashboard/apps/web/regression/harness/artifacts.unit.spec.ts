import {test,expect} from '@playwright/test';
import type {FullConfig,Suite,TestCase,TestResult,TestStep} from '@playwright/test/reporter';
import {mkdtemp,readFile,rm,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import SafeReporter from '../reporter.ts';
import {newRunId} from '../core/journal.ts';
import {HarnessError} from '../core/errors.ts';
import {componentDiagnostic} from '../core/component-diagnostic.ts';
import {safeComponentDiagnostic} from '../core/report-artifacts.ts';
import {parseExecutionTrace,saveExecutionTrace,type ExecutionTrace} from '../core/execution-trace.ts';
import {privateDirectory,writePrivate} from '../core/private-files.ts';
import {saveReport,type CaseResult} from '../core/report.ts';
import {staticDiagnosticTitles} from '../core/case-descriptions.ts';

const source={file:'regression/harness/artifacts.unit.spec.ts',line:1};
const secret='synthetic-credential-never-archive';
const componentTitle='keeps software notices readable when entitlement status is unavailable';
async function isolated(action:(directory:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'magicstick-artifacts-'));
  try {await action(directory);}finally{await rm(directory,{recursive:true,force:true});}
}
function trace(runId=newRunId()):ExecutionTrace {
  return {version:1,runId,executionId:'a'.repeat(24),durationMs:1337,outcome:'Failed',source,
    steps:[{index:1,category:'test.step',title:'Verify archive attachment portability',durationMs:1200,outcome:'Passed',source},
      {index:2,parentIndex:1,category:'pw:api',title:'locator.waitForResponse('+secret+')',durationMs:100,
        outcome:'Failed',reason:'DEADLINE',stage:'model-estimate',source},
      {index:3,category:'hook',title:secret,durationMs:0,outcome:'Blocked',source}]};
}

test('HAR-11 traces retain reviewed step labels and safe outcomes but never dynamic values or raw error bodies',()=>{
  const value=trace();
  const safe=parseExecutionTrace({...value,password:secret,url:'https://private.invalid/'+secret,
    steps:value.steps.map(item=>({...item,error:{message:secret},selector:secret,request:{body:secret}}))});
  expect(safe.steps.map(item=>item.title)).toEqual(['Verify archive attachment portability','Browser/API waitForResponse','Setup/teardown hook']);
  expect(safe.steps[1]).toMatchObject({parentIndex:1,reason:'DEADLINE',stage:'model-estimate',outcome:'Failed'});
  expect(JSON.stringify(safe)).not.toContain(secret);
  expect(JSON.stringify(safe)).not.toContain('private.invalid');
  expect(parseExecutionTrace({...value,steps:[{...value.steps[0]!,title:secret}]}).steps[0]?.title).toBe('Test step');
  expect(parseExecutionTrace({...value,source:{file:'../../private.json',line:1}})).not.toHaveProperty('source');
  expect(()=>parseExecutionTrace({...value,steps:[{...value.steps[0]!,parentIndex:2}]})).toThrow('[CONFIG]');
  expect(()=>parseExecutionTrace({...value,steps:[value.steps[0]!,value.steps[0]!]})).toThrow('[CONFIG]');
  expect(()=>parseExecutionTrace({...value,durationMs:NaN})).toThrow('[CONFIG]');
});

test('HAR-11 diagnostic title parsing rejects interpolation concatenation and escaped literals',()=>{
  const component='it("public title", () => {}); it(`private ${secret}`, () => {}); it("private " + secret, () => {});';
  const steps='test.step("public step", () => {}); test.step(`private ${secret}`, () => {}); test.step("bad\\ntitle", () => {});';
  expect([...staticDiagnosticTitles(component,'component')]).toEqual(['public title']);
  expect([...staticDiagnosticTitles(steps,'step')]).toEqual(['public step']);
});

test('HAR-10 HAR-11 component diagnostics preserve the original assertion index and source title without assertion values',()=>{
  const diagnostic=componentDiagnostic('src/LicensePage.test.tsx',{testResults:[{assertionResults:[
    {title:'passed',status:'passed'},
    {title:componentTitle,status:'failed',failureMessages:['Test timed out '+secret],location:{line:44}},
    {title:secret,fullName:secret,status:'failed',failureMessages:['AssertionError: '+secret]},
  ]}]},{status:1});
  expect(diagnostic.failedAssertions[0]).toEqual({index:1,status:'failed',category:'timeout',title:componentTitle,line:44});
  expect(diagnostic.failedAssertions[1]).toEqual({index:2,status:'failed',category:'assertion'});
  expect(JSON.stringify(diagnostic)).not.toContain(secret);
  expect(safeComponentDiagnostic({...diagnostic,raw:secret})).toEqual(diagnostic);
  expect(safeComponentDiagnostic({...diagnostic,failedAssertions:[{index:0,title:secret,message:secret}]}).failedAssertions[0]).not.toHaveProperty('title');
  expect(()=>safeComponentDiagnostic({...diagnostic,suite:'src/../private.test.tsx'})).toThrow('[CONFIG]');
});

test('HAR-10 HAR-11 JUnit archives separate evidence scenarios and steps with portable sanitized trace attachments',async()=>isolated(async directory=>{
  const output=join(directory,'runs'),leafId=newRunId(),rootId=newRunId(),leaf=join(output,leafId),root=join(output,rootId);
  await privateDirectory(leaf);await privateDirectory(root);
  const recorded=trace(leafId);await saveExecutionTrace(leaf,recorded);
  await writePrivate(join(leaf,'journal.json'),{password:secret});
  await writePrivate(join(leaf,'browser-temp','error-context.json'),{cookie:secret});
  await writePrivate(join(leaf,'component-failure.json'),{version:2,suite:'src/LicensePage.test.tsx',status:1,raw:secret,
    failedAssertions:[{index:4,status:'failed',title:componentTitle,category:'assertion',failureMessages:[secret]}]});
  const cases:CaseResult[]=[{id:'HAR-10',layer:'U',environment:'fixture',durationMs:100,outcome:'Passed',
    executionId:recorded.executionId,traceRunId:leafId,executionOutcome:'Failed'},
  {id:'HAR-11',layer:'U',environment:'fixture',durationMs:100,outcome:'Failed',reason:'COMPONENT',stage:'model-estimate',
    executionId:recorded.executionId,traceRunId:leafId,executionOutcome:'Failed'}];
  await test.step('Verify archive attachment portability',async()=>{
    await saveReport(root,rootId,cases,['HAR-10','HAR-11'],'unknown','all');
    const xml=await readFile(join(root,'junit.xml'),'utf8');
    expect(xml).toContain('name="magicstick-selected-regression" tests="2"');
    expect(xml).toContain('name="magicstick-executable-scenarios" tests="1" failures="1"');
    expect(xml).toContain('name="magicstick-test-steps" tests="3" failures="1" skipped="1"');
    expect(xml).toContain('name="stage" value="model-estimate"');
    expect(xml).toContain('name="parentStep" value="1"');
    expect(xml).toContain('time="1.337"');
    expect(xml).toContain('[[ATTACHMENT|report-artifacts/'+leafId+'/traces/'+recorded.executionId+'.json]]');
    const archive=join(root,'report-artifacts.tar.gz');expect((await lstat(archive)).mode&0o077).toBe(0);
    const members=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
    expect(members).toEqual(['summary.json','summary.txt','summary.html','junit.xml',
      'report-artifacts/'+leafId+'/traces/'+recorded.executionId+'.json',
      'report-artifacts/'+leafId+'/component-failure.json','report-artifacts.json']);
    for(const name of members) {
      const content=execFileSync('tar',['-xOzf',archive,name],{encoding:'utf8'});
      expect(content,name).not.toContain(secret);
    }
    const manifest=JSON.parse(await readFile(join(root,'report-artifacts.json'),'utf8'));
    expect(manifest).toMatchObject({traceFormat:'filtered-call-trace',rawPlaywrightTrace:false});
    const html=await readFile(join(root,'summary.html'),'utf8');
    expect(html).toContain('Verify archive attachment portability');expect(html).toContain('report-artifacts.tar.gz');
    expect(cases.map(item=>item.outcome)).toEqual(['Passed','Failed']);
  });
}));

test('HAR-10 HAR-11 isolated CI profiles retain failure diagnostics without private inputs or raw errors',async()=>isolated(async directory=>{
  for(const mode of ['selftest','phase4-fast','phase8-fast','phase2-fixtures','phase7-fixtures']) {
    const runId=newRunId(),run=join(directory,runId);await privateDirectory(run);
    const recorded=trace(runId);await saveExecutionTrace(run,recorded);
    await writePrivate(join(run,'journal.json'),{password:secret});
    await writePrivate(join(run,'browser-temp','error-context.json'),{cookie:secret});
    await writePrivate(join(run,'component-failure.json'),{version:2,suite:'src/LicensePage.test.tsx',status:1,raw:secret,
      failedAssertions:[{index:4,status:'failed',title:componentTitle,category:'assertion',failureMessages:[secret]}]});
    const result=await saveReport(run,runId,[{id:'UX-02',layer:'U',environment:'fixture',durationMs:1,outcome:'Failed',reason:'COMPONENT',
      executionId:recorded.executionId,traceRunId:runId,executionOutcome:'Failed'}],['UX-02'],'unknown',mode);
    expect(result.acceptable).toBe(false);expect(result.executionCounts.Failed).toBe(1);
    const archive=join(run,'report-artifacts.tar.gz');expect((await lstat(archive)).mode&0o077).toBe(0);
    const members=execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).trim().split('\n');
    expect(members).toEqual(['summary.json','summary.txt','summary.html','junit.xml',
      `report-artifacts/${runId}/traces/${recorded.executionId}.json`,
      `report-artifacts/${runId}/component-failure.json`,'report-artifacts.json']);
    for(const name of members)expect(execFileSync('tar',['-xOzf',archive,name],{encoding:'utf8'}),mode).not.toContain(secret);
    expect(await readFile(join(run,'summary.html'),'utf8')).toContain('report-artifacts.tar.gz');
  }
}));

test('HAR-11 archive creation refuses a preexisting symbolic link instead of writing outside the private report',async()=>isolated(async directory=>{
  const foreign=join(directory,'foreign'),run=join(directory,newRunId());await privateDirectory(run);await writePrivate(foreign,secret);
  await symlink(foreign,join(run,'report-artifacts.tar.gz'));
  await expect(saveReport(run,newRunId(),[{id:'HAR-10',layer:'U',durationMs:1,outcome:'Passed'}],['HAR-10'],'unknown','all'))
    .rejects.toMatchObject({code:'PRIVATE_FILE'});
  expect(await readFile(foreign,'utf8')).toBe(secret);
}));

test('HAR-10 reporter records handled negative steps truncation and secondary cleanup failures separately',()=>{
  const previous=process.env.REGRESSION_RUN_ID;process.env.REGRESSION_RUN_ID=newRunId();
  try {
    const reporter=new SafeReporter(),selected={title:'HAR-10 reporter records handled negative steps truncation and secondary cleanup failures separately',
      annotations:[],location:{file:fileURLToPath(import.meta.url),line:1,column:1}} as unknown as TestCase;
    const passed={status:'passed',retry:0,duration:4321,errors:[]} as unknown as TestResult;
    reporter.onBegin({} as FullConfig,{allTests:()=>[selected]} as Suite);reporter.onTestBegin(selected);
    for(let index=0;index<2003;index++) {
      const step={category:'expect',title:secret,duration:1,error:index===0?{message:secret}:undefined} as TestStep;
      reporter.onStepBegin(selected,passed,step);reporter.onStepEnd(selected,passed,step);
    }
    reporter.onTestEnd(selected,passed);
    const recorded=(reporter as unknown as {traces:ExecutionTrace[]}).traces[0]!;
    expect(recorded.steps).toHaveLength(2000);expect(recorded.omittedSteps).toBe(3);expect(recorded.durationMs).toBe(4321);
    expect(recorded.steps[0]).toMatchObject({outcome:'Passed',handledError:true});expect(JSON.stringify(recorded)).not.toContain(secret);
    const failed={...passed,status:'failed',errors:[{message:'Raw timeout '+secret},{message:new HarnessError('CLEANUP','Failed','cleanup').message}]} as TestResult;
    reporter.onTestEnd(selected,failed);
    const rows=(reporter as unknown as {cases:CaseResult[]}).cases;
    expect(rows.at(-1)).toMatchObject({outcome:'Failed',reason:'UNEXPECTED',recoveryRequired:true,executionOutcome:'Failed'});
    expect(JSON.stringify(rows)).not.toContain(secret);
    const blocked={...passed,status:'failed',errors:[{message:new HarnessError('PREREQUISITE').message}]} as TestResult,
      prerequisite={category:'test.step',title:secret,duration:1,error:blocked.errors[0]} as TestStep;
    reporter.onStepBegin(selected,blocked,prerequisite);reporter.onStepEnd(selected,blocked,prerequisite);
    reporter.onTestEnd(selected,blocked);
    expect((reporter as unknown as {traces:ExecutionTrace[]}).traces.at(-1)?.steps[0])
      .toMatchObject({outcome:'Blocked',reason:'PREREQUISITE'});
  }finally{if(previous===undefined)delete process.env.REGRESSION_RUN_ID;else process.env.REGRESSION_RUN_ID=previous;}
});
