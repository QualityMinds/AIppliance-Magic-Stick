import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,delimiter} from 'node:path';
import {ResourceJournal,newRunId,type CleanupAdapter,type ResourceKind} from '../core/journal.ts';
import {HarnessError} from '../core/errors.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {CleanupRecorder,readCleanupCapture,parseCleanupDiagnostic,runCleanupCaptures} from '../core/cleanup-diagnostic.ts';
import {KubernetesModelCleaner} from '../core/model-cleanup.ts';
import {KubectlObserver,type KubeObject} from '../core/observer.ts';
import {KubernetesCommandError,kubernetesCommandFailure} from '../core/kubernetes-command.ts';
import {saveExecutionTrace} from '../core/execution-trace.ts';
import {saveReport} from '../core/report.ts';
import {publicResult} from '../core/kubernetes-progress.ts';

const annotation=evidenceAnnotations({id:'HAR-07',layer:'U'});
let directory:string;
test.beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'cleanup-diagnostic-'));});
test.afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function owned(base=directory) {
  const journal=await ResourceJournal.create(join(base,'journal.json'),newRunId(),'fixture-appliance');
  const name=journal.prefix+'model';await journal.requested('model',name);await journal.owned('model',name,'fixture-model-uid',2);
  return {journal,name};
}
function adapters(adapter:CleanupAdapter):Record<ResourceKind,CleanupAdapter> {
  return {model:adapter,app:adapter,key:adapter,identity:adapter};
}

test('HAR-11 kubectl classification retains protocol reasons but never raw stderr, bodies or invented conflicts',()=>{
  const secret='Bearer synthetic-private-token https://private.invalid/secret',conflict={commandFailure:'api',httpStatus:409,kubernetesReason:'Conflict',exitCode:1};
  expect(kubernetesCommandFailure(JSON.stringify({apiVersion:'v1',kind:'Status',status:'Failure',code:409,reason:'Conflict',message:secret,
    details:{name:secret}}),'',1,null)).toEqual(conflict);
  expect(kubernetesCommandFailure('',`Error from server (Conflict): ${secret}`,1,null)).toEqual(conflict);
  expect(kubernetesCommandFailure('',`Error from server (Forbidden): ${secret}`,1,null)).toMatchObject({httpStatus:403,kubernetesReason:'Forbidden'});
  expect(kubernetesCommandFailure('',`Error from server (ServerTimeout): ${secret}`,1,null)).toMatchObject({httpStatus:500,kubernetesReason:'ServerTimeout'});
  expect(kubernetesCommandFailure('',`Error from server (InternalError): ${secret}`,1,null)).toMatchObject({httpStatus:null,kubernetesReason:'InternalError'});
  expect(kubernetesCommandFailure(JSON.stringify({apiVersion:'meta.k8s.io/v1',kind:'Status',status:'Failure',code:502,reason:'InternalError',message:secret}),'',1,null))
    .toMatchObject({httpStatus:502,kubernetesReason:'InternalError'});
  for(const text of [secret+' 409 Conflict','Error from server (PrivateToken): '+secret,
    'Untrusted log\nError from server (Conflict): '+secret,JSON.stringify({message:'Error from server (Conflict): '+secret})])
    expect(kubernetesCommandFailure('',text,1,null)).toEqual({commandFailure:'unknown',httpStatus:null,exitCode:1});
  expect(kubernetesCommandFailure(JSON.stringify({apiVersion:'v1',kind:'Status',status:'Failure',code:403,reason:'Conflict'}),
    'Error from server (Conflict): '+secret,1,null)).toEqual({commandFailure:'unknown',httpStatus:null,exitCode:1});
  expect(kubernetesCommandFailure('','Error from server (Conflict): '+secret,137,'SIGKILL'))
    .toEqual({commandFailure:'signal',httpStatus:null,exitCode:137,processSignal:'SIGKILL'});
  expect(kubernetesCommandFailure('','Error from server (Conflict): '+secret,2,null))
    .toEqual({commandFailure:'unknown',httpStatus:null,exitCode:2});
  const failure=new KubernetesCommandError({...conflict,commandFailure:'api',kubernetesReason:'Conflict',raw:secret} as never);
  expect(JSON.stringify(failure)).not.toContain(secret);expect(failure.message).not.toContain(secret);
  expect(()=>new KubernetesCommandError({commandFailure:'api',httpStatus:403,kubernetesReason:'Conflict'})).toThrow('[CONFIG]');
});

test('HAR-11 real kubectl subprocess boundary exports safe API, timeout and exit diagnostics only',async()=>{
  class Reader extends KubectlObserver {read(){return this.command(['get','--raw','/synthetic'], '{}');}}
  const path=process.env.PATH,shim=join(directory,'kubectl'),secret='synthetic-body-token-never-export';
  const reader=new Reader('synthetic-kubeconfig',1000);
  try {
    process.env.PATH=directory+delimiter+(path??'');
    for(const [output,stderr,expected] of [
      ['',`Error from server (Conflict): ${secret}`,{commandFailure:'api',httpStatus:409,kubernetesReason:'Conflict'}],
      [JSON.stringify({apiVersion:'v1',kind:'Status',status:'Failure',code:403,reason:'Forbidden',message:secret}),'',
        {commandFailure:'api',httpStatus:403,kubernetesReason:'Forbidden'}],
      [secret,secret+' 409 Conflict',{commandFailure:'unknown',httpStatus:null}],
    ] as const) {
      await writeFile(shim,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(stderr)});process.exitCode=1;});\n`,{mode:0o700});
      const error=await reader.read().catch(error=>error);
      expect(error).toBeInstanceOf(KubernetesCommandError);expect(error.diagnostic).toMatchObject(expected);
      expect(JSON.stringify(error)).not.toContain(secret);expect(error.message).not.toContain(secret);
    }
    await writeFile(shim,`#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{}'));\n`,{mode:0o700});
    expect(await reader.read()).toBe('{}');
    await writeFile(shim,`#!${process.execPath}\nprocess.stdin.resume();setInterval(()=>{},1000);\n`,{mode:0o700});
    await expect(reader.read()).rejects.toMatchObject({diagnostic:{commandFailure:'timeout',httpStatus:null}});
    await rm(shim);
    process.env.PATH=directory;
    await expect(reader.read()).rejects.toMatchObject({diagnostic:{commandFailure:'spawn',httpStatus:null}});
  }finally{if(path===undefined)delete process.env.PATH;else process.env.PATH=path;}
});

test('HAR-07 HAR-10 HAR-11 conflict details survive checkpoints and all exports without changing results or leaking bodies',async()=>{
  const {journal}=await owned(),recorder=new CleanupRecorder(journal,journal.entries[0]!),secret='synthetic-never-export';
  await recorder.record({operation:'remove',state:'failed',reason:'CONFLICT',stage:'cleanup',attempt:1,retrying:true,
    method:'DELETE',endpoint:'model-activation',requestAttempted:true,commandFailure:'api',httpStatus:409,kubernetesReason:'Conflict',exitCode:1});
  for(let i=0;i<25;i++)await recorder.record({operation:'verify',state:'running',podCount:i,catalogCount:0});
  await recorder.failure('remove',new HarnessError('CLEANUP','Failed','cleanup',{reason:'CONFLICT',stage:'cleanup'}));
  const capture=recorder.snapshot()!,executionId='e'.repeat(24);
  expect(capture.firstFailure).toMatchObject({httpStatus:409,kubernetesReason:'Conflict',attempt:1,retrying:true});
  expect((await readCleanupCapture(recorder.filename)).firstFailure).toEqual(capture.firstFailure);
  const safe=parseCleanupDiagnostic({...capture,raw:secret,history:capture.history.map(o=>({...o,stderr:secret}))});
  const row={id:'HAR-03',variant:'offline-busy-abort' as const,layer:'A' as const,environment:'live' as const,outcome:'Failed' as const,
    durationMs:1,reason:'CLEANUP' as const,causeReason:'CONFLICT' as const,stage:'cleanup' as const,executionId,traceRunId:journal.runId,cleanupDiagnostic:safe};
  await saveExecutionTrace(directory,{version:1,runId:journal.runId,executionId,outcome:'Failed',durationMs:1,steps:[],cleanupDiagnostics:[safe]});
  await saveReport(directory,journal.runId,[row],['HAR-03'],'unknown','selftest');
  const publicView=publicResult({cases:[row]},{});
  expect(publicView.cases[0]?.diagnostics?.join('\n')).toContain('Kubernetes Conflict');
  expect(publicView.cases[0]?.diagnostics?.join('\n')).toContain('HTTP 409');
  for(const file of ['summary.json','summary.html','summary.txt','junit.xml',`report-artifacts/${journal.runId}/traces/${executionId}.json`]) {
    const text=await readPrivate(join(directory,file));
    expect(text).not.toContain(secret);
    expect(text).toContain(file.endsWith('.json')?'"httpStatus": 409':'409');
    expect(text).toContain('Conflict');
  }
  // A rejected attempt followed by verified cleanup remains a Passed resource
  // diagnostic; retaining its first failed request does not invent a test error.
  await recorder.complete();expect(recorder.snapshot()?.state).toBe('passed');
  expect(recorder.snapshot()?.firstFailure?.httpStatus).toBe(409);
  expect(publicView.cases[0]?.outcome).toBe('Failed');
  const retry=await owned(join(directory,'retry'));
  class Cleaner extends KubernetesModelCleaner {
    requests=0;
    current:KubeObject|null={metadata:{name:retry.name,namespace:'ai-system',uid:'fixture-model-uid',generation:2,
      resourceVersion:'28',labels:{'app.kubernetes.io/managed-by':'ai-appliance-dashboard'}},spec:{type:'local',targetNamespace:'ai'}};
    override async find(){return structuredClone(this.current);}
    protected override async command(_args:string[],input?:string) {
      expect(JSON.parse(input!).preconditions).toEqual({uid:'fixture-model-uid',resourceVersion:this.current!.metadata.resourceVersion});
      if(++this.requests===1) {
        this.current!.metadata.resourceVersion='29';
        throw new KubernetesCommandError({commandFailure:'api',httpStatus:409,kubernetesReason:'Conflict',exitCode:1});
      }
      this.current=null;return '{}';
    }
  }
  const cleaner=new Cleaner('unused','ai-system');
  await retry.journal.cleanup(adapters(cleaner.adapter(retry.journal.prefix,async()=>({podCount:0,catalogCount:0}))),async()=>{});
  expect(cleaner.requests).toBe(2);expect(retry.journal.recoveryPlan()).toEqual([]);
  expect(retry.journal.cleanupFailures).toEqual([]);expect(retry.journal.entries[0]?.state).toBe('removed');
  expect(retry.journal.diagnostics[0]).toMatchObject({state:'passed',firstFailure:{httpStatus:409,kubernetesReason:'Conflict',retrying:true}});
  expect(JSON.stringify(retry.journal.diagnostics)).not.toContain('fixture-model-uid');
});

test('HAR-07 cleanup retains exact safe lookup/ownership/removal/verification causes without deleting a foreign UID',annotation,async()=>{
  const {journal}=await owned();let present=true,removed=0,foreign=false,failed='lookup';
  const adapter:CleanupAdapter={lookup:async()=>{
    if(failed==='lookup')throw new HarnessError('API','Failed','model-route');
    return present?{uid:foreign?'foreign-uid':'fixture-model-uid'}:null;
  },removeIfUid:async(entry,uid)=>{
    expect(entry.generation).toBe(2);expect(uid).toBe('fixture-model-uid');
    if(failed==='remove')throw new HarnessError('API','Failed','cleanup');
    removed++;present=false;
  },verifyRemoved:async()=>failed!=='verify'&&!present};
  const clean=()=>journal.cleanup(adapters(adapter),async()=>{});
  await expect(clean()).rejects.toMatchObject({code:'CLEANUP',stage:'model-route'});
  await expect(clean()).rejects.toMatchObject({causeReason:'API',causeStage:'model-route'});
  expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'lookup',reason:'API',stage:'model-route'}]);
  const first=journal.diagnostics[0]!;
  expect(first.firstFailure).toMatchObject({operation:'lookup',reason:'API',stage:'model-route'});
  expect(await readCleanupCapture(join(directory,'cleanup-diagnostics',first.scope+'.json'))).toEqual(first);
  failed='';foreign=true;
  await expect(clean()).rejects.toMatchObject({code:'CLEANUP'});expect(removed).toBe(0);
  expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'lookup',reason:'OWNERSHIP'}]);
  foreign=false;failed='remove';
  await expect(clean()).rejects.toMatchObject({code:'CLEANUP'});expect(removed).toBe(0);
  expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'remove',reason:'API',stage:'cleanup'}]);
  failed='verify';await expect(clean()).rejects.toMatchObject({code:'CLEANUP'});expect(removed).toBe(1);
  expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'verify',reason:'CLEANUP'}]);
  const resumed=await ResourceJournal.resume(journal.filename,'fixture-appliance');
  expect(resumed.cleanupFailures).toEqual(journal.cleanupFailures);
  failed='';await resumed.cleanup(adapters(adapter),async()=>{});
  expect(removed).toBe(1);expect(resumed.cleanupFailures).toEqual([]);expect(resumed.entries[0]?.state).toBe('removed');
  await resumed.cleanup(adapters(adapter),async()=>{});expect(removed).toBe(1);
  expect((await ResourceJournal.resume(journal.filename,'fixture-appliance')).cleanupFailures).toEqual([]);
  expect(resumed.diagnostics[0]?.firstFailure?.reason).toBe('API');
  expect(resumed.diagnostics[0]?.state).toBe('passed');
  expect(JSON.stringify(journal.diagnostics)).not.toContain('fixture-model-uid');
  expect(JSON.stringify(journal.diagnostics)).not.toContain(journal.entries[0]!.name);

  const pending=await owned(join(directory,'pending'));
  const cleaner=Object.assign(Object.create(KubernetesModelCleaner.prototype),{find:async()=>null}) as KubernetesModelCleaner;
  const waiting=cleaner.adapter(pending.journal.prefix,async()=>({podCount:1,catalogCount:0}),async()=>{},{timeoutMs:30,intervalMs:1});
  await expect(pending.journal.cleanup(adapters(waiting),async()=>{})).rejects.toMatchObject({code:'CLEANUP',causeReason:'DEADLINE'});
  expect(pending.journal.diagnostics[0]?.firstFailure).toMatchObject({operation:'verify',reason:'DEADLINE',exists:false,podCount:1,catalogCount:0,timeoutMs:30});
  cleaner.find=async()=>{throw new HarnessError('API','Failed','cleanup');};
  await expect(pending.journal.cleanup(adapters(waiting),async()=>{})).rejects.toMatchObject({causeReason:'API'});
  // A failed read is not an independent proof that no Pod remains.
  expect(pending.journal.diagnostics[0]?.history.at(-1)?.reason).toBe('API');
  cleaner.find=async()=>null;
  const unreadable=cleaner.adapter(pending.journal.prefix,async()=>{throw new HarnessError('API','Failed','cleanup');});
  await expect(pending.journal.cleanup(adapters(unreadable),async()=>{})).rejects.toMatchObject({causeReason:'API'});
  expect(pending.journal.diagnostics[0]?.history.at(-1)).toMatchObject({exists:null,podCount:null,catalogCount:null,reason:'API'});
});

test('HAR-07 guard and raw cleanup errors stay fixed vocabulary and copied diagnostics cannot edit the receipt',annotation,async()=>{
  const {journal}=await owned(),privateText='Bearer synthetic-private-token at https://private-host.invalid/internal';
  let touches=0;
  const adapter:CleanupAdapter={lookup:async()=>{touches++;throw new Error(privateText);},removeIfUid:async()=>{},verifyRemoved:async()=>false};
  await expect(journal.cleanup(adapters(adapter),async()=>{throw new HarnessError('LOCK_LOST','Blocked','cleanup');}))
    .rejects.toMatchObject({code:'CLEANUP',outcome:'Failed'});
  expect(touches).toBe(0);expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'guard',reason:'LOCK_LOST',stage:'cleanup'}]);
  await expect(journal.cleanup(adapters(adapter),async()=>{})).rejects.toMatchObject({code:'CLEANUP'});
  const expected=[{kind:'model',operation:'lookup',reason:'UNEXPECTED'}];expect(journal.cleanupFailures).toEqual(expected);
  expect(await readPrivate(journal.filename)).not.toContain(privateText);
  journal.entries[0]!.cleanupFailure!.operation='remove';journal.cleanupFailures[0]!.reason='API';
  expect(journal.cleanupFailures).toEqual(expected);
  expect(JSON.stringify(journal.cleanupFailures)).not.toMatch(/uid|name|token|private-host/);
  const d=journal.diagnostics[0]!;
  expect(parseCleanupDiagnostic({...d,token:privateText,history:d.history.map(o=>({...o,headers:privateText,url:privateText}))})).toEqual(d);
  expect(JSON.stringify(d)).not.toContain(privateText);
  expect(()=>parseCleanupDiagnostic({...d,history:[{...d.history[0],podCount:-1}]})).toThrow('[CONFIG]');
  const recorder=new CleanupRecorder(journal,journal.entries[0]!);
  await recorder.record({operation:'verify',state:'running',podCount:2,catalogCount:0});
  for(let i=0;i<20;i++)await recorder.record({operation:'verify',state:'running',podCount:2,catalogCount:0});
  const captures=await runCleanupCaptures(directory,journal.runId);
  expect(captures.diagnostics[0]?.history.length).toBeLessThanOrEqual(12);
  expect(captures.diagnostics[0]?.omittedObservations).toBeGreaterThan(0);
  expect(captures.diagnostics[0]?.firstFailure?.reason).toBe('LOCK_LOST');
  const observe=recorder.begin();await observe({operation:'verify',state:'running',podCount:1,catalogCount:0});
  await recorder.failure('verify',new HarnessError('DEADLINE','Failed','cleanup'));
  const terminal=recorder.snapshot();
  await observe({operation:'verify',state:'passed',podCount:0,catalogCount:0});expect(recorder.snapshot()).toEqual(terminal);
  const retry=recorder.begin();await retry({operation:'verify',state:'running',podCount:1,catalogCount:0});
  await observe({operation:'verify',state:'passed',podCount:0,catalogCount:0});
  expect(recorder.snapshot()?.state).toBe('running');expect(recorder.snapshot()?.firstFailure?.reason).toBe('LOCK_LOST');
  await recorder.complete();const completed=recorder.snapshot();
  await retry({operation:'verify',state:'running',podCount:2,catalogCount:0});expect(recorder.snapshot()).toEqual(completed);
  const worker=await owned(join(directory,'worker-1'));
  const workerCapture=new CleanupRecorder(worker.journal,worker.journal.entries[0]!);
  await workerCapture.record({operation:'verify',state:'running',podCount:1,catalogCount:0});
  await symlink(directory,join(directory,'worker-2'));
  const foreign=new CleanupRecorder({filename:join(directory,'foreign-journal.json'),runId:newRunId()},journal.entries[0]!);
  await foreign.record({operation:'guard',state:'running'});
  const interrupted=await runCleanupCaptures(directory,journal.runId);
  expect(interrupted.unavailable).toBe(2);expect(interrupted.diagnostics).toHaveLength(2);
  expect(interrupted.diagnostics.find(d=>d.ownerRunId===worker.journal.runId)).toMatchObject({runId:journal.runId,kind:'model'});
});

test('HAR-07 resumed optional cleanup details reject unknown operations, stages, raw bodies and impossible states',annotation,async()=>{
  const {journal}=await owned();
  const data=JSON.parse(await readPrivate(journal.filename)),entry=data.entries[0];entry.state='blocked';
  const valid={operation:'lookup',reason:'API',stage:'cleanup'};
  for(const change of [{...valid,operation:'shell'},{...valid,reason:'raw response'},{...valid,stage:'private-host'},
    {...valid,message:'Bearer private'},null,[]]) {
    entry.cleanupFailure=change;await writePrivate(journal.filename,data);
    await expect(ResourceJournal.resume(journal.filename,'fixture-appliance')).rejects.toMatchObject({code:'OWNERSHIP'});
  }
  entry.cleanupFailure=valid;await writePrivate(journal.filename,data);
  expect((await ResourceJournal.resume(journal.filename,'fixture-appliance')).cleanupFailures).toEqual([{kind:'model',...valid}]);
  entry.state='owned';await writePrivate(journal.filename,data);
  await expect(ResourceJournal.resume(journal.filename,'fixture-appliance')).rejects.toMatchObject({code:'OWNERSHIP'});
  delete entry.cleanupFailure;await writePrivate(journal.filename,data);
  expect((await ResourceJournal.resume(journal.filename,'fixture-appliance')).cleanupFailures).toEqual([]);
});

test('HAR-07 persistence failure keeps an in-memory fence and a later verified cleanup can persist again',annotation,async()=>{
  const {journal}=await owned();let present=true,removed=0;
  const adapter:CleanupAdapter={lookup:async()=>present?{uid:'fixture-model-uid'}:null,
    removeIfUid:async()=>{removed++;present=false;},verifyRemoved:async()=>!present};
  // A directory at the exact receipt filename makes atomic persistence fail;
  // recovery must not treat a deleted object as an excuse to clear the fence.
  await rm(journal.filename);await mkdir(journal.filename,{mode:0o700});
  await expect(journal.cleanup(adapters(adapter),async()=>{})).rejects.toMatchObject({code:'CLEANUP'});
  expect(journal.entries[0]?.state).toBe('blocked');expect(journal.cleanupFailures)
    .toEqual([{kind:'model',operation:'persist',reason:'PRIVATE_FILE'}]);expect(removed).toBe(1);
  await rm(journal.filename,{recursive:true});await journal.cleanup(adapters(adapter),async()=>{});
  expect(removed).toBe(1);expect(journal.cleanupFailures).toEqual([]);
  expect((await ResourceJournal.resume(journal.filename,'fixture-appliance')).entries[0]?.state).toBe('removed');
});

test('HAR-07 foundation preserves the scenario failure and saves safe resource diagnostics before retaining its Lease',annotation,async()=>{
  const {journal}=await owned();let released=false;
  const adapter:CleanupAdapter={lookup:async()=>{throw new HarnessError('API','Failed','model-route');},
    removeIfUid:async()=>{throw new Error('Must not remove after a failed read');},verifyRemoved:async()=>false};
  const live=Object.assign(Object.create(LiveFoundation.prototype),{acquired:true,journal,journals:[journal],restorations:[],
    cleanup:()=>journal.cleanup(adapters(adapter),async()=>{}),heartbeat:{stop:async()=>{}},
    lease:{release:async()=>{released=true;}},context:{close:async()=>{}}}) as LiveFoundation;
  await expect(withCleanup(async()=>{throw new HarnessError('DEADLINE','Failed','model-inference');},()=>live.close()))
    .rejects.toMatchObject({code:'DEADLINE',stage:'model-inference'});
  const report=JSON.parse(await readPrivate(join(directory,'cleanup-failure.json')));
  expect(report.cleanupFailures).toEqual([{kind:'model',operation:'lookup',reason:'API',stage:'model-route'}]);
  expect(report.failures).toEqual([{reason:'CLEANUP',stage:'model-route'}]);expect(released).toBe(false);
});
