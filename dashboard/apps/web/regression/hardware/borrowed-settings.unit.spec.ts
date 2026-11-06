import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BorrowedSharing,SharingWriteRejected,sharingSpec,type SharingSnapshot,type SharingAdapter} from '../core/borrowed-sharing.ts';
import {newRunId} from '../core/journal.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

test('HAR-08 borrowed sharing restores exact spec but rejects foreign edits, replacement, ambiguous writes and a lost Lease', evidenceAnnotations(
  {id:'HAR-08',variant:'p3-restoration',layer:'U'}, {id:'HAR-08',variant:'p4-restoration',layer:'U'}), async () => {
  const directory = await mkdtemp(join(tmpdir(),'sharing-journal-'));
  try {
    for (const fault of ['none','dra','generation','uid','ambiguous','lease'] as const) {
      let held = true, writes = 0;
      const state:SharingSnapshot['state'] = {provider:'nvidia',backend:'time-slicing',mode:'shared',managed:true,experimental:false,
        maxModels:5,nodeName:'fixture-node',nodeUid:'fixture-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
        message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false};
      if (fault === 'dra') state.backend = 'dra';
      let snapshot:SharingSnapshot = {state,object:{metadata:{uid:'fixture-module',generation:2,resourceVersion:'7'},spec:
        sharingSpec({enabled:true,parameters:{driverMode:'operator-managed',unrelated:'keep'}},{...state,acknowledgeSharing:true,acknowledgeRestart:true,
          ...(fault === 'dra' ? {allocationBackend:'dra'} : {})})}};
      const original = structuredClone(snapshot.object.spec);
      const adapter:SharingAdapter = {read:async () => structuredClone(snapshot),apply:async request => {
        expect(request.expectedRevision).toBe(snapshot.object.metadata.resourceVersion); writes++;
        snapshot = {state:{...snapshot.state,mode:request.mode,maxModels:request.maxModels,expectedRevision:String(writes+7),
          backend:request.allocationBackend === 'dra' ? 'dra' : 'time-slicing'},
          object:{metadata:{...snapshot.object.metadata,generation:snapshot.object.metadata.generation!+1,resourceVersion:String(writes+7)},
            spec:sharingSpec(snapshot.object.spec!,request)}};
        if (fault === 'ambiguous') throw new Error('fixture timeout');
      }};
      const identity = {runId:newRunId(),targetUid:'fixture-appliance',nodeName:'fixture-node',nodeUid:'fixture-uid'};
      const filename = join(directory,fault+'.json');
      const journal = await BorrowedSharing.create(filename,identity,adapter,async () => {if (!held) throw new Error('lost Lease');});
      await journal.borrow('nvidia');
      if (fault === 'lease') held = false;
      if (fault === 'ambiguous' || fault === 'lease') {
        await expect(journal.change('nvidia','exclusive',2)).rejects.toThrow();
        await expect(journal.restore()).rejects.toThrow();
        expect(writes).toBe(fault === 'ambiguous' ? 1 : 0); continue;
      }
      await journal.change('nvidia','exclusive',2,fault === 'dra' ? 'device-plugin' : 'dra');
      if (fault === 'generation') snapshot.object.metadata.generation!++;
      if (fault === 'uid') snapshot.object.metadata.uid = 'foreign-replacement';
      const resumed = await BorrowedSharing.resume(filename,identity,adapter,async () => {});
      if (fault !== 'none' && fault !== 'dra') {await expect(resumed.restore()).rejects.toThrow('[CONFLICT]'); expect(writes).toBe(1);}
      else {
        // Controller status writes alone do not prevent safe restoration.
        snapshot.object.metadata.resourceVersion = '100'; snapshot.state.expectedRevision = '100';
        await resumed.restore(); expect(snapshot.object.spec).toEqual(original); expect(writes).toBe(2);
        expect(resumed.entries[0]?.state).toBe('restored');
      }
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('HAR-08 default restoration remains fenced on a foreign revision, lost acknowledgement or Lease', evidenceAnnotations(
  {id:'HAR-08',variant:'p3-restoration',layer:'U'}, {id:'HAR-08',variant:'p4-restoration',layer:'U'}), async () => {
  const directory=await mkdtemp(join(tmpdir(),'default-sharing-fences-'));
  try {
    for (const fault of ['untouched','generation','uid','lease','not-sent','ambiguous-reset','rejected-reset','slow-exclusive'] as const) {
      let held=true,writes=0,rejected=false,readyReads=0;
      let snapshot:SharingSnapshot={object:{metadata:{uid:'fixture-module',generation:1,resourceVersion:'7'},spec:{enabled:true}},
        state:{provider:'nvidia',backend:'time-slicing',mode:'exclusive',managed:false,experimental:false,maxModels:2,
          nodeName:'fixture-node',nodeUid:'fixture-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
          message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}};
      const original=structuredClone(snapshot.object.spec);
      const adapter:SharingAdapter={read:async()=>{
        if (snapshot.state.phase === 'Starting' && ++readyReads >= 3) snapshot.state.phase='Ready';
        return structuredClone(snapshot);
      },apply:async request=>{
        if (request.restoreDefaults) {
          expect(snapshot.state.phase).toBe('Ready');expect(snapshot.state.mode).toBe('exclusive');expect(snapshot.state.backend).toBe('time-slicing');
          if (fault === 'not-sent') throw new Error('Synthetic failure before send');
          if (fault === 'rejected-reset' && !rejected) {
            rejected=true;snapshot.state.expectedRevision=snapshot.object.metadata.resourceVersion='100';throw new SharingWriteRejected(409);
          }
        }
        expect(request.expectedRevision).toBe(snapshot.object.metadata.resourceVersion);
        writes++;const spec=sharingSpec(snapshot.object.spec!,request),revision=String(Number(snapshot.object.metadata.resourceVersion)+1);
        snapshot={object:{metadata:{...snapshot.object.metadata,generation:snapshot.object.metadata.generation!+1,resourceVersion:revision},spec},
          state:{...snapshot.state,mode:request.mode,maxModels:request.maxModels,expectedRevision:revision,
            phase:fault === 'slow-exclusive' && request.mode === 'exclusive' && !request.restoreDefaults ? 'Starting' : 'Ready',
            backend:request.allocationBackend === 'dra' ? 'dra' : 'time-slicing',managed:!request.restoreDefaults}};
        if (fault === 'ambiguous-reset' && request.restoreDefaults) throw new Error('Synthetic lost response');
        if (fault === 'lease' && request.mode === 'exclusive') held=false;
      }};
      const identity={runId:newRunId(),targetUid:'fixture-appliance',nodeName:'fixture-node',nodeUid:'fixture-uid'},filename=join(directory,identity.runId+'.json');
      const guard=async()=>{if(!held)throw new Error('Synthetic lost Lease');};
      const journal=await BorrowedSharing.create(filename,identity,adapter,guard);await journal.borrow('nvidia');
      await journal.verifyRecoverable();
      if (fault === 'untouched') {await journal.restore();expect(writes).toBe(0);expect(snapshot.object.spec).toEqual(original);continue;}
      await journal.change('nvidia','shared',3,'dra');
      if(fault === 'generation')snapshot.object.metadata.generation!++;
      if(fault === 'uid')snapshot.object.metadata.uid='foreign';
      if (['generation','uid','lease','not-sent','ambiguous-reset'].includes(fault)) {
        await expect(journal.restore()).rejects.toThrow();
        const resumed=await BorrowedSharing.resume(filename,identity,adapter,guard);
        if (fault === 'not-sent') {
          // Only independent proof of the unchanged last acknowledged spec can
          // clear a request that was durably recorded before it was sent.
          await expect(resumed.restore()).rejects.toThrow('[CONFLICT]');await resumed.reconcileUnchanged();
          expect(resumed.entries[0]!.state).toBe('borrowed');
        } else await expect(resumed.verifyRecoverable()).rejects.toThrow();
        expect(writes).toBe(fault === 'ambiguous-reset' ? 3 : ['lease','not-sent'].includes(fault) ? 2 : 1);
      } else {
        await journal.restore();expect(snapshot.object.spec).toEqual(original);expect(writes).toBe(3);
        if(fault === 'rejected-reset')expect(rejected).toBe(true);
        if(fault === 'slow-exclusive')expect(readyReads).toBeGreaterThanOrEqual(3);
        const resumed=await BorrowedSharing.resume(filename,identity,adapter,guard);
        await resumed.restore();expect(writes).toBe(3);
      }
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('HAR-08 unmanaged custom sharing and malformed defaults are not adopted', async()=>{
  const directory=await mkdtemp(join(tmpdir(),'custom-sharing-'));
  try {
    for(const parameters of [{gpuSharing:'{}'},{gpuSharing:'invalid'},{gpuSharing:null},{validationRequest:'active-probe'}]) {
      const adapter:SharingAdapter={read:async()=>({object:{metadata:{uid:'fixture-module',generation:1,resourceVersion:'7'},spec:{enabled:true,parameters}},
        state:{provider:'nvidia',backend:'time-slicing',mode:'exclusive',managed:false,experimental:false,maxModels:2,
          nodeName:'fixture-node',nodeUid:'fixture-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
          message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}}),apply:async()=>{throw new Error('Must not mutate custom defaults');}};
      const identity={runId:newRunId(),targetUid:'fixture-appliance',nodeName:'fixture-node',nodeUid:'fixture-uid'};
      const journal=await BorrowedSharing.create(join(directory,identity.runId+'.json'),identity,adapter,async()=>{});
      await expect(journal.borrow('nvidia')).rejects.toMatchObject({code:'CAPABILITY'});expect(journal.entries).toEqual([]);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('HAR-08 a fresh GPU default is borrowed, exercised and restored without leaving saved sharing settings', evidenceAnnotations(
  {id:'HAR-08',variant:'p3-restoration',layer:'U'}, {id:'HAR-08',variant:'p4-restoration',layer:'U'}), async () => {
  const directory = await mkdtemp(join(tmpdir(),'default-sharing-journal-'));
  try {
    for (const provider of ['nvidia','amd'] as const) for (const parameters of [undefined,{},
      {gpuSharing:''},{unrelated:'keep'},...(provider === 'amd' ? [{validationRequest:''}] : [])]) {
      let writes = 0;
      let snapshot:SharingSnapshot = {object:{metadata:{uid:'fixture-module',generation:1,resourceVersion:'7'},
        spec:{enabled:true,...(parameters === undefined ? {} : {parameters})}},
        state:{provider,backend:provider === 'amd' ? 'dra' : 'time-slicing',mode:'exclusive',managed:false,experimental:provider === 'amd',
          maxModels:2,nodeName:'fixture-node',nodeUid:'fixture-uid',namespace:'ai',expectedRevision:'7',available:true,reason:'',phase:'Ready',
          message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}};
      const original = structuredClone(snapshot.object.spec);
      const adapter:SharingAdapter = {read:async () => structuredClone(snapshot),apply:async request => {
        expect(request.expectedRevision).toBe(snapshot.object.metadata.resourceVersion); writes++;
        const spec=sharingSpec(snapshot.object.spec!,request);
        snapshot={object:{metadata:{...snapshot.object.metadata,generation:snapshot.object.metadata.generation!+1,
          resourceVersion:String(7+writes)},spec},state:{...snapshot.state,mode:request.mode,maxModels:request.maxModels,
          backend:provider === 'amd' || request.allocationBackend === 'dra' ? 'dra' : 'time-slicing',
          managed:Boolean((spec.parameters as Record<string,unknown> | undefined)?.gpuSharing),expectedRevision:String(7+writes)}};
      }};
      const identity={runId:newRunId(),targetUid:'fixture-appliance',nodeName:'fixture-node',nodeUid:'fixture-uid'};
      const filename=join(directory,identity.runId+'.json');
      const borrowed=await BorrowedSharing.create(filename,identity,adapter,async()=>{});
      await borrowed.borrow(provider);
      expect(writes).toBe(0); // Reading/borrowing must not configure the appliance.
      await borrowed.change(provider,'shared',3,provider === 'nvidia' ? 'dra' : undefined);
      expect(snapshot.state.managed).toBe(true);
      const resumed=await BorrowedSharing.resume(filename,identity,adapter,async()=>{});
      await resumed.verifyRecoverable(); await resumed.restore();
      expect(snapshot.object.spec).toEqual(original);
      expect(snapshot.state.managed).toBe(false); expect(snapshot.state.mode).toBe('exclusive');
      expect(writes).toBe(3); // Configure, converge on exclusive, then remove only the borrowed fields.
      await resumed.restore(); expect(writes).toBe(3);
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
