import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {User} from '@magicstick/dashboard-contracts';
import type {LiveFoundation} from '../core/live-foundation.ts';
import type {CleanupAdapter,ResourceKind} from '../core/journal.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {OwnedIdentityClient,ownedLocalIdentity} from '../core/owned-identity.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';
import type {KubeObject} from '../core/observer.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {AdministrationRejected} from '../core/administration-api.ts';

const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
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
