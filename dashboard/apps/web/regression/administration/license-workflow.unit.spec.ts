import {test,expect} from '@playwright/test';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LicenseTransaction,assertLicenseReceiptsRestored,type LicenseSnapshot,type LicenseReceipt} from '../core/license-transaction.ts';
import {licenseDocumentPatch} from '../core/license-baseline.ts';
import {writePrivate} from '../core/private-files.ts';
import {remainingRequirements} from '../profiles/remaining-p0.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {HarnessError} from '../core/errors.ts';
import {saveReport,type CaseResult} from '../core/report.ts';
import {readPrivate} from '../core/private-files.ts';
import {rejectLicenseDocument} from './license-live.ts';
import {AdministrationRejected,type AdministrationApi} from '../core/administration-api.ts';
import {apiRestartReplacement,restartDashboardApi,ServiceRestarter} from '../core/service-restart.ts';
import type {KubeObject} from '../core/observer.ts';
import type {LiveFoundation} from '../core/live-foundation.ts';
const annotation=evidenceAnnotations({id:'HAR-10',layer:'U'});
function fixture(document:string|null='original-document') {
  const original:LicenseSnapshot={uid:'original-uid',revision:'1',installationId:'installation',document,otherData:{installationId:'aW5zdGFsbGF0aW9u',preserved:'unchanged'}};
  let current=structuredClone(original),writes=0,lost=false;
  const receipts:LicenseReceipt[]=[];
  const transaction=new LicenseTransaction(original,{state:async()=>structuredClone(current),guard:async()=>{},
    record:async value=>{receipts.push(structuredClone(value));},restore:async(expected,value)=>{
      expect(current.uid).toBe(expected.uid);expect(current.revision).toBe(expected.revision);writes++;
      current={...current,revision:String(Number(current.revision)+1),document:value};
      if(lost)throw new HarnessError('API');
    }});
  return {original,transaction,receipts,current:()=>current,set:(value:LicenseSnapshot)=>{current=value;},
    apply:(value='selected-document')=>{current={...current,revision:'2',document:value};},
    lost:()=>{lost=true;},writes:()=>writes};
}
test('LIC-02 LIC-03 unsent and rejected requests do not invent a license mutation or restore write',annotation,async()=>{
  for(const attempted of [false,true]) {
    const f=fixture();await f.transaction.begin();if(attempted)await f.transaction.request('selected-document');
    await f.transaction.unchanged();await f.transaction.restore();await f.transaction.restore();
    expect(f.writes()).toBe(0);expect(f.receipts.at(-1)).toMatchObject({state:'restored',restoredRevision:'1'});
    expect(JSON.stringify(f.receipts)).not.toContain('original-document');expect(JSON.stringify(f.receipts)).not.toContain('selected-document');
  }
});
test('LIC-04 cleanup reconciles confirmed and lost activation replies, including a no-document baseline',annotation,async()=>{
  for(const original of ['original-document',null])for(const acknowledged of [false,true]) {
    const f=fixture(original);await f.transaction.begin();await f.transaction.request('selected-document');await f.transaction.forwarded();f.apply();
    if(acknowledged)await f.transaction.acknowledge('2');
    await f.transaction.restore();await f.transaction.restore();
    expect(f.writes()).toBe(1);expect(f.current().document).toBe(original);
    expect(f.current().otherData).toEqual(f.original.otherData);expect(f.receipts.at(-1)?.state).toBe('restored');
  }
  const digest='sha256:'+'a'.repeat(64),pin={container:'api',digest},replicas=new Set(['owned-rs']);
  const replacement:KubeObject={metadata:{name:'replacement',uid:'new',namespace:'fixture',ownerReferences:[{uid:'owned-rs',kind:'ReplicaSet'}]},
    status:{phase:'Running',containerStatuses:[{name:'api',ready:true,imageID:'registry.example.invalid/api@'+digest}]}};
  const old:KubeObject={...structuredClone(replacement),metadata:{...replacement.metadata,name:'old',uid:'old',deletionTimestamp:new Date().toISOString()}};
  // Reproduce the final-baseline race: the new API already serves requests,
  // while the old terminating Pod still contributes a non-Ready container.
  old.status!.containerStatuses![0]!.ready=false;
  expect(apiRestartReplacement([old,replacement],'old',replicas,pin)).toBeUndefined();
  expect(apiRestartReplacement([replacement],'old',replicas,pin)?.metadata.uid).toBe('new');
  for(const patch of [
    {metadata:{...replacement.metadata,deletionTimestamp:new Date().toISOString()}},
    {metadata:{...replacement.metadata,ownerReferences:[{uid:'foreign-rs',kind:'ReplicaSet'}]}},
    {status:{...replacement.status,phase:'Succeeded'}},
    {status:{...replacement.status,containerStatuses:[{name:'api',ready:false,imageID:'registry.example.invalid/api@'+digest}]}},
    {status:{...replacement.status,containerStatuses:[{name:'api',ready:true,imageID:'registry.example.invalid/api@sha256:'+'b'.repeat(64)}]}},
  ])expect(apiRestartReplacement([{...replacement,...patch}],'old',replicas,pin)).toBeUndefined();
  expect(apiRestartReplacement([replacement,{...replacement,metadata:{...replacement.metadata,uid:'extra'}}],'old',replicas,pin)).toBeUndefined();
  expect(apiRestartReplacement([replacement,{...replacement,metadata:{...replacement.metadata,uid:'extra-unready'},
    status:{phase:'Pending'}}],'old',replicas,pin)).toBeUndefined();
  // Exercise the real restart workflow as well as the predicate. With the old
  // implementation it writes its final receipt after the first post-delete
  // read, while the old Pod still exists; this counterexample then fails.
  const directory=await mkdtemp(join(tmpdir(),'api-restart-')),previous=process.env.REGRESSION_RUN_DIR;
  const verify=ServiceRestarter.prototype.verifyNamespace,remove=ServiceRestarter.prototype.deletePod;
  let deleted=false,reads=0;
  try {
    process.env.REGRESSION_RUN_DIR=directory;
    ServiceRestarter.prototype.verifyNamespace=async()=>{};
    ServiceRestarter.prototype.deletePod=async pod=>{expect(pod.metadata.uid).toBe('old');deleted=true;};
    const live={config:{requestTimeoutMs:1000,expected:{images:[{...pin,namespace:'fixture',deployment:'ai-appliance-dashboard-api'}]}},
      guard:async()=>{},api:{session:async()=>({roles:['magicstick-admin']})},observer:{
        get:async()=>({metadata:{uid:'deployment'}}),list:async(resource:string)=>{
          if(resource==='replicasets.apps')return [{metadata:{uid:'owned-rs',ownerReferences:[{uid:'deployment'}]}}];
          if(!deleted)return [{...old,metadata:{...old.metadata,deletionTimestamp:undefined},status:replacement.status}];
          return ++reads===1?[old,replacement]:[replacement];
        },
      }} as unknown as LiveFoundation;
    await restartDashboardApi(live,{approveApiRestart:true,kubeconfig:'synthetic-unused'});
    expect(reads).toBe(2);
    const files=await readdir(directory);expect(files).toHaveLength(1);
    expect(JSON.parse(await readPrivate(join(directory,files[0]!)))).toMatchObject({state:'verified',podUid:'old',replacementUid:'new'});
  }finally{
    ServiceRestarter.prototype.verifyNamespace=verify;ServiceRestarter.prototype.deletePod=remove;
    if(previous===undefined)delete process.env.REGRESSION_RUN_DIR;else process.env.REGRESSION_RUN_DIR=previous;
    await rm(directory,{recursive:true,force:true});
  }
});
test('LIC-04 an idempotent equal-document PUT need not advance resourceVersion and needs no restore write',annotation,async()=>{
  const f=fixture();await f.transaction.begin();await f.transaction.request('original-document');await f.transaction.forwarded();await f.transaction.acknowledge('1');
  await f.transaction.restore();expect(f.writes()).toBe(0);expect(f.receipts.at(-1)?.state).toBe('restored');
});
test('LIC-04 changed UID, installation, unknown data, document or confirmed revision prevents overwrite',annotation,async()=>{
  for(const change of [
    (s:LicenseSnapshot)=>({...s,uid:'recreated'}),(s:LicenseSnapshot)=>({...s,installationId:'other'}),
    (s:LicenseSnapshot)=>({...s,otherData:{...s.otherData,preserved:'changed'}}),
    (s:LicenseSnapshot)=>({...s,document:'human-document'}),(s:LicenseSnapshot)=>({...s,revision:'3'}),
    (s:LicenseSnapshot)=>({...s,document:'original-document',revision:'3'}),
  ]) {
    const f=fixture();await f.transaction.begin();await f.transaction.request('selected-document');await f.transaction.forwarded();f.apply();await f.transaction.acknowledge('2');f.set(change(f.current()));
    await expect(f.transaction.restore()).rejects.toMatchObject({code:'CONFLICT',stage:'license-restore'});
    expect(f.writes()).toBe(0);expect(f.receipts.at(-1)?.state).not.toBe('restored');
  }
});
test('LIC-04 a committed restore with lost response is recognized on retry without another write',annotation,async()=>{
  const f=fixture();await f.transaction.begin();await f.transaction.request('selected-document');await f.transaction.forwarded();f.apply();await f.transaction.acknowledge('2');f.lost();
  await expect(f.transaction.restore()).rejects.toMatchObject({code:'API',stage:'license-restore'});
  expect(f.receipts.at(-1)?.state).toBe('restoring');await f.transaction.restore();expect(f.writes()).toBe(1);
  expect(f.current().document).toBe('original-document');expect(f.receipts.at(-1)?.state).toBe('restored');
});
test('HAR-07 a failed final receipt write is durably repaired on retry without another license mutation',annotation,async()=>{
  const original:LicenseSnapshot={uid:'uid',revision:'1',installationId:'installation',document:'original',otherData:{}};
  let current=structuredClone(original),writes=0,failed=false,persisted='';
  const tx=new LicenseTransaction(original,{state:async()=>current,guard:async()=>{},
    restore:async(_expected,document)=>{writes++;current={...current,revision:'3',document};},
    record:async receipt=>{if(receipt.state==='restored'&&!failed){failed=true;throw new HarnessError('PRIVATE_FILE');}persisted=receipt.state;}});
  await tx.begin();await tx.request('selected');await tx.forwarded();current={...current,revision:'2',document:'selected'};await tx.acknowledge('2');
  await expect(tx.restore()).rejects.toMatchObject({code:'PRIVATE_FILE',stage:'license-restore'});expect(persisted).toBe('restoring');
  await tx.restore();expect(persisted).toBe('restored');expect(writes).toBe(1);
});
test('HAR-07 unfinished legacy and case-specific receipts fence cleanup even with an empty owned journal',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'license-receipts-'));
  try {
    for(const name of ['license-transaction.json','license-transaction-lic-04.json','license-baseline-lic-01.json']) {
      await writePrivate(join(directory,name),{version:1,state:'reviewed'});
      await expect(assertLicenseReceiptsRestored(directory)).rejects.toMatchObject({code:'CLEANUP',outcome:'Failed'});
      await writePrivate(join(directory,name),{version:1,state:'restored'});await assertLicenseReceiptsRestored(directory);
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('LIC-04 document restoration is a UID/revision/data CAS and never deletes the installation Secret',annotation,()=>{
  const original={metadata:{name:'magicstick-license',namespace:'identity-system',uid:'exact',resourceVersion:'7'},
    data:{installationId:Buffer.from('installation').toString('base64'),'license.json':Buffer.from('test-document').toString('base64'),preserved:'eA=='}};
  expect(licenseDocumentPatch(original,'installation','original-document')).toEqual([
    {op:'test',path:'/metadata/uid',value:'exact'},{op:'test',path:'/metadata/resourceVersion',value:'7'},
    {op:'test',path:'/data',value:original.data},{op:'replace',path:'/data/license.json',value:Buffer.from('original-document').toString('base64')},
  ]);
});
test('LIC-03 verification rejection is independent and cannot pass on conflict, outage, unauthorized or accepted input',annotation,async()=>{
  for(const status of [400,422,409,403,503,200]) {
    let reads=0,requests=0;
    const api={write:async(_permit:unknown,action:()=>Promise<unknown>,beforeSend?:()=>Promise<void>)=>{await beforeSend?.();return action();},api:{
      inspectLicense:async()=>({candidate:{valid:false,state:'expired'}}),
      importLicense:async()=>{requests++;if(status!==200)throw new AdministrationRejected(status);return {};},
    }} as unknown as AdministrationApi;
    const transaction={unchanged:async()=>{reads++;},request:async()=>{},forwarded:async()=>{}};
    const checked=rejectLicenseDocument(api,transaction,'synthetic-invalid-document','1');
    if([400,422].includes(status)){expect(await checked).toBe('expired');expect(reads).toBe(2);}
    else await expect(checked).rejects.toMatchObject({code:'API',outcome:'Failed'});
    expect(requests).toBe(1);
  }
  const api={write:async(_permit:unknown,action:()=>Promise<unknown>)=>action(),api:{inspectLicense:async()=>({candidate:{valid:false,state:'expired'}}),
    importLicense:async()=>{throw new AdministrationRejected(400);}}} as unknown as AdministrationApi;
  await expect(rejectLicenseDocument(api,{request:async()=>{},forwarded:async()=>{},unchanged:async()=>{throw new HarnessError('API');}},'invalid','1')).rejects.toMatchObject({code:'API'});
});
test('LIC-04 an armed but unsent action cannot adopt a changed license, even with the same candidate bytes',annotation,async()=>{
  const f=fixture();await f.transaction.begin();await f.transaction.request('selected-document');f.apply();
  await expect(f.transaction.acknowledge('2')).rejects.toMatchObject({code:'API'});
  await expect(f.transaction.restore()).rejects.toMatchObject({code:'CONFLICT',stage:'license-restore'});expect(f.writes()).toBe(0);
});
test('Focused LIC-02 through LIC-04 diagnostics require only their own live tuples, never a full-phase pass',annotation,()=>{
  for(const id of ['LIC-02','LIC-03','LIC-04']) {
    const required=remainingRequirements('phase5-live',id)!;
    expect(new Set(required.map(item=>item.id))).toEqual(new Set([id]));expect(required.every(item=>'AEON'.includes(item.layer))).toBe(true);
  }
  for(const [mode,id] of [['phase5-live','MESH-03'],['phase5-fast','LIC-02'],['phase5-live','LIC-99']])
    expect(()=>remainingRequirements(mode!,id)).toThrow('[CONFIG]');
});
test('HAR-10 a focused LIC-04 report cannot claim that the other Phase 5 cases passed',annotation,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'license-scoped-report-')),old=process.env.REGRESSION_REMAINING_CASE;
  try {
    process.env.REGRESSION_REMAINING_CASE='LIC-04';const required=remainingRequirements('phase5-live')!;
    await saveReport(directory,'reg-11111111-1111-4111-8111-111111111111',required.map(item=>({...item,variant:item.variant as CaseResult['variant'],outcome:'Passed' as const,durationMs:0})),['LIC-04'],'unknown','phase5-live');
    const report=JSON.parse(await readPrivate(join(directory,'summary.json')));
    expect(report.acceptable).toBe(true);expect(report.fullPhase5Accepted).toBe(false);expect(report.scope).toContain('LIC-04 only');
    expect(new Set(report.cases.map((item:{id:string})=>item.id))).toEqual(new Set(['LIC-04']));
  }finally{if(old===undefined)delete process.env.REGRESSION_REMAINING_CASE;else process.env.REGRESSION_REMAINING_CASE=old;await rm(directory,{recursive:true,force:true});}
});
