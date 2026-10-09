import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BorrowedSharing,sharingSpec,type SharingSnapshot,type SharingAdapter} from '../core/borrowed-sharing.ts';
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
