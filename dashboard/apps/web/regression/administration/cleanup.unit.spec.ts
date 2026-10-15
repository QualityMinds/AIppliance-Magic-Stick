import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import type {User} from '@magicstick/dashboard-contracts';
import {LiveFoundation} from '../core/live-foundation.ts';
import type {CleanupAdapter,ResourceKind} from '../core/journal.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {OwnedIdentityClient,ownedLocalIdentity} from '../core/owned-identity.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';
import type {KubeObject} from '../core/observer.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {AdministrationRejected} from '../core/administration-api.ts';
import {MutationNotSubmitted} from '../core/browser-action.ts';
import {HarnessError} from '../core/errors.ts';
import {readPrivate,journalFile,privateDirectory,writePrivate} from '../core/private-files.ts';
import {workloadPodInventory,repeatInventoryChanges} from '../core/repeat-inventory.ts';
import {absentLicenseDocumentPatch} from '../core/license-baseline.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
test('LIC-02 LIC-04 first-activation cleanup removes only the exact test document and preserves the original installation',annotation,()=>{
  const encode=(text:string)=>Buffer.from(text).toString('base64');
  const original={metadata:{name:'magicstick-license',namespace:'identity-system',uid:'original-secret',resourceVersion:'1'},
    data:{installationId:encode('fixture-installation'),preserve:encode('untouched-field')}};
  const current={...original,metadata:{...original.metadata,resourceVersion:'2'},data:{...original.data,'license.json':encode('test-document')}};
  expect(absentLicenseDocumentPatch(original,current,'fixture-installation','test-document')).toEqual([
    {op:'test',path:'/metadata/uid',value:'original-secret'},
    {op:'test',path:'/metadata/resourceVersion',value:'2'},
    {op:'test',path:'/data',value:current.data},{op:'remove',path:'/data/license.json'},
  ]);
  for(const changed of [
    {...current,metadata:{...current.metadata,uid:'foreign-secret'}},
    {...current,data:{...current.data,installationId:encode('another-installation')}},
    {...current,data:{...current.data,preserve:encode('changed-field')}},
    {...current,data:{...current.data,'license.json':encode('human-document')}},
  ])expect(()=>absentLicenseDocumentPatch(original,changed,'fixture-installation','test-document')).toThrow();
  expect(()=>absentLicenseDocumentPatch(current,current,'fixture-installation','test-document')).toThrow();
});
test('PERF-02 catalog-driven Pod replacement is not a leak; extra replicas, replaced owners and bare Pods are',annotation,()=>{
  const set=(uid:string,owner='stable-deployment')=>({metadata:{uid,ownerReferences:[{kind:'Deployment',uid:owner,controller:true}]}} as KubeObject);
  const pod=(uid:string,owner?:string)=>({metadata:{uid,...(owner?{ownerReferences:[{kind:'ReplicaSet',uid:owner,controller:true}]}:{})}} as KubeObject);
  const before=workloadPodInventory([pod('old-pod','old-rs'),pod('bare-pod')],[set('old-rs')]);
  expect(workloadPodInventory([pod('new-pod','new-rs'),pod('bare-pod')],[set('new-rs')])).toBe(before);
  for(const changed of [
    workloadPodInventory([pod('new-pod','new-rs'),pod('extra-pod','new-rs'),pod('bare-pod')],[set('new-rs')]),
    workloadPodInventory([pod('new-pod','new-rs'),pod('bare-pod')],[set('new-rs','recreated-deployment')]),
    workloadPodInventory([pod('new-pod','new-rs'),pod('replaced-bare-pod')],[set('new-rs')]),
    workloadPodInventory([pod('new-pod','unknown-rs'),pod('bare-pod')],[]),
  ]) {
    const baseline={podIds:before,modelIds:'',intentIds:'',claimIds:'',routeIds:'',keyIds:''};
    expect(repeatInventoryChanges(baseline,{...baseline,podIds:changed})).toEqual(['podIds']);
  }
});
test('HAR-07 transaction receipts from restarted workers cannot overwrite or collide with previous workers',annotation,async()=>{
  const root=await mkdtemp(join(tmpdir(),'worker-receipts-'));
  try {
    const first={filename:join(root,'worker-1','journal.json')},second={filename:join(root,'worker-2','journal.json')};
    for(const item of [first,second])await privateDirectory(dirname(item.filename));
    await writePrivate(journalFile(first,'license-transaction.json'),{state:'applied'},true);
    await writePrivate(journalFile(second,'license-transaction.json'),{state:'reviewed'},true);
    expect(JSON.parse(await readPrivate(journalFile(first,'license-transaction.json'))).state).toBe('applied');
    expect(JSON.parse(await readPrivate(journalFile(second,'license-transaction.json'))).state).toBe('reviewed');
    for(const name of ['../journal.json','nested/receipt.json','..','/tmp/receipt.json'])expect(()=>journalFile(first,name)).toThrow('[PRIVATE_FILE]');
  }finally{await rm(root,{recursive:true,force:true});}
});
test('HAR-07 GPU restoration failure still cleans independent journals, stops heartbeat and retains its precise stage',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'restoration-fence-'));
  try {
    const journal=await ResourceJournal.create(join(directory,'journal.json'),newRunId(),'appliance'),events:string[]=[];
    const live=Object.assign(Object.create(LiveFoundation.prototype),{acquired:true,journal,journals:[journal],
      restorations:[async()=>{events.push('restore');throw new HarnessError('BUSY','Blocked','gpu-validation');}],
      cleanup:async()=>{events.push('owned-cleanup');},heartbeat:{stop:async()=>{events.push('heartbeat-stop');}},
      lease:{release:async()=>{events.push('lease-release');}},context:{close:async()=>{events.push('context-close');}}}) as LiveFoundation;
    await expect(live.close()).rejects.toMatchObject({code:'CLEANUP',stage:'gpu-validation'});
    expect(events).toEqual(['owned-cleanup','restore','heartbeat-stop','context-close']);
    expect(JSON.parse(await readPrivate(join(directory,'cleanup-failure.json'))).failures).toEqual([{reason:'BUSY',stage:'gpu-validation'}]);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('HAR-10 module cleanup distinguishes unsent, acknowledged and lost responses across process restarts',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'module-recovery-'));
  try {
    for(const outcome of ['unsent','acknowledged','lost'] as const) {
      const original:KubeObject={metadata:{name:'optional',uid:'exact-uid',generation:1},spec:{enabled:false,parameters:{}}};
      let current=structuredClone(original),writes=0;
      const adapter={read:async()=>structuredClone(current),set:async(enabled:boolean,parameters:Record<string,string>)=>{
        writes++;current={metadata:{...current.metadata,generation:current.metadata.generation!+1},spec:{enabled,parameters}};
      }},receipt=join(directory,outcome+'.json'),guard=async()=>{};
      const borrowed=new BorrowedModule(original,receipt,adapter,guard);
      await expect(borrowed.change(true,{},async acknowledge=>{
        if(outcome==='unsent')throw new MutationNotSubmitted('DEADLINE');
        await adapter.set(true,{});
        if(outcome==='acknowledged')await acknowledge();
        throw new Error('Synthetic lost response or postcondition failure');
      })).rejects.toThrow();
      const recovered=await BorrowedModule.resume(receipt,adapter,guard);
      if(outcome==='lost') {
        await expect(recovered.reconcileUnchanged()).rejects.toThrow('[CONFLICT]');
        await expect(recovered.restore()).rejects.toThrow('[CLEANUP]');
        expect(writes).toBe(1);continue;
      }
      await recovered.reconcileUnchanged();await recovered.restore();
      expect(current.spec).toEqual(original.spec);
      const again=await BorrowedModule.resume(receipt,adapter,guard);
      await again.reconcileUnchanged();await again.restore();
      expect(writes).toBe(outcome==='unsent'?0:2);
      current.metadata.generation!++;
      await expect(again.restore()).rejects.toThrow('[CONFLICT]');
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
test('MOD-03 MOD-04 optional maps and enabled service baselines are restored exactly and repeatedly',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'module-baselines-'));
  try {
    for(const enabled of [false,true])for(const withParameters of [false,true]) {
      const original:KubeObject={metadata:{name:'service',uid:'exact-service-uid',generation:5},
        spec:{module:'service',enabled,...(withParameters?{parameters:{}}:{})}};
      let current=structuredClone(original),writes=0;
      const adapter={read:async()=>structuredClone(current),set:async(value:boolean,parameters:Record<string,string>)=>{
        writes++;current={...current,metadata:{...current.metadata,generation:current.metadata.generation!+1},
          spec:{...current.spec,enabled:value,...(withParameters||Object.keys(parameters).length?{parameters}:{})}};
      }},receipt=join(directory,`${enabled}-${withParameters}.json`),guard=async()=>{};
      const borrowed=new BorrowedModule(original,receipt,adapter,guard);
      await borrowed.change(!enabled,{});
      const recovered=await BorrowedModule.resume(receipt,adapter,guard);
      await recovered.reconcileUnchanged();await recovered.restore();
      expect(current.spec).toEqual(original.spec);expect(writes).toBe(2);
      await recovered.restore();expect(writes).toBe(2);
      current.metadata.generation!++;
      await expect(recovered.restore()).rejects.toThrow('[CONFLICT]');
    }
    const original:KubeObject={metadata:{name:'service',uid:'uid',generation:1},spec:{module:'service',enabled:false,parameters:{}}};
    let current=structuredClone(original),writes=0;
    const adapter={read:async()=>structuredClone(current),set:async(enabled:boolean,parameters:Record<string,string>)=>{
      writes++;current={...current,metadata:{...current.metadata,generation:current.metadata.generation!+1},spec:{...current.spec,enabled,parameters}};
    }};
    const borrowed=new BorrowedModule(original,join(directory,'already-reset.json'),adapter,async()=>{});
    await borrowed.change(true,{});await borrowed.change(false,{});await borrowed.restore();await borrowed.restore();
    expect(writes).toBe(2);expect(current.spec).toEqual(original.spec);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('HAR-10 acknowledged local users are journaled before postconditions and cleaned by exact UID',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'identity-cleanup-'));
  try {
    for(const fault of ['none','enabled','role','external','wrong-id','ambiguous'] as const) {
      const journal=await ResourceJournal.create(join(directory,fault+'.json'),newRunId(),'fixture-appliance');
      let stored:User|undefined,adapter:CleanupAdapter|undefined,deletes=0;
      const live={journal,config:{dashboardUrl:'https://dashboard.example.invalid',requestTimeoutMs:1000},guard:async()=>{},
        registerDomainCleanup:(_kind:string,value:CleanupAdapter)=>{adapter=value;},context:{request:{fetch:async(url:string,options:{method:string;data?:string})=>{
          let result:unknown={};
          if(options.method === 'GET')result={users:stored ? [stored] : [],total:stored ? 1 : 0};
          else if(options.method === 'POST') {
            const body=JSON.parse(options.data!);
            stored={id:'created-fixture-uid',username:body.username,source:'local',enabled:true,accessLevel:body.accessLevel};
            if(fault === 'ambiguous')throw new Error('Synthetic transport timeout');
            result={...stored,...(fault === 'enabled' ? {enabled:false} : fault === 'role' ? {accessLevel:'user'} :
              fault === 'external' ? {source:'external'} : fault === 'wrong-id' ? {username:'not-the-requested-user'} : {})};
          } else if(options.method === 'DELETE') {
            expect(url).toBe('https://dashboard.example.invalid/api/users/created-fixture-uid');
            expect(JSON.parse(options.data!)).toEqual({usernameConfirmation:stored!.username});stored=undefined;deletes++;
          }
          return {body:async()=>Buffer.from(JSON.stringify(result)),headers:()=>({'content-type':'application/json'}),status:()=>200};
        }}}} as unknown as LiveFoundation;
      const client=new OwnedIdentityClient(live);
      if(fault === 'none')expect((await client.create('operator','operator')).user.source).toBe('local');
      else await expect(client.create('operator','operator')).rejects.toThrow();
      if(['wrong-id','ambiguous'].includes(fault)) {
        expect(journal.entries[0]!.uid).toBeNull();
        await expect(journal.cleanup({identity:adapter!} as Record<ResourceKind,CleanupAdapter>,live.guard)).rejects.toThrow('[CLEANUP]');
        expect(deletes).toBe(0); // A name/prefix is never sufficient adoption proof.
      } else {
        expect(journal.entries[0]!.uid).toBe('created-fixture-uid');
        await journal.cleanup({identity:adapter!} as Record<ResourceKind,CleanupAdapter>,live.guard);
        expect(deletes).toBe(1);expect(journal.recoveryPlan()).toEqual([]);
      }
    }
    expect(ownedLocalIdentity({id:'id',username:'name',source:'external',local:true})).toBe(false);
    expect(ownedLocalIdentity({id:'id',username:'name',source:'local',local:false})).toBe(false);
    expect(ownedLocalIdentity({id:'id',username:'name'})).toBe(false);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('HAR-10 unexpectedly accepted module validation writes restore the exact disabled baseline',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'module-cleanup-'));
  try {
    for(const fault of ['none','uid','generation','spec','lease','ambiguous','rejected'] as const) {
      const original:KubeObject={metadata:{name:'optional-fixture',uid:'module-fixture-uid',generation:1},
        spec:{module:'optional-fixture',enabled:false,parameters:{},applianceRef:{name:'local',namespace:'ai-system'}}};
      let current=structuredClone(original),writes=0,held=true;
      const adapter={read:async()=>structuredClone(current),set:async(enabled:boolean,parameters:Record<string,string>)=>{
        writes++;current={...current,metadata:{...current.metadata,generation:current.metadata.generation!+1},
          spec:{...current.spec,enabled,parameters}};
      }};
      const borrowed=new BorrowedModule(original,join(directory,fault+'.json'),adapter,async()=>{if(!held)throw new Error('Lease lost');});
      if(fault === 'ambiguous') {
        await expect(borrowed.change(true,{},async()=>{throw new Error('Synthetic transport timeout');})).rejects.toThrow();
        await expect(borrowed.restore()).rejects.toThrow('[CLEANUP]');expect(writes).toBe(0);continue;
      }
      if(fault === 'rejected') {
        await expect(borrowed.change(true,{},async()=>{throw new AdministrationRejected(400);})).rejects.toThrow();
        await borrowed.restore();expect(writes).toBe(0);continue;
      }
      // Old product bug: a negative request succeeds. A later failed assertion
      // must not bypass observation and finally restoration.
      await borrowed.change(true,{unknownRegressionField:'invalid'});
      if(fault === 'uid')current.metadata.uid='replacement';
      if(fault === 'generation')current.metadata.generation!++;
      if(fault === 'spec')current.spec!.unrelated='external-change';
      if(fault === 'lease')held=false;
      if(fault === 'none') {
        await borrowed.restore();expect(current.spec).toEqual(original.spec);expect(writes).toBe(2);
        await borrowed.restore();expect(writes).toBe(2);
      } else {await expect(borrowed.restore()).rejects.toThrow();expect(writes).toBe(1);}
    }
  } finally {await rm(directory,{recursive:true,force:true});}
});
