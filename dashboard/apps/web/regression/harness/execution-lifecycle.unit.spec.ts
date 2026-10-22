import {test,expect} from '@playwright/test';
import type {FullConfig,FullResult,Suite,TestCase,TestResult} from '@playwright/test/reporter';
import {mkdtemp,rm,symlink,lstat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {assessCleanup,assessRunCleanup,attestCleanup,verifyReservationReleased} from '../core/cleanup-state.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {childEvidence} from '../core/campaign-evidence.ts';
import {supervisedProcess} from '../core/process-supervisor.ts';
import {executionBudget} from '../core/execution-budget.ts';
import {phase4Scenarios,scenarioGrep} from '../core/scenario-selection.ts';
import {phase4Requirements} from '../profiles/gpu-p0.ts';
import SafeReporter from '../reporter.ts';
import {HarnessError} from '../core/errors.ts';
import {interruptedEvidence} from '../core/interrupted-evidence.ts';
import {completeCases,saveReport} from '../core/report.ts';
import {KubernetesModelCleaner} from '../core/model-cleanup.ts';
import {LabLease,type Lease,type LeaseStore} from '../core/lease.ts';

const identity={applianceUid:'synthetic-appliance',nodeUids:['synthetic-node']};
async function fixture(action:(root:string)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'magicstick-lifecycle-'));
  try{await action(root);}finally{await rm(root,{recursive:true,force:true});}
}
async function run(root:string) {
  const id=newRunId(),directory=join(root,id);
  const journal=await ResourceJournal.create(join(directory,'journal.json'),id,identity.applianceUid);
  await writePrivate(join(directory,'runner-session.json'),{version:1,runId:id,targetUid:identity.applianceUid,state:'finished',processesStopped:true});
  return {id,directory,journal};
}

test('HAR-07 HAR-10 an open worker overrides an empty root and false report fence',async()=>fixture(async output=>{
  const {id,directory,journal}=await run(output),worker=await ResourceJournal.create(join(directory,'worker-14/journal.json'),newRunId(),identity.applianceUid);
  await worker.requested('model',worker.prefix+'owned');await worker.owned('model',worker.prefix+'owned','model-uid',1);
  await writePrivate(join(directory,'summary.json'),{version:2,runId:id,acceptable:false,recoveryFenceActive:false,cases:[
    {id:'HAR-10',outcome:'Failed',layer:'A',environment:'live',durationMs:0,reason:'MISSING_EVIDENCE'}]});
  const receipt=join(output,'phase-result.json');
  await writePrivate(receipt,{version:1,mode:'phase4-sharing',runId:id,directory,exitCode:1});
  const imported=await childEvidence({output,receipt,mode:'phase4-sharing',required:['HAR-10'],fixture:false});
  expect(journal.recoveryPlan()).toEqual([]);expect(imported.recoveryFence).toBe(true);
  expect(imported.cleanup).toMatchObject({state:'required',reason:'CLEANUP'});
}));

test('HAR-07 HAR-08 cleanup receipts require verification and are invalidated by a delayed writer',async()=>fixture(async output=>{
  const {directory}=await run(output),path=join(directory,'worker-1');
  const worker=await ResourceJournal.create(join(path,'journal.json'),newRunId(),identity.applianceUid);
  await worker.requested('model',worker.prefix+'rejected');await worker.rejected('model',worker.prefix+'rejected');
  expect((await assessCleanup(directory,true)).state).toBe('unknown');
  await attestCleanup(path,identity);expect((await assessCleanup(directory,true)).state).toBe('verified');
  await worker.requested('model',worker.prefix+'late');await worker.owned('model',worker.prefix+'late','late-uid',1);
  expect((await assessCleanup(directory,true)).state).toBe('required');
  await expect(attestCleanup(directory,identity)).rejects.toThrow('[CLEANUP]');
}));

test('HAR-07 running workers and symlink evidence never prove cleanup',async()=>fixture(async output=>{
  const {directory,id}=await run(output);
  expect((await assessCleanup(directory,false)).state).toBe('unknown');
  await writePrivate(join(directory,'runner-session.json'),{version:1,runId:id,targetUid:identity.applianceUid,state:'running',processesStopped:false});
  expect((await assessCleanup(directory,true)).state).toBe('unknown');
  await symlink(directory,join(directory,'worker-64'));
  expect((await assessCleanup(directory,true)).state).toBe('blocked');
}));

test('HAR-07 unreadable or malformed verification evidence blocks even an empty journal',async()=>fixture(async output=>{
  const {directory}=await run(output),proof=join(directory,'cleanup-verification.json');
  await writePrivate(proof,'{not-json');expect((await assessCleanup(directory,true)).state).toBe('blocked');
  await attestCleanup(directory,identity);await chmod(proof,0o644);
  expect((await assessCleanup(directory,true)).state).toBe('blocked');
}));

test('HAR-07 auxiliary model journals bind their Lease receipts without reusing the main owner',async()=>fixture(async output=>{
  const {directory}=await run(output),id=newRunId();
  await ResourceJournal.create(join(directory,`ollama-${id}.journal.json`),id,identity.applianceUid);
  await writePrivate(join(directory,`lease-${id}.json`),{version:1,runId:id,targetUid:identity.applianceUid,owner:id,leaseUid:'fixture-lease',state:'released'});
  expect((await assessCleanup(directory,true)).state).toBe('verified');
  await writePrivate(join(directory,`lease-${id}.json`),{version:1,runId:newRunId(),targetUid:identity.applianceUid,owner:id,leaseUid:'fixture-lease',state:'released'});
  expect((await assessCleanup(directory,true)).state).toBe('blocked');
}));

test('HAR-07 HAR-10 aggregate cleanup follows exact child receipts and rejects forged fixture exemptions',async()=>fixture(async output=>{
  const parent=join(output,newRunId()),child=await run(output);
  const manifest={version:1,children:[{runId:child.id,mode:'phase4-sharing',fixture:false}]};
  await writePrivate(join(parent,'child-runs.json'),manifest);
  expect((await assessRunCleanup(output,parent,true)).state).toBe('verified');
  await child.journal.requested('key',child.journal.prefix+'key');await child.journal.owned('key',child.journal.prefix+'key','key-uid');
  expect((await assessRunCleanup(output,parent,true)).state).toBe('required');
  await writePrivate(join(parent,'child-runs.json'),{...manifest,children:[{...manifest.children[0],fixture:true}]});
  expect((await assessRunCleanup(output,parent,true)).state).toBe('unknown');
}));

for(const outcome of ['acknowledged','lost-reply','rejected'] as const)
test(`HAR-07 an empty resource journal cannot hide a ${outcome} Lease acquisition`,async()=>fixture(async output=>{
  const {directory,id,journal}=await run(output);
  let value:Lease={apiVersion:'coordination.k8s.io/v1',kind:'Lease',metadata:{name:'lab-lock',namespace:'magicstick-regression',uid:'lease-uid',
    resourceVersion:'1',labels:{'regression.magicstick.dev/appliance-uid':identity.applianceUid}},spec:{holderIdentity:''}};
  const store:LeaseStore={read:async()=>structuredClone(value),replace:async next=>{
    if(outcome==='rejected')throw Error('Synthetic rejected CAS');
    value=structuredClone({...next,metadata:{...next.metadata,resourceVersion:String(Number(next.metadata.resourceVersion)+1)}});
    if(outcome==='lost-reply')throw Error('Synthetic lost reply');return structuredClone(value);
  }};
  const lease=new LabLease(store,id,identity.applianceUid,Date.now,120,{journal});
  if(outcome==='acknowledged')await lease.acquire(id);else await expect(lease.acquire(id)).rejects.toMatchObject({code:'LOCK_BUSY'});
  expect(journal.entries).toHaveLength(0);
  if(outcome==='rejected')expect((await assessCleanup(directory,true)).state).toBe('verified');
  else {
    expect((await assessCleanup(directory,true)).state).toBe('required');
    await expect(verifyReservationReleased(directory,identity,()=>store.read())).rejects.toMatchObject({code:'CLEANUP'});
    if(outcome==='acknowledged') {await lease.release();expect((await assessCleanup(directory,true)).state).toBe('verified');}
  }
}));

test('HAR-10 a global timeout after a prerequisite records the infrastructure failure and unfinished selection',async()=>fixture(async directory=>{
  const previous={...process.env},id=newRunId();
  try {
    process.env.REGRESSION_MODE='preflight';process.env.REGRESSION_RUN_ID=id;process.env.REGRESSION_RUN_DIR=directory;
    delete process.env.REGRESSION_SCENARIO_ID;delete process.env.REGRESSION_DISCOVER_ONLY;
    const specimen=(title:string):TestCase=>({id:title,title,annotations:[],location:{file:fileURLToPath(import.meta.url),line:1,column:1},
      titlePath:()=>['',title]} as unknown as TestCase);
    const [blocked,started,unstarted]=['HAR-01','HAR-02','HAR-03'].map(specimen) as [TestCase,TestCase,TestCase];
    const reporter=new SafeReporter();reporter.onBegin({} as FullConfig,{allTests:()=>[blocked,started,unstarted]} as Suite);
    reporter.onTestBegin(blocked);reporter.onTestEnd(blocked,{status:'failed',duration:1,retry:0,errors:[{message:new HarnessError('GPU_PROVIDER').message}]} as TestResult);
    reporter.onTestBegin(started);reporter.onError();await reporter.onEnd({status:'timedout'} as FullResult);
    const report=JSON.parse(await readPrivate(join(directory,'summary.json')));
    expect(report.cases).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'HAR-01',outcome:'Blocked',reason:'GPU_PROVIDER'}),
      expect.objectContaining({id:'HAR-02',outcome:'Failed',reason:'DEADLINE',stage:'runner-execution'}),
      expect.objectContaining({id:'HAR-03',outcome:'Blocked',reason:'DEPENDENCY',blockedBy:expect.objectContaining({kind:'failure',caseId:'HAR-10',reason:'DEADLINE'})}),
      expect.objectContaining({id:'HAR-10',outcome:'Failed',reason:'DEADLINE',stage:'runner-execution'}),
    ]));
  }finally{for(const name of Object.keys(process.env))if(!Object.hasOwn(previous,name))delete process.env[name];Object.assign(process.env,previous);}
}));

test('HAR-10 phase 4 discovery preserves the full variant and layer matrix exactly once',()=>{
  const evidence=phase4Requirements.filter(r=>r.environment==='live');
  const manifest={version:1,scenarios:[{id:'actual-playwright-id',title:'NVIDIA (last slot)',source:{file:'regression/hardware/sharing.e2e.spec.ts',line:1},evidence}]};
  expect(phase4Scenarios(manifest)).toHaveLength(1);
  expect(()=>phase4Scenarios({...manifest,scenarios:[{...manifest.scenarios[0],evidence:evidence.slice(1)}]})).toThrow('[CONFIG]');
  expect(()=>phase4Scenarios({...manifest,scenarios:[...manifest.scenarios,...manifest.scenarios]})).toThrow('[CONFIG]');
  expect(new RegExp(scenarioGrep(manifest.scenarios[0]!.title)).test('prefix NVIDIA (last slot)')).toBe(true);
  expect(executionBudget.cleanupMs).toBeLessThan(executionBudget.childTerminationMs);
  expect(executionBudget.childTerminationMs).toBeLessThan(executionBudget.outerTerminationMs);
  expect(executionBudget.outerTerminationMs).toBeLessThan(executionBudget.podTerminationSeconds*1000);
});

test('HAR-07 HAR-10 a real child receives timeout cancellation and finishes its teardown before the supervisor',async()=>{
  const child=supervisedProcess(process.execPath,['-e',"process.on('SIGINT',()=>setTimeout(()=>process.exit(0),30));setInterval(()=>{},50)"],
    {stdio:'ignore'},{timeoutMs:500,graceMs:500,drainMs:500});
  expect(await child.finished).toMatchObject({exitCode:1,timedOut:true,forced:false,processesStopped:true});
});

test('HAR-07 HAR-10 a real unresponsive child is killed only after its cleanup grace',async()=>{
  const child=supervisedProcess(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},50)"],
    {stdio:'ignore'},{timeoutMs:500,graceMs:100,drainMs:500});
  expect(await child.finished).toMatchObject({exitCode:1,timedOut:true,forced:true,processesStopped:true});
});

test('HAR-07 HAR-10 duplicate forwarded signals cannot skip the cleanup window',async()=>{
  const child=supervisedProcess(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},50)"],
    {stdio:'ignore'},{hardTimeoutMs:5000,graceMs:150,drainMs:300});
  await new Promise(resolve=>setTimeout(resolve,150));
  const start=Date.now();child.stop('SIGINT');child.stop('SIGINT');
  expect(await child.finished).toMatchObject({forced:true,processesStopped:true});
  expect(Date.now()-start).toBeGreaterThanOrEqual(130);
});

test('HAR-10 durable selection preserves completed evidence and attributes killed or unstarted scenarios',async()=>fixture(async directory=>{
  const previous={...process.env},runId=newRunId();
  try {
    process.env.REGRESSION_MODE='preflight';process.env.REGRESSION_RUN_ID=runId;process.env.REGRESSION_RUN_DIR=directory;
    delete process.env.REGRESSION_DISCOVER_ONLY;delete process.env.REGRESSION_SCENARIO_ID;
    const tests=['HAR-01','HAR-02','HAR-03'].map(title=>({id:title,title,annotations:[],location:{file:fileURLToPath(import.meta.url),line:1,column:1}} as unknown as TestCase));
    const reporter=new SafeReporter();
    reporter.onBegin({configFile:fileURLToPath(new URL('../playwright.config.ts',import.meta.url))} as FullConfig,{allTests:()=>tests} as Suite);
    reporter.onTestBegin(tests[0]!);reporter.onTestEnd(tests[0]!,{status:'passed',duration:1,retry:0,errors:[]} as unknown as TestResult);
    reporter.onTestBegin(tests[1]!);
    await (reporter as unknown as {writes:Promise<void>}).writes;
    const ledger=JSON.parse(await readPrivate(join(directory,'runner-evidence.json')));
    expect(ledger.scenarios.map((s:{state:string})=>s.state)).toEqual(['completed','running','selected']);
    const rows=await interruptedEvidence(directory,runId,'DEADLINE');
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({id:'HAR-01',outcome:'Passed'}),expect.objectContaining({id:'HAR-02',outcome:'Failed',reason:'DEADLINE'}),
      expect.objectContaining({id:'HAR-03',outcome:'Blocked',blockedBy:expect.objectContaining({caseId:'HAR-10',kind:'failure'})})]));
    expect(completeCases('phase4',rows,['SLOT-09']).find(c=>c.id==='SLOT-09'&&c.variant==='p4-last-slot-race'))
      .toMatchObject({outcome:'Blocked',reason:'DEPENDENCY',blockedBy:{caseId:'HAR-10',reason:'DEADLINE',stage:'runner-execution'}});
  }finally{for(const name of Object.keys(process.env))if(!Object.hasOwn(previous,name))delete process.env[name];Object.assign(process.env,previous);}
}));

test('HAR-07 HAR-10 a lost child completion receipt retains the allocated exact recovery journal',async()=>fixture(async output=>{
  const {directory,id,journal}=await run(output);
  await journal.requested('model',journal.prefix+'retained');await journal.owned('model',journal.prefix+'retained','owned-uid',1);
  const result=await childEvidence({output,receipt:join(output,'missing-receipt.json'),mode:'phase4-sharing',required:['SLOT-09'],fixture:false,expectedRunId:id});
  expect(result.result.runId).toBe(id);expect(result.result.directory).toBe(directory);
  expect(result.recoveryFence).toBe(true);expect(result.cleanup?.state).toBe('required');
  expect(result.report.cases).toContainEqual(expect.objectContaining({id:'HAR-10',outcome:'Failed',reason:'UNEXPECTED'}));
}));

test('HAR-07 SLOT-09 rejected creates are independently absent without granting deletion without a UID',async()=>fixture(async output=>{
  const {journal}=await run(output),name=journal.prefix+'rejected';
  await journal.requested('model',name);await journal.rejected('model',name);
  const cleaner=Object.create(KubernetesModelCleaner.prototype) as KubernetesModelCleaner;
  let reads=0;cleaner.find=async()=>{reads++;return null;};
  const adapter=cleaner.adapter(journal.prefix,async()=>({podCount:0,catalogCount:0}),async()=>{}),entry=journal.entries[0]!;
  await expect(adapter.verifyRemoved(entry)).resolves.toBe(true);expect(reads).toBe(1);
  await expect(adapter.removeIfUid(entry,'unowned-uid')).rejects.toMatchObject({code:'OWNERSHIP'});
  await expect(adapter.verifyRemoved({...entry,state:'requested'})).rejects.toMatchObject({code:'OWNERSHIP'});
  expect(reads).toBe(1);
}));

test('HAR-07 HAR-10 resource cleanup, export errors and historical failures have separate report meanings',async()=>fixture(async directory=>{
  const runId=newRunId(),rows=[{id:'HAR-10',layer:'A' as const,environment:'live' as const,outcome:'Failed' as const,durationMs:1,reason:'REPORT_EXPORT' as const,stage:'report-export' as const}];
  await saveReport(directory,runId,rows,['HAR-10'],'unknown','all',undefined,{cleanup:{state:'verified',checkedAt:new Date().toISOString()},recoveryFenceActive:false,recoveryAttempts:[]});
  const json=JSON.parse(await readPrivate(join(directory,'summary.json')));
  expect(json.acceptable).toBe(false);expect(json.recoveryFenceActive).toBe(false);expect(json.cleanup.state).toBe('verified');
  for(const name of ['summary.html','summary.txt','junit.xml'])expect(await readPrivate(join(directory,name))).toContain('verified');
}));

test('HAR-07 HAR-10 scenario hard limit cannot be extended by another graceful-stop window',async()=>{
  const child=supervisedProcess(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},50)"],
    {stdio:'ignore'},{hardTimeoutMs:150,graceMs:5000,drainMs:300});
  expect(await child.finished).toMatchObject({exitCode:1,timedOut:true,forced:true,processesStopped:true});
});

test('HAR-07 a real worker cannot write after its process group has been verified stopped',async()=>fixture(async output=>{
  const {directory}=await run(output);
  const marker=join(directory,'late.json'),fs=JSON.stringify(marker);
  const worker=`setTimeout(()=>require('node:fs').writeFileSync(${fs},'late'),500);setInterval(()=>{},50)`;
  const coordinator=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});setInterval(()=>{},50)`;
  const child=supervisedProcess(process.execPath,['-e',coordinator],{stdio:'ignore'},{hardTimeoutMs:150,drainMs:300});
  const result=await child.finished;expect(result.forced).toBe(true);
  // Platforms that retain an orphan zombie must keep the fence rather than
  // claiming it stopped. Either way, no live worker may produce a late write.
  await new Promise(resolve=>setTimeout(resolve,550));
  await expect(lstat(marker)).rejects.toMatchObject({code:'ENOENT'});
  expect((await assessCleanup(directory,result.processesStopped)).state).toBe(result.processesStopped?'verified':'unknown');
}));

test('HAR-07 HAR-10 coordinator exit does not shorten a still-running worker cleanup window',async()=>fixture(async directory=>{
  const marker=join(directory,'worker-cleanup.json');
  const worker=`setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'verified',{mode:0o600});process.exit(0)},300)`;
  const coordinator=`process.on('SIGINT',()=>process.exit(0));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'});setInterval(()=>{},50)`;
  const child=supervisedProcess(process.execPath,['-e',coordinator],{stdio:'ignore'},{timeoutMs:150,graceMs:1000,drainMs:10});
  const result=await child.finished;
  expect(await readPrivate(marker)).toBe('verified');expect(result.timedOut).toBe(true);
  if(result.processesStopped)expect(result.forced).toBe(false);
}));

test('HAR-08 HAR-10 a real Playwright teardown fixture retains its own budget after the test times out',async()=>fixture(async directory=>{
  const marker=join(directory,'cleanup-completed.json'),config=join(directory,'playwright.config.mjs');
  await writePrivate(config,`export default ${JSON.stringify({testDir:directory,testMatch:'owned.spec.mjs',outputDir:join(directory,'test-output'),timeout:60,globalTimeout:5000,workers:1,retries:0,reporter:'dot'})};`);
  await writePrivate(join(directory,'owned.spec.mjs'),`import {test as base} from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
    import {writeFile} from 'node:fs/promises';
    const test=base.extend({owned:[async({},use)=>{try{await use(true);}finally{await new Promise(r=>setTimeout(r,150));await writeFile(${JSON.stringify(marker)},'verified',{mode:0o600});}},{timeout:1000}]});
    test('synthetic body deadline',async({owned})=>{if(!owned)throw Error('fixture not entered');await new Promise(()=>{});});`);
  const child=supervisedProcess(process.execPath,[fileURLToPath(import.meta.resolve('@playwright/test/cli')),'test','--config',config],
    {stdio:'ignore'},{hardTimeoutMs:10_000,drainMs:500});
  expect(await child.finished).toMatchObject({exitCode:1,timedOut:false,processesStopped:true});
  await expect(lstat(marker),'The interrupted fixture must produce its cleanup receipt').resolves.toBeDefined();
  expect(await readPrivate(marker)).toBe('verified');
}));

test('HAR-10 a real Playwright global timeout after a prerequisite is exported as its own deadline failure',async()=>fixture(async directory=>{
  const runId=newRunId(),report=join(directory,'results'),config=join(directory,'playwright.config.mjs');
  await writePrivate(config,`export default ${JSON.stringify({testDir:directory,testMatch:'global.spec.mjs',outputDir:join(directory,'test-output'),timeout:10000,globalTimeout:2500,workers:1,retries:0,
    reporter:[[fileURLToPath(new URL('../reporter.ts',import.meta.url))]]})};`);
  const annotations=(id:string)=>JSON.stringify({annotation:[{type:'regression',description:JSON.stringify({id,layer:'U'})}]});
  await writePrivate(join(directory,'global.spec.mjs'),`import {test} from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
    import {HarnessError} from ${JSON.stringify(new URL('../core/errors.ts',import.meta.url).href)};
    test('HAR-01 prior prerequisite',${annotations('HAR-01')},async()=>{throw new HarnessError('GPU_PROVIDER')});
    test('HAR-02 interrupted scenario',${annotations('HAR-02')},async()=>{await new Promise(()=>{})});
    test('HAR-03 unstarted scenario',${annotations('HAR-03')},async()=>{});`);
  const child=supervisedProcess(process.execPath,[fileURLToPath(import.meta.resolve('@playwright/test/cli')),'test','--config',config],
    {stdio:'ignore',env:{...process.env,REGRESSION_MODE:'preflight',REGRESSION_RUN_ID:runId,REGRESSION_RUN_DIR:report,REGRESSION_SCENARIO_ID:'',REGRESSION_DISCOVER_ONLY:''}},
    {hardTimeoutMs:8000,graceMs:1000,drainMs:300});
  expect((await child.finished).exitCode).toBe(1);
  await expect(lstat(join(report,'summary.json')),'The interrupted reporter must export its exact failure evidence').resolves.toBeDefined();
  const value=JSON.parse(await readPrivate(join(report,'summary.json')));
  expect(value.cases.filter((c:{id:string;reason?:string})=>c.id==='HAR-02'&&c.reason==='UNEXPECTED')).toEqual([]);
  expect(value.cases).toEqual(expect.arrayContaining([
    expect.objectContaining({id:'HAR-01',outcome:'Blocked',reason:'GPU_PROVIDER'}),
    expect.objectContaining({id:'HAR-10',outcome:'Failed',reason:'DEADLINE',stage:'runner-execution'}),
    expect.objectContaining({id:'HAR-03',outcome:'Blocked',reason:'DEPENDENCY',blockedBy:expect.objectContaining({caseId:'HAR-10',reason:'DEADLINE',kind:'failure'})})]));
}));
