import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceJournal,newRunId,type CleanupAdapter,type ResourceKind} from '../core/journal.ts';
import {HarnessError} from '../core/errors.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {CleanupRecorder,readCleanupCapture,parseCleanupDiagnostic,runCleanupCaptures} from '../core/cleanup-diagnostic.ts';
import {KubernetesModelCleaner} from '../core/model-cleanup.ts';

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
