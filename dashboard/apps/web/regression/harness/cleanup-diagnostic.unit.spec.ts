import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ResourceJournal,newRunId,type CleanupAdapter,type ResourceKind} from '../core/journal.ts';
import {HarnessError} from '../core/errors.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const annotation=evidenceAnnotations({id:'HAR-07',layer:'U'});
let directory:string;
test.beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'cleanup-diagnostic-'));});
test.afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
async function owned() {
  const journal=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'fixture-appliance');
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
  expect(journal.cleanupFailures).toEqual([{kind:'model',operation:'lookup',reason:'API',stage:'model-route'}]);
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
