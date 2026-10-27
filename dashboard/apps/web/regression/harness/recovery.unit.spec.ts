import {test,expect} from '@playwright/test';
import {mkdtemp,rm,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mock} from 'node:test';
import {AutomaticRecovery,campaignRecoveryLease,type RecoveryAdapters} from '../core/automatic-recovery.ts';
import {LabLease,type Lease,type LeaseStore} from '../core/lease.ts';
import {HeartbeatLoop,bounded,withCleanup} from '../core/run-lifecycle.ts';
import {runnerSession,recordedLeaseSession} from '../core/runner-session.ts';
import {ResourceJournal,newRunId,type CleanupAdapter,type ResourceKind} from '../core/journal.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';
import {BorrowedSharing,sharingSpec,type SharingAdapter,type SharingSnapshot} from '../core/borrowed-sharing.ts';
import {MutationNotSubmitted} from '../core/browser-action.ts';
import type {LabRegistration} from '../core/lab-policy.ts';
import type {KubeObject} from '../core/observer.ts';
import {HarnessError} from '../core/errors.ts';
import {gpuWorkerJournal} from '../core/gpu-scenario.ts';
import {attestKubernetesTermination,verifiedKubernetesTermination,reconcileKubernetesSession} from '../core/kubernetes-termination.ts';
import {assessCleanup} from '../core/cleanup-state.ts';

test('HAR-06 HAR-09 cleanup always runs without replacing the original scenario error', async () => {
  const primary = new HarnessError('DEADLINE', 'Failed', 'model-ready');
  const cleanup = new HarnessError('CLEANUP', 'Failed', 'cleanup');
  let calls = 0;
  const close = async () => { calls++; throw cleanup; };
  await expect(withCleanup(async () => { throw primary; }, close)).rejects.toBe(primary);
  await expect(withCleanup(async () => 42, close)).rejects.toBe(cleanup);
  expect(calls).toBe(2);
  await expect(withCleanup(async () => 42, async () => { calls++; })).resolves.toBe(42);
  expect(calls).toBe(3);
});

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

test('HAR-08 automatic cleanup restores a fresh GPU baseline and never adopts an ambiguous reset',async()=>{
  for(const interrupted of ['untouched','shared','reset-response-lost'] as const)await isolated(async directory=>{
    const f=await fixture(directory),identity={runId:f.runId,targetUid:registration.applianceUid,nodeName:'fixture-node-name',nodeUid:'fixture-node'};
    let writes=0;
    const original={module:'gpu',enabled:true};
    let snapshot:SharingSnapshot={object:{metadata:{uid:'fixture-gpu-module',generation:1,resourceVersion:'7'},spec:original},
      state:{provider:'nvidia',backend:'time-slicing',mode:'exclusive',managed:false,experimental:false,maxModels:2,
        nodeName:identity.nodeName,nodeUid:identity.nodeUid,namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
        message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}};
    const adapter:SharingAdapter={read:async()=>structuredClone(snapshot),apply:async request=>{
      expect(request.expectedRevision).toBe(snapshot.object.metadata.resourceVersion);writes++;
      snapshot={object:{metadata:{...snapshot.object.metadata,generation:snapshot.object.metadata.generation!+1,resourceVersion:String(7+writes)},
        spec:sharingSpec(snapshot.object.spec!,request)},state:{...snapshot.state,mode:request.mode,maxModels:request.maxModels,
        managed:!request.restoreDefaults,backend:request.allocationBackend==='dra'?'dra':'time-slicing',expectedRevision:String(7+writes)}};
      if(interrupted === 'reset-response-lost' && request.restoreDefaults)throw new Error('Synthetic lost reset response');
    }};
    f.adapters.sharing=(_identity,guard)=>({read:adapter.read,apply:async request=>{await guard();await adapter.apply(request);}});
    const journal=await BorrowedSharing.create(join(f.path,'gpu-sharing.json'),identity,adapter,async()=>{});
    await journal.borrow('nvidia');
    if(interrupted !== 'untouched')await journal.change('nvidia','shared',3,'dra');
    if(interrupted === 'reset-response-lost')await expect(journal.restore()).rejects.toThrow('Synthetic lost reset response');
    const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);expect(plan.sharing).toHaveLength(1);
    if(interrupted === 'reset-response-lost') {
      await expect(plan.execute(f.adapters)).rejects.toMatchObject({code:'CONFLICT',stage:'recovery-sharing'});
      expect(f.store.replacements).toBe(0);expect(f.store.value.spec.holderIdentity).toBe(f.runId);expect(writes).toBe(3);
    } else {
      await plan.execute(f.adapters);expect(snapshot.object.spec).toEqual(original);expect(snapshot.state.managed).toBe(false);
      expect(f.store.value.spec.holderIdentity).toBe('');expect(writes).toBe(interrupted === 'untouched'?0:3);
      await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
      expect(writes).toBe(interrupted === 'untouched'?0:3);
    }
  });
});

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
test('HAR-07 HAR-09 an outer recovery deadline retains the current bounded operation',async()=>{
  let stage:'recovery-resource'|'gpu-backend'='recovery-resource',cancelled=0;
  await expect(bounded(async()=>{stage='gpu-backend';await new Promise(()=>{});},10,()=>stage,async()=>{cancelled++;}))
    .rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'gpu-backend'});
  expect(cancelled).toBe(1);
});

test('HAR-07 HAR-08 stalled GPU restoration retains its backend stage, journal and exact Lease',async()=>isolated(async directory=>{
  const f=await fixture(directory),identity={runId:f.runId,targetUid:registration.applianceUid,nodeName:'fixture-node-name',nodeUid:'fixture-node'};
  let writes=0,backendReads=0,cancelled=0,rejectRead:(error:Error)=>void=()=>{};
  let snapshot:SharingSnapshot={object:{metadata:{uid:'fixture-gpu-module',generation:1,resourceVersion:'7'},spec:{module:'gpu',enabled:true}},
    state:{provider:'nvidia',backend:'time-slicing',mode:'exclusive',managed:false,experimental:false,maxModels:2,
      nodeName:identity.nodeName,nodeUid:identity.nodeUid,namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
      message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}};
  const adapter:SharingAdapter={read:async()=>{
    if(writes===2&&++backendReads>1)return new Promise<SharingSnapshot>((_resolve,reject)=>{rejectRead=reject;});
    return structuredClone(snapshot);
  },apply:async request=>{
    writes++;snapshot={object:{metadata:{...snapshot.object.metadata,generation:snapshot.object.metadata.generation!+1,resourceVersion:String(7+writes)},
      spec:sharingSpec(snapshot.object.spec!,request)},state:{...snapshot.state,mode:request.mode,maxModels:request.maxModels,
      backend:request.allocationBackend==='dra'?'dra':'time-slicing',managed:!request.restoreDefaults,
      expectedRevision:String(7+writes),phase:writes===2?'Switching':'Ready'}};
  }};
  const filename=join(f.path,'gpu-sharing.json');
  const borrowed=await BorrowedSharing.create(filename,identity,adapter,async()=>{});
  await borrowed.borrow('nvidia');await borrowed.change('nvidia','shared',3,'dra');
  f.adapters.sharing=(_identity,guard)=>({read:adapter.read,apply:async request=>{await guard();await adapter.apply(request);}});
  f.adapters.cancel=async()=>{cancelled++;rejectRead(new Error('Synthetic cancelled GPU read'));};
  const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
  const realTimeout=globalThis.setTimeout;
  // Accelerate only the first, outer ten-minute recovery deadline. The nested
  // backend wait is deliberately still pending when cancellation fires.
  let accelerated=false;
  const timer=mock.method(globalThis,'setTimeout',(callback:()=>void,ms?:number)=>{
    const outer=ms===600_000&&!accelerated;if(outer)accelerated=true;
    return realTimeout(callback,outer?1000:ms);
  });
  try {
    await expect(plan.execute(f.adapters)).rejects.toMatchObject({code:'DEADLINE',stage:'gpu-backend'});
  }finally {timer.mock.restore();}
  expect(accelerated).toBe(true);expect(cancelled).toBe(1);expect(backendReads).toBeGreaterThan(1);
  expect(writes).toBe(2);expect(snapshot.object.spec).toHaveProperty('parameters.gpuSharing');
  expect(JSON.parse(await readPrivate(filename)).entries[0].state).toBe('borrowed');
  expect(JSON.parse(await readPrivate(join(f.path,'automatic-recovery.json')))).toMatchObject({state:'blocked',reason:'DEADLINE',stage:'gpu-backend'});
  expect(f.store.value.metadata.uid).toBe('fixture-lease');expect(f.store.value.spec.holderIdentity).not.toBe('');
}));
test('HAR-09 a cancellation-triggered page rejection cannot replace the known deadline',async()=>{
  let rejectAction:(error:Error)=>void=()=>{};
  await expect(bounded(()=>new Promise<void>((_resolve,reject)=>{rejectAction=reject;}),10,'kubeconfig-copy',async()=>{
    rejectAction(new Error('Synthetic page was closed during cancellation'));
  })).rejects.toMatchObject({code:'DEADLINE',outcome:'Failed',stage:'kubeconfig-copy'});
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
test('HAR-07 consecutive GPU scenarios recover every exact journal without reusing earlier receipts',async()=>isolated(async directory=>{
  const f=await fixture(directory),names=[];
  for(let index=0;index<3;index++) {
    const child=await gpuWorkerJournal(f.path,0,registration.applianceUid,true),name=child.journal.prefix+'model';
    await child.journal.requested('model',name);await child.journal.owned('model',name,'uid-'+index,1);
    f.resources.set(name,'uid-'+index);names.push(name);f.store.value.spec.holderIdentity=child.journal.runId;
  }
  const plan=await AutomaticRecovery.prepare(f.root,await f.store.read(),registration);
  expect(plan.journals).toHaveLength(4);await plan.execute(f.adapters);
  expect([...f.deleted].sort()).toEqual(names.sort());expect(f.store.value.spec.holderIdentity).toBe('');
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
  expect(f.deleted).toHaveLength(3);
}));
test('HAR-07 both no-license baseline receipts must be restored before automatic recovery can proceed',async()=>{
  for(const caseId of ['lic-01','sso-01'])await isolated(async directory=>{
    const f=await fixture(directory),filename=join(f.path,`license-baseline-${caseId}.json`);
    await writePrivate(filename,{version:1,state:'requested'},true);
    await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toMatchObject({code:'RECOVERY',stage:'recovery-journal'});
    expect(f.store.replacements).toBe(0);
    await writePrivate(filename,{version:1,state:'restored'});
    await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
    expect(f.store.value.spec.holderIdentity).toBe('');
  });
});
test('HAR-07 unfinished case-specific license receipts also fence automatic recovery',async()=>{
  for(const caseId of ['lic-02','lic-03','lic-04'])await isolated(async directory=>{
    const f=await fixture(directory),filename=join(f.path,`license-transaction-${caseId}.json`);
    await writePrivate(filename,{version:1,state:'applied'},true);
    await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toMatchObject({code:'RECOVERY',stage:'recovery-journal'});
    expect(f.store.replacements).toBe(0);await writePrivate(filename,{version:1,state:'restored'});
    await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
    expect(f.store.value.spec.holderIdentity).toBe('');
  });
});
test('HAR-07 K8S-03 unremoved Kubernetes CRUD receipts fence recovery instead of being ignored',async()=>{
  for(const plural of ['moduleactivations','modelactivations','appinstances'])await isolated(async directory=>{
    const f=await fixture(directory),filename=join(f.path,'kube-'+plural+'.json');
    await writePrivate(filename,{version:1,state:'owned',uid:'fixture-uid',generation:1},true);
    await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).rejects.toMatchObject({code:'RECOVERY',stage:'recovery-journal'});
    expect(f.store.replacements).toBe(0);
    await writePrivate(filename,{version:1,state:'removed',uid:'fixture-uid',generation:1});
    await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration)).execute(f.adapters);
    expect(f.store.value.spec.holderIdentity).toBe('');
  });
});
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
      .rejects.toMatchObject({code:fault==='running'?'PROCESS_STATE':fault==='foreign'?'RECOVERY':'LOCK_STALE',
        ...(fault==='running'?{outcome:'Failed',stage:'recovery-barrier'}:{})});
    expect(f.store.replacements).toBe(0);expect(f.deleted).toEqual([]);
  });
});

async function kubernetesFixture(directory:string) {
  const f=await fixture(directory),runtimeRunUid='11111111-1111-4111-8111-111111111111',currentRunUid='22222222-2222-4222-8222-222222222222';
  const reports=join(directory,'reports'),owner='regression.magicstick.dev/run-uid';
  const session={version:1,runId:f.runId,targetUid:registration.applianceUid,state:'running',processesStopped:false,
    interrupted:true,updatedAt:new Date(Date.now()-5000).toISOString()};
  await writePrivate(join(f.path,'runner-session.json'),session);
  await writePrivate(join(f.path,'summary.json'),{version:2,runId:f.runId,counts:{Passed:8,Failed:3,Blocked:18},acceptable:false});
  const published={version:1,runUid:runtimeRunUid,progress:{ownedRunIds:[f.runId]}};
  await writePrivate(join(reports,runtimeRunUid,'status.json'),published);
  const run:KubeObject={metadata:{uid:runtimeRunUid,name:'synthetic-run',namespace:'ai-system',resourceVersion:'7'},
    spec:{applianceUid:registration.applianceUid,nodeUids:registration.nodeUids,image:'registry.example.invalid/runner@sha256:'+'a'.repeat(64)},status:{phase:'Failed'}};
  const job:KubeObject={metadata:{uid:'synthetic-job',name:'synthetic-run',namespace:'magicstick-regression',resourceVersion:'8',labels:{[owner]:runtimeRunUid}},status:{active:0}};
  const pod:KubeObject={metadata:{uid:'synthetic-pod',name:'synthetic-run-worker',namespace:'magicstick-regression',resourceVersion:'9',
    labels:{[owner]:runtimeRunUid},ownerReferences:[{kind:'Job',uid:job.metadata.uid!,controller:true}]},
    spec:{nodeName:'synthetic-node',securityContext:{runAsNonRoot:true},containers:[{name:'runner',image:run.spec!.image,
      securityContext:{allowPrivilegeEscalation:false,capabilities:{drop:['ALL']}}}]},
    status:{phase:'Succeeded',containerStatuses:[{name:'runner',containerID:'containerd://synthetic-container',
      state:{terminated:{exitCode:0,finishedAt:new Date(Date.now()-1000).toISOString()}}}]}};
  const node:KubeObject={metadata:{name:'synthetic-node',uid:registration.nodeUids[0]}};
  const reads:string[]=[],reader={list:async(resource:string)=>{
    reads.push(resource);return structuredClone(resource==='nodes'?[node]:resource==='pods'?[pod]:[run]);
  },get:async(resource:string)=>{
    reads.push(resource);return structuredClone(resource==='pods'?pod:resource==='jobs.batch'?job:run);
  }};
  const options={root:f.root,reports,runId:f.runId,runtimeRunUid,accountRunUid:runtimeRunUid,currentRunUid,identity:registration,reader};
  return {...f,options,session,published,run,job,pod,node,reads,reports,runtimeRunUid};
}

test('HAR-07 HAR-10 exact terminated Kubernetes ownership permits regular recovery, not a report rewrite or force unlock',async()=>isolated(async directory=>{
  const f=await kubernetesFixture(directory),name=f.journal.prefix+'owned';
  await f.journal.requested('model',name);await f.journal.owned('model',name,'synthetic-model',1);f.resources.set(name,'synthetic-model');
  const originalSession=await readPrivate(join(f.path,'runner-session.json')),originalReport=await readPrivate(join(f.path,'summary.json'));
  await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration,Date.now(),true)).rejects.toMatchObject({code:'PROCESS_STATE'});
  await attestKubernetesTermination(f.options);
  expect(await verifiedKubernetesTermination(f.path,f.runId,registration)).toBe(true);
  expect(f.store.replacements).toBe(0);expect(f.deleted).toEqual([]);
  // Termination alone is not proof that the model is absent.
  expect((await assessCleanup(f.path,true)).state).toBe('required');
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration,Date.now(),true)).execute(f.adapters);
  expect(f.deleted).toEqual([name]);expect(f.store.value.spec.holderIdentity).toBe('');
  expect((await assessCleanup(f.path,true)).state).toBe('verified');
  await (await AutomaticRecovery.prepare(f.root,await f.store.read(),registration,Date.now(),true)).execute(f.adapters);
  expect(f.deleted).toEqual([name]);
  expect(await readPrivate(join(f.path,'runner-session.json'))).toBe(originalSession);
  expect(await readPrivate(join(f.path,'summary.json'))).toBe(originalReport);
}));

test('HAR-07 HAR-10 Kubernetes reconciliation rejects active foreign missing changed and unsafe execution evidence',async()=>{
  for(const fault of ['active','unlisted-owner','foreign-run','foreign-account','foreign-job','foreign-pod','foreign-node','same-run',
    'missing-pod','worker-running','host-pid','privileged','ephemeral','changed-pod','changed-job','changed-session'] as const)await isolated(async directory=>{
    const f=await kubernetesFixture(directory);
    if(fault==='active')f.run.status!.phase='Running';
    if(fault==='unlisted-owner'){f.published.progress.ownedRunIds=[];await writePrivate(join(f.reports,f.runtimeRunUid,'status.json'),f.published);}
    if(fault==='foreign-run')f.run.spec!.applianceUid='other-appliance';
    if(fault==='foreign-account')f.run.spec!.accountRunUid='33333333-3333-4333-8333-333333333333';
    if(fault==='foreign-job')f.job.metadata.labels!['regression.magicstick.dev/run-uid']='other-run';
    if(fault==='foreign-pod')f.pod.metadata.ownerReferences![0]!.uid='other-job';
    if(fault==='foreign-node')f.node.metadata.uid='other-node';
    if(fault==='same-run')f.options.currentRunUid=f.options.runtimeRunUid;
    if(fault==='missing-pod')f.options.reader.list=async resource=>resource==='pods'?[]:resource==='nodes'?[f.node]:[f.run];
    if(fault==='worker-running')f.pod.status!.containerStatuses![0]!.state={running:{startedAt:new Date().toISOString()}};
    if(fault==='host-pid')f.pod.spec!.hostPID=true;
    if(fault==='privileged')(f.pod.spec!.containers as any[])[0].securityContext.allowPrivilegeEscalation=true;
    if(fault==='ephemeral')f.pod.spec!.ephemeralContainers=[{name:'unobserved-debugger'}];
    const original=f.options.reader.get;
    if(['changed-pod','changed-job','changed-session'].includes(fault))f.options.reader.get=async resource=>{
      const value=await original(resource);
      // The first Job read is before the Pod inventory, subsequent reads close
      // the attestation. Changing a revision during that window must reject it.
      if(fault==='changed-pod'&&resource==='pods')value.metadata.uid='replacement-pod';
      if(fault==='changed-job'&&resource==='jobs.batch'&&f.reads.filter(r=>r==='jobs.batch').length>1)value.metadata.resourceVersion='10';
      if(fault==='changed-session'&&resource==='pods')await writePrivate(join(f.path,'runner-session.json'),{...f.session,updatedAt:new Date(Date.now()+1000).toISOString()});
      return value;
    };
    await expect(attestKubernetesTermination(f.options),fault).rejects.toBeInstanceOf(HarnessError);
    expect(await verifiedKubernetesTermination(f.path,f.runId,registration),fault).toBe(false);
    expect(f.store.replacements,fault).toBe(0);expect(f.deleted,fault).toEqual([]);
  });
});

test('HAR-07 Kubernetes termination receipts bind the unchanged session and node identity',async()=>isolated(async directory=>{
  const f=await kubernetesFixture(directory);await attestKubernetesTermination(f.options);
  expect(await verifiedKubernetesTermination(f.path,f.runId,{...registration,nodeUids:['replacement-node']})).toBe(false);
  await writePrivate(join(f.path,'runner-session.json'),{...f.session,updatedAt:new Date(Date.now()+1000).toISOString()});
  expect(await verifiedKubernetesTermination(f.path,f.runId,registration)).toBe(false);
  await expect(AutomaticRecovery.prepare(f.root,await f.store.read(),registration,Date.now()+2000,true)).rejects.toMatchObject({code:'PROCESS_STATE'});
}));

test('HAR-07 exact execution ownership is separate from a retained account reused by later runs',async()=>isolated(async directory=>{
  const f=await kubernetesFixture(directory),account='33333333-3333-4333-8333-333333333333';
  f.run.spec!.accountRunUid=account;f.options.accountRunUid=account;
  await attestKubernetesTermination(f.options);
  expect(await verifiedKubernetesTermination(f.path,f.runId,registration)).toBe(true);
  const proof=JSON.parse(await readPrivate(join(f.path,'runner-termination.json')));
  expect(proof.runtimeRunUid).toBe(f.runtimeRunUid);expect(proof.runtimeRunUid).not.toBe(account);
}));

test('HAR-07 setup reconciliation uses only fixed reads for the Lease-linked Kubernetes execution',async()=>isolated(async directory=>{
  const f=await kubernetesFixture(directory),commands:string[][]=[];
  const account='33333333-3333-4333-8333-333333333333';f.run.spec!.accountRunUid=account;
  const env={REGRESSION_EXECUTION:'kubernetes',REGRESSION_ACCOUNT_RUN_UID:account,REGRESSION_RUN_UID:f.options.currentRunUid};
  const command=async(args:string[])=>{
    commands.push(args);expect(args[0]).toBe('get');expect(args.slice(-2)).toEqual(['-o','json']);
    const resource=args[1]!;
    return args[2]==='-n'||args[2]==='-o'?{items:await f.options.reader.list(resource)}:f.options.reader.get(resource);
  };
  await reconcileKubernetesSession({root:f.root,runId:f.runId,reports:f.reports,identity:registration,env,command,runtimeRunUid:f.runtimeRunUid});
  expect(commands.length).toBe(7);expect(await verifiedKubernetesTermination(f.path,f.runId,registration)).toBe(true);
  expect(commands.find(args=>args[1]==='nodes')).toEqual(['get','nodes','-o','json']);
  expect(f.store.replacements).toBe(0);expect(f.deleted).toEqual([]);
  commands.length=0;
  await reconcileKubernetesSession({root:f.root,runId:f.runId,identity:registration,env:{REGRESSION_EXECUTION:'external'},command});
  expect(commands).toEqual([]);
}));
