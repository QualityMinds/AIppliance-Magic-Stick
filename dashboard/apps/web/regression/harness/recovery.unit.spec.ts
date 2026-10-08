import {test,expect} from '@playwright/test';
import {mkdtemp,rm,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AutomaticRecovery,campaignRecoveryLease,type RecoveryAdapters} from '../core/automatic-recovery.ts';
import {LabLease,type Lease,type LeaseStore} from '../core/lease.ts';
import {HeartbeatLoop,bounded} from '../core/run-lifecycle.ts';
import {runnerSession,recordedLeaseSession} from '../core/runner-session.ts';
import {ResourceJournal,newRunId,type CleanupAdapter,type ResourceKind} from '../core/journal.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';
import {MutationNotSubmitted} from '../core/browser-action.ts';
import type {LabRegistration} from '../core/lab-policy.ts';
import type {KubeObject} from '../core/observer.ts';

const registration:LabRegistration={version:1,kind:'disposable-regression-lab',policyVersion:1,
  id:'11111111-1111-4111-8111-111111111111',applianceUid:'fixture-appliance',nodeUids:['fixture-node'],
  dashboardUrl:'https://dashboard.example.invalid',identityUrl:'https://identity.example.invalid',createdAt:new Date().toISOString()};
class Store implements LeaseStore {
  replacements=0;
  constructor(public value:Lease) {}
  async read(){return structuredClone(this.value);}
  async replace(value:Lease) {
    if(value.metadata.resourceVersion!==this.value.metadata.resourceVersion)throw new Error('CAS conflict');
    this.replacements++;this.value=structuredClone({...value,metadata:{...value.metadata,resourceVersion:String(this.replacements+1)}});
    return this.read();
  }
}
async function fixture(directory:string) {
  const root=join(directory,'runs'),runId=newRunId(),path=join(root,runId),journal=await ResourceJournal.create(join(path,'journal.json'),runId,registration.applianceUid);
  const updatedAt=new Date(Date.now()-600_000).toISOString();
  await writePrivate(join(path,'runner-session.json'),{version:1,runId,targetUid:registration.applianceUid,state:'finished',updatedAt,interrupted:true});
  const original:KubeObject={metadata:{name:'optional-fixture',namespace:'ai-system',uid:'fixture-module',generation:1},
    spec:{module:'optional-fixture',enabled:false,parameters:{},applianceRef:{name:'local',namespace:'ai-system'}}};
  const store=new Store({apiVersion:'coordination.k8s.io/v1',kind:'Lease',metadata:{name:'lab-lock',namespace:'magicstick-regression',uid:'fixture-lease',resourceVersion:'1',
    labels:{'regression.magicstick.dev/appliance-uid':registration.applianceUid},annotations:{'regression.magicstick.dev/run-id':runId}},
  spec:{holderIdentity:runId,renewTime:updatedAt,leaseDurationSeconds:120}});
  const resources=new Map<string,string>(),deleted:string[]=[],module={current:structuredClone(original),writes:0};
  const adapters:RecoveryAdapters={store,verifyTarget:async()=>{},cancel:async()=>{},
    cleanup:()=>Object.fromEntries(['model','app','key','identity'].map(kind=>[kind,{lookup:async entry=>{
      const uid=resources.get(entry.name);return uid?{uid}:null;
    },removeIfUid:async(entry,uid)=>{if(resources.get(entry.name)!==uid)throw new Error('UID replaced');resources.delete(entry.name);deleted.push(entry.name);},
    verifyRemoved:async entry=>!resources.has(entry.name)} satisfies CleanupAdapter])) as Record<ResourceKind,CleanupAdapter>,
    module:(_original,guard)=>({read:async()=>structuredClone(module.current),set:async(enabled,parameters)=>{
      await guard();module.writes++;module.current={...module.current,metadata:{...module.current.metadata,generation:module.current.metadata.generation!+1},
        spec:{...module.current.spec,enabled,parameters}};
    }}),sharing:()=>{throw new Error('No sharing fixture');}};
  return {root,runId,path,journal,store,resources,deleted,module,original,adapters};
}
async function isolated(action:(directory:string)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'runner-recovery-'));
  try {await action(directory);}finally {await rm(directory,{recursive:true,force:true});}
}

test('HAR-04 background heartbeat renews during idle browser waits and sticky loss fences later writes',async()=>{
  let count=0,fail=false;
  const loop=new HeartbeatLoop(async()=>{if(fail)throw new Error('Heartbeat failed');count++;},5).start();
  await expect.poll(()=>count,{timeout:2000}).toBeGreaterThanOrEqual(2);
  fail=true;await expect.poll(()=>{try{loop.check();return false;}catch{return true;}},{timeout:2000}).toBe(true);
  fail=false;await expect(loop.tick()).rejects.toMatchObject({code:'LOCK_LOST'});
  await loop.stop();const stopped=count;await new Promise(resolve=>setTimeout(resolve,20));expect(count).toBe(stopped);
});
test('HAR-04 heartbeat and maintenance reservation serialize lease CAS writes',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';
  const owner=new LabLease(f.store,newRunId(),registration.applianceUid,Date.now,120);await owner.acquire(f.runId);
  await Promise.all([owner.heartbeat(),owner.reserveOfflineWindow(2100)]);expect(f.store.value.spec.leaseDurationSeconds).toBe(2100);
  await Promise.all([owner.heartbeat(),owner.finishOfflineWindow()]);await owner.release();expect(f.store.value.spec.holderIdentity).toBe('');
}));
test('HAR-07 a new lock owner never retains a previous run annotation',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';const ownerId=newRunId();
  const owner=new LabLease(f.store,ownerId,registration.applianceUid,Date.now,120);await owner.acquire();
  expect(f.store.value.metadata.annotations?.['regression.magicstick.dev/run-id']).toBe(ownerId);await owner.release();
}));
test('HAR-04 reserved physical outages suspend network heartbeats without removing the expiry fence',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';let now=Date.now(),offline=false,reads=0;
  const store:LeaseStore={read:async()=>{reads++;if(offline)throw new Error('Expected appliance outage');return f.store.read();},replace:value=>f.store.replace(value)};
  const owner=new LabLease(store,newRunId(),registration.applianceUid,()=>now,120);await owner.acquire(f.runId);
  await owner.reserveOfflineWindow(2100);offline=true;const before=reads;now+=300_000;
  await owner.backgroundHeartbeat();expect(reads).toBe(before);
  offline=false;await owner.finishOfflineWindow();await owner.backgroundHeartbeat();await owner.release();
  const expired=new LabLease(store,newRunId(),registration.applianceUid,()=>now,120);await expired.acquire(f.runId);
  await expired.reserveOfflineWindow(2100);offline=true;now+=2_100_000;
  await expect(expired.backgroundHeartbeat()).rejects.toMatchObject({code:'LOCK_LOST'});
  offline=false;await expect(expired.heartbeat()).rejects.toMatchObject({code:'LOCK_LOST'});
}));
test('HAR-09 missing response has a bounded deadline, cancellation and exact stage',async()=>{
  let cancelled=0;
  await expect(bounded(()=>new Promise(()=>{}),10,'model-update',async()=>{cancelled++;})).rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'model-update'});
  expect(cancelled).toBe(1);
});
test('HAR-09 cancellation cannot hang the deadline or turn a late completion into success',async()=>{
  let resolveAction:()=>void=()=>{};
  await expect(bounded(()=>new Promise<void>(resolve=>{resolveAction=resolve;}),10,'model-update',async()=>{resolveAction();}))
    .rejects.toMatchObject({code:'DEADLINE',outcome:'Failed'});
  const before=Date.now();
  await expect(bounded(()=>new Promise<void>(()=>{}),10,'cleanup',()=>new Promise<void>(()=>{})))
    .rejects.toMatchObject({code:'DEADLINE',stage:'cleanup'});
  expect(Date.now()-before).toBeLessThan(2500);
});
test('HAR-07 parent liveness receipt is private lifecycle evidence, not a successful test result',async()=>isolated(async directory=>{
  const session=await runnerSession(directory,newRunId(),'fixture-appliance');await session.finish(true);
  const value=JSON.parse(await readPrivate(join(directory,'runner-session.json')));
  expect(value).toMatchObject({state:'finished',interrupted:true});expect(value).not.toHaveProperty('outcome');
  expect((await lstat(join(directory,'runner-session.json'))).mode&0o077).toBe(0);
}));
test('HAR-07 setup leases always have an exact private journal and release idempotently',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';
  const reservation=await recordedLeaseSession(f.store,f.root,registration.applianceUid);
  try {
    expect(f.store.value.spec.holderIdentity).toBe(reservation.journal.runId);
    expect(f.store.value.metadata.annotations?.['regression.magicstick.dev/run-id']).toBe(reservation.runId);
    expect((await ResourceJournal.resume(reservation.journal.filename,registration.applianceUid)).entries).toEqual([]);
    await reservation.guard();
  }finally {await reservation.close();}
  await reservation.close();expect(f.store.value.spec.holderIdentity).toBe('');
  expect(JSON.parse(await readPrivate(join(reservation.directory,'runner-session.json')))).toMatchObject({state:'finished'});
}));
test('HAR-07 an interrupted setup lease is recoverable without adopting existing definitions',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';
  const reservation=await recordedLeaseSession(f.store,f.root,registration.applianceUid);
  try {
    await reservation.session.finish(true);
    f.store.value.spec.renewTime=new Date(Date.now()-600_000).toISOString();
    const foreign='existing-model';f.resources.set(foreign,'not-owned');
    await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
    expect(f.store.value.spec.holderIdentity).toBe('');expect(f.deleted).toEqual([]);expect(f.resources.get(foreign)).toBe('not-owned');
    await expect(reservation.guard()).rejects.toMatchObject({code:'LOCK_LOST'});
  }finally {await reservation.close().catch(()=>{});}
}));
test('HAR-07 a lost acquisition acknowledgement still leaves the exact recoverable setup journal',async()=>isolated(async directory=>{
  const f=await fixture(directory);f.store.value.spec.holderIdentity='';let reads=0;
  const store:LeaseStore={read:async()=>{if(++reads===2)throw new Error('Synthetic lost acknowledgement');return f.store.read();},replace:value=>f.store.replace(value)};
  await expect(recordedLeaseSession(store,f.root,registration.applianceUid)).rejects.toMatchObject({code:'LOCK_LOST'});
  const runId=f.store.value.metadata.annotations?.['regression.magicstick.dev/run-id'];expect(runId).toBe(f.store.value.spec.holderIdentity);
  expect(JSON.parse(await readPrivate(join(f.root,runId!,'runner-session.json')))).toMatchObject({state:'finished',interrupted:true});
  f.store.value.spec.renewTime=new Date(Date.now()-600_000).toISOString();
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
  expect(f.store.value.spec.holderIdentity).toBe('');expect(f.deleted).toEqual([]);
}));
test('HAR-07 automatic recovery cleans exact owned resources across all domains while preserving unjournaled resources',async()=>isolated(async directory=>{
  const f=await fixture(directory);
  for(const kind of ['model','app','key','identity'] as const) {
    const name=f.journal.prefix+kind;await f.journal.requested(kind,name);await f.journal.owned(kind,name,kind+'-uid',['model','app'].includes(kind)?1:undefined);
    f.resources.set(name,kind+'-uid');
  }
  const foreign=f.journal.prefix+'foreign';f.resources.set(foreign,'not-journaled');
  expect(await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters)).toBe(f.runId);
  expect(f.deleted).toHaveLength(4);expect(f.resources.get(foreign)).toBe('not-journaled');expect(f.store.value.spec.holderIdentity).toBe('');
  expect(JSON.parse(await readPrivate(join(f.path,'automatic-recovery.json'))).state).toBe('released');
}));
test('HAR-07 worker ownership is recovered through exact parent and child journals',async()=>isolated(async directory=>{
  const f=await fixture(directory),worker=await ResourceJournal.create(join(f.path,'worker-1','journal.json'),newRunId(),registration.applianceUid);
  f.store.value.spec.holderIdentity=worker.runId;
  const name=worker.prefix+'key';await worker.requested('key',name);await worker.owned('key',name,'key-uid');f.resources.set(name,'key-uid');
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
  expect(f.deleted).toEqual([name]);expect(f.store.value.spec.holderIdentity).toBe('');
}));
test('HAR-08 ambiguous unchanged optional module is reconciled without rewriting historical failed evidence',async()=>isolated(async directory=>{
  const f=await fixture(directory),filename=join(f.path,'borrowed-module.json');await writePrivate(filename,{version:1,original:f.original,state:'ambiguous'});
  const history={version:2,runId:f.runId,cases:[{id:'MOD-03',outcome:'Failed'}]};await writePrivate(join(f.path,'summary.json'),history);
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
  expect(f.module.writes).toBe(0);expect(f.module.current).toEqual(f.original);expect(JSON.parse(await readPrivate(filename)).state).toBe('restored');
  expect(JSON.parse(await readPrivate(join(f.path,'summary.json')))).toEqual(history);
}));
test('HAR-08 acknowledged module state restores once; unacknowledged changed state is never adopted',async()=>{
  for(const acknowledged of [true,false])await isolated(async directory=>{
    const f=await fixture(directory);f.module.current={...f.original,metadata:{...f.original.metadata,generation:2},spec:{...f.original.spec,enabled:true}};
    await writePrivate(join(f.path,'borrowed-module.json'),{version:1,original:f.original,...(acknowledged?{applied:f.module.current}:{}),state:acknowledged?'applied':'ambiguous'});
    const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
    if(acknowledged){await plan.execute(f.adapters);expect(f.module.writes).toBe(1);expect(f.module.current.spec).toEqual(f.original.spec);}
    else {await expect(plan.execute(f.adapters)).rejects.toMatchObject({code:'CONFLICT'});expect(f.module.writes).toBe(0);expect(f.store.replacements).toBe(0);}
  });
});
test('HAR-07 pending create is discarded only after independent absence, never adopted by matching name',async()=>{
  for(const present of [false,true])await isolated(async directory=>{
    const f=await fixture(directory),name=f.journal.prefix+'pending';await f.journal.requested('model',name);if(present)f.resources.set(name,'unexpected-uid');
    const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
    if(present){await expect(plan.execute(f.adapters)).rejects.toMatchObject({code:'OWNERSHIP'});expect(f.store.replacements).toBe(0);}
    else {await plan.execute(f.adapters);expect((await ResourceJournal.resume(f.journal.filename,registration.applianceUid)).recoveryPlan()).toEqual([]);}
    expect(f.deleted).toEqual([]);
  });
});
test('HAR-04 active sessions, missing evidence, wrong targets, drain window and competing recovery fail closed',async()=>{
  for(const fault of ['active','session','missing','target','drain'] as const)await isolated(async directory=>{
    const f=await fixture(directory);
    if(fault==='active')f.store.value.spec.renewTime=new Date().toISOString();
    if(fault==='session')await writePrivate(join(f.path,'runner-session.json'),{version:1,runId:f.runId,targetUid:registration.applianceUid,state:'running',updatedAt:new Date().toISOString()});
    if(fault==='missing')await rm(join(f.path,'runner-session.json'));
    if(fault==='target')f.store.value.metadata.labels['regression.magicstick.dev/appliance-uid']='replacement';
    if(fault==='drain')f.store.value.spec.renewTime=new Date(Date.now()-140_000).toISOString();
    await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toThrow();expect(f.store.replacements).toBe(0);
  });
  await isolated(async directory=>{
    const f=await fixture(directory),first=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration),second=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
    await first.execute(f.adapters);const receipt=await readPrivate(join(f.path,'automatic-recovery.json'));
    await expect(second.execute(f.adapters)).rejects.toThrow();expect(f.store.value.spec.holderIdentity).toBe('');
    expect(await readPrivate(join(f.path,'automatic-recovery.json'))).toBe(receipt);
  });
});
test('HAR-06 failed automatic cleanup retains its lease and can resume the exact recovery owner',async()=>isolated(async directory=>{
  const f=await fixture(directory),name=f.journal.prefix+'model';await f.journal.requested('model',name);await f.journal.owned('model',name,'model-uid',1);f.resources.set(name,'model-uid');
  const original=f.adapters.cleanup;f.adapters.cleanup=(journal,guard)=>{const adapters=original(journal,guard);adapters.model.removeIfUid=async()=>{throw new Error('Synthetic delete timeout');};return adapters;};
  await expect((await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters)).rejects.toMatchObject({code:'CLEANUP'});
  expect(f.store.value.spec.holderIdentity).not.toBe('');expect(f.resources.has(name)).toBe(true);
  f.store.value.spec.renewTime=new Date(Date.now()-600_000).toISOString();f.adapters.cleanup=original;
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);expect(f.deleted).toEqual([name]);expect(f.store.value.spec.holderIdentity).toBe('');
}));
test('HAR-08 proven non-submitted browser write permits cleanup without changing the failed outcome',async()=>isolated(async directory=>{
  const f=await fixture(directory),borrowed=new BorrowedModule(f.original,join(f.path,'borrowed-module.json'),f.adapters.module(f.original,async()=>{}),async()=>{});
  await expect(borrowed.change(true,{},async()=>{throw new MutationNotSubmitted('MUTATION');})).rejects.toMatchObject({outcome:'Failed'});
  await borrowed.restore();expect(f.module.writes).toBe(0);expect(f.module.current).toEqual(f.original);
}));

test('HAR-07 CPU auxiliary journals are recovered only inside the exact finished run and preserve other resources',async()=>isolated(async directory=>{
  const f=await fixture(directory),auxiliaryId=newRunId(),auxiliary=await ResourceJournal.create(
    join(f.path,'ollama-'+auxiliaryId+'.journal.json'),auxiliaryId,registration.applianceUid);
  const name=auxiliary.prefix+'cpu';await auxiliary.requested('model',name);await auxiliary.owned('model',name,'cpu-uid',1);
  f.resources.set(name,'cpu-uid');const foreign='existing-model';f.resources.set(foreign,'foreign-uid');
  const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
  expect(plan.journals.map(item=>item.runId)).toEqual([f.runId,auxiliaryId]);
  await plan.execute(f.adapters);
  expect(f.deleted).toEqual([name]);expect(f.resources.get(foreign)).toBe('foreign-uid');
  expect(f.store.value.spec.holderIdentity).toBe('');
  expect((await ResourceJournal.resume(auxiliary.filename,registration.applianceUid)).recoveryPlan()).toEqual([]);
}));

test('HAR-07 malformed mismatched duplicate and symlink CPU journals block before recovery claims or deletions',async()=>{
  for(const fault of ['unknown','owner','target','duplicate','symlink'] as const)await isolated(async directory=>{
    const f=await fixture(directory),id=newRunId(),filename=join(f.path,'ollama-'+id+'.journal.json');
    if(fault==='unknown')await writePrivate(join(f.path,'unknown-'+id+'.journal.json'),{});
    else if(fault==='symlink')await symlink(f.journal.filename,filename);
    else await ResourceJournal.create(filename,fault==='owner'?newRunId():fault==='duplicate'?f.runId:id,
      fault==='target'?'foreign-appliance':registration.applianceUid);
    await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toThrow();
    expect(f.store.replacements).toBe(0);expect(f.deleted).toEqual([]);
  });
});

test('HAR-07 released leases require restored journals and independent absence before the campaign fence clears',async()=>{
  for(const fault of ['none','unrestored','reappeared','competing'] as const)await isolated(async directory=>{
    const f=await fixture(directory),name=f.journal.prefix+'model';await f.journal.requested('model',name);
    await f.journal.owned('model',name,'owned-uid',1);f.resources.set(name,'owned-uid');
    if(fault!=='unrestored')await f.journal.cleanup(f.adapters.cleanup(f.journal,async()=>{}),async()=>{});
    f.store.value.spec.holderIdentity='';
    if(fault==='unrestored')await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toMatchObject({code:'RECOVERY'});
    else {
      const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
      if(fault==='reappeared')f.resources.set(name,'replacement-uid');
      if(fault==='competing')f.store.value.spec.holderIdentity=newRunId();
      if(fault==='none')expect(await plan.execute(f.adapters)).toBe(f.runId);
      else await expect(plan.execute(f.adapters)).rejects.toMatchObject({code:fault==='reappeared'?'CLEANUP':'LOCK_BUSY'});
      expect(f.deleted).toEqual([name]);
      if(fault==='reappeared')expect(f.resources.get(name)).toBe('replacement-uid');
    }
    expect(f.store.replacements).toBe(0);
  });
});

test('HAR-04 HAR-07 campaign recovery waits for real expiry and drain without editing renewTime',async()=>isolated(async directory=>{
  const f=await fixture(directory);let now=Date.now(),reads=0;
  const renewed=new Date(now).toISOString();f.store.value.spec.renewTime=renewed;
  const store:LeaseStore={read:async()=>{reads++;now+=60_000;return f.store.read();},replace:value=>f.store.replace(value)};
  const expired=await campaignRecoveryLease(f.root,f.runId,registration.applianceUid,store,{timeoutMs:1000,intervalMs:1,now:()=>now});
  expect(reads).toBe(3);expect(expired.spec.renewTime).toBe(renewed);expect(f.store.replacements).toBe(0);
}));

test('HAR-04 HAR-07 campaign recovery never takes over a live runner foreign child or renewed lease',async()=>{
  for(const fault of ['running','foreign','renewed'] as const)await isolated(async directory=>{
    const f=await fixture(directory);
    if(fault==='running')await writePrivate(join(f.path,'runner-session.json'),{version:1,runId:f.runId,
      targetUid:registration.applianceUid,state:'running',updatedAt:new Date().toISOString()});
    if(fault==='foreign')f.store.value.metadata.annotations!['regression.magicstick.dev/run-id']=newRunId();
    if(fault==='renewed')f.store.value.spec.renewTime=new Date().toISOString();
    await expect(campaignRecoveryLease(f.root,f.runId,registration.applianceUid,f.store,{timeoutMs:25,intervalMs:1}))
      .rejects.toMatchObject({code:fault==='running'?'LOCK_BUSY':fault==='foreign'?'RECOVERY':'LOCK_STALE'});
    expect(f.store.replacements).toBe(0);expect(f.deleted).toEqual([]);
  });
});
