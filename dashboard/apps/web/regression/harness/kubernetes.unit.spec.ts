import {test,expect} from '@playwright/test';
import {KubernetesProgress,publicResult} from '../core/kubernetes-progress.ts';
import {completeReportPublication,maximumReportBytes,publishReportArtifacts} from '../core/kubernetes-report.ts';
import {setupWorkerMarker} from '../core/preparation-diagnostic.ts';
import {runHostDrill} from '../core/host-drill.ts';
import {blockedAction} from '../core/report.ts';
import {blockerDescription} from '../core/blocker-description.ts';
import {privateDirectory,writePrivate,readPrivate} from '../core/private-files.ts';
import {mkdtemp,rm,lstat,readFile,symlink,truncate} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawnSync} from 'node:child_process';
import {componentSuite,pythonSuite} from '../components/owning.ts';
import {saveKubernetesRegistration} from '../core/kubernetes-registration.ts';

test('HAR-02 HAR-07 native registration follows renamed origins only for the exact same registered installation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'native-registration-')),filename=join(directory,'lab-registration.json');
  const registration={version:1,kind:'disposable-regression-lab',policyVersion:1,id:'11111111-2222-3333-4444-555555555555',
    applianceUid:'appliance-fixture',nodeUids:['node-b','node-a'],createdAt:'2026-10-01T00:00:00Z',
    dashboardUrl:'https://old.example.local',identityUrl:'https://id.old.example.local'};
  try {
    await saveKubernetesRegistration(filename,registration);
    const original=await readPrivate(filename);
    // An equivalent JSON object/order is not a changed registration.
    await saveKubernetesRegistration(filename,Object.fromEntries(Object.entries({...registration,nodeUids:['node-a','node-b']}).reverse()));
    expect(await readPrivate(filename)).toBe(original);
    const renamed={...registration,dashboardUrl:'https://renamed.example.local',identityUrl:'https://id.renamed.example.local'};
    expect(JSON.stringify(registration)).not.toBe(JSON.stringify(renamed)); // Former startup guard rejects this real transition.
    await saveKubernetesRegistration(filename,renamed);
    expect(JSON.parse(await readPrivate(filename))).toEqual(renamed);
    expect((await lstat(filename)).mode&0o077).toBe(0);
    const after=await readPrivate(filename);
    for(const change of [{id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},{applianceUid:'other-appliance'},
      {nodeUids:['other-node']},{createdAt:'2026-10-02T00:00:00Z'},{futureIdentity:'foreign'}]) {
      await expect(saveKubernetesRegistration(filename,{...renamed,...change})).rejects.toThrow('[IDENTITY]');
      expect(await readPrivate(filename)).toBe(after);
    }
    for(const change of [{policyVersion:2},{kind:'other-lab'},{identityUrl:'http://id.renamed.example.local'}]) {
      await expect(saveKubernetesRegistration(filename,{...renamed,...change})).rejects.toThrow('[LAB]');
      expect(await readPrivate(filename)).toBe(after);
    }
    const link=join(directory,'unsafe.json');await symlink(filename,link);
    await expect(saveKubernetesRegistration(link,renamed)).rejects.toThrow('[PRIVATE_FILE]');
    expect(await readPrivate(filename)).toBe(after);
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-07 recovery accepts only fixed setup stage/detail markers',()=>{
  expect(setupWorkerMarker('[SETUP_STAGE:kubernetes-access] [detail:ERR_MODULE_NOT_FOUND]')).toEqual(
    {setupStage:'kubernetes-access',detail:'ERR_MODULE_NOT_FOUND'});
  expect(setupWorkerMarker('[SETUP_STAGE:run-recovery]')).toEqual({setupStage:'run-recovery'});
  expect(setupWorkerMarker('[SETUP_STAGE:run-recovery] private-token')).toBeUndefined();
  expect(setupWorkerMarker('[SETUP_STAGE:foreign]')).toBeUndefined();
  expect(setupWorkerMarker('[SETUP_STAGE:login] [detail:SECRET]')).toBeUndefined();
});

test('HAR-10 Kubernetes progress comes from structured events, not private console output',()=>{
  const progress=new KubernetesProgress([0,1,2]);
  progress.consume({version:1,event:'phase-start',phase:0});progress.consume({version:1,event:'step-start',step:'selftest',index:1,total:5});
  progress.consume({version:1,event:'test-start',position:1,total:10,ids:['HAR-10'],description:'synthetic-secret'});
  progress.consume({version:1,event:'test-end',position:1,total:10,ids:['HAR-10'],outcome:'Blocked'});
  const value=progress.snapshot();expect(value.executionCounts.Blocked).toBe(1);expect(value.percent).toBeGreaterThanOrEqual(0);
  expect(JSON.stringify(value)).not.toContain('synthetic-secret');expect(progress.snapshot(true).percent).toBeLessThan(100);
  for(const phase of [0,1,2])progress.consume({version:1,event:'phase-end',phase,outcome:'Blocked'});
  expect(progress.snapshot(true).percent).toBe(100);
});
test('HAR-10 Kubernetes progress loads in Node strip-only mode and binds the run owner',()=>{
  const moduleUrl=new URL('../core/kubernetes-progress.ts',import.meta.url).href;
  execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',
    `import assert from 'node:assert/strict';
     const {KubernetesProgress}=await import(${JSON.stringify(moduleUrl)});
     const progress=new KubernetesProgress([0],'appliance-fixture');
     const runId='reg-11111111-2222-3333-4444-555555555555';
     progress.consume({version:1,event:'owner-start',targetUid:'foreign',runId});
     assert.deepEqual(progress.snapshot().ownedRunIds,[]);
     progress.consume({version:1,event:'owner-start',targetUid:'appliance-fixture',runId});
     assert.deepEqual(progress.snapshot().ownedRunIds,[runId]);`],
    {stdio:'pipe',timeout:10_000,env:{...process.env,NODE_OPTIONS:''}});
});
test('HAR-02 HAR-10 Kubernetes test and cleanup entrypoints import in native strip-only mode before private access',()=>{
  for(const entrypoint of ['kubernetes.mjs','kubernetes-recovery.mjs','kubernetes-nondestructive.mjs','kubernetes-diagnostic.mjs']) {
    const result=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(new URL('../'+entrypoint,import.meta.url))],
      {encoding:'utf8',timeout:10_000,env:{...process.env,NODE_OPTIONS:'',REGRESSION_RUN_UID:'',REGRESSION_DIAGNOSTIC_SELECTION:entrypoint==='kubernetes-diagnostic.mjs'?'remaining':undefined,REGRESSION_PHASES:'4',REGRESSION_TEST_MODE:entrypoint==='kubernetes-nondestructive.mjs'?'non-destructive':'full'}});
    expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status).toBe(1);
    expect(result.stderr).toContain('Error: Invalid run identity.');
    expect(result.stderr).not.toMatch(/SyntaxError|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
  }
});
test('HAR-10 a Phase 3-only run counts one selected phase and exports no other phase results',()=>{
  const progress=new KubernetesProgress([3]);
  progress.consume({version:1,event:'phase-start',phase:3});
  expect(progress.snapshot()).toMatchObject({totalPhases:1,currentPhase:3,completedPhases:0});
  progress.consume({version:1,event:'phase-end',phase:3,outcome:'Passed'});
  expect(progress.snapshot(true)).toMatchObject({totalPhases:1,completedPhases:1,percent:100});
  const value=publicResult({counts:{Passed:1},executionCounts:{Passed:1},cases:[]},
    {phases:[{phase:3,state:'Passed',counts:{Passed:1},executionCounts:{Passed:1}}]});
  expect(value.phases.map(phase=>phase.phase)).toEqual([3]);
});
test('HAR-10 blocked results retain source phase, stage, variant and filtered trace location',()=>{
  const value=publicResult({counts:{Blocked:1},executionCounts:{Blocked:1},cases:[{id:'BOOT-02',layer:'O',variant:'p6-boot',outcome:'Blocked',reason:'EXTERNAL_RUNNER',
    stage:'host-boot',durationMs:0,traceRunId:'reg-11111111-2222-3333-4444-555555555555',executionId:'a'.repeat(24),message:'synthetic-secret'}]},
    {phases:[{phase:6,state:'Blocked',counts:{Blocked:1},executionCounts:{Blocked:1}}]});
  expect(value.cases[0]).toMatchObject({id:'BOOT-02',phase:6,stage:'host-boot',reason:'EXTERNAL_RUNNER'});
  expect(value.cases[0]!.tracePath).toContain('/traces/'+'a'.repeat(24));expect(JSON.stringify(value)).not.toContain('synthetic-secret');
  expect(blockedAction('EXTERNAL_RUNNER')).toContain('external Docker runner');
});
test('HAR-10 Kubernetes progress and sanitized results expose blocked causes without private metadata',()=>{
  const progress=new KubernetesProgress([0]);
  for(const [reason,kind] of [['CAPABILITY','prerequisite'],['RECOVERY','failure'],['CANCELLED','cancelled'],['DEPENDENCY','unknown']])
    progress.consume({version:1,event:'test-end',position:1,total:4,ids:['HAR-10'],outcome:'Blocked',reason,blockedBy:{kind,message:'synthetic-secret'}});
  expect(progress.snapshot().executionBlockedCounts).toEqual({prerequisite:1,failure:1,cancelled:1,unknown:1});
  const value=publicResult({counts:{Blocked:1},executionCounts:{Blocked:1},cases:[{
    id:'LIFE-04',layer:'E',variant:'p3-runtime-start',outcome:'Blocked',reason:'DEPENDENCY',durationMs:0,executionId:'a'.repeat(24),executionOutcome:'Blocked',
    blockedBy:{kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped',message:'synthetic-secret'}
  }]},{phases:[{phase:3,state:'Blocked',counts:{Blocked:1},executionCounts:{Blocked:1},
    blockedCounts:{prerequisite:0,failure:1,cancelled:0,unknown:0},executionBlockedCounts:{prerequisite:0,failure:1,cancelled:0,unknown:0}}]});
  expect(value.cases[0]!.blockedBy).toEqual({kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped'});
  expect(value.blockedCounts.failure).toBe(1);expect(value.executionBlockedCounts.failure).toBe(1);
  expect(value.phases[0]!.blockedCounts?.failure).toBe(1);expect(JSON.stringify(value)).not.toContain('synthetic-secret');
});
test('HAR-02 HAR-10 preparation diagnostics and live evidence remain separate from passed isolated checks',()=>{
  const value=publicResult({automaticPreparation:{version:1,outcome:'Failed',reason:'REVISION',setupStage:'input-validation',
    stderr:'synthetic-secret',message:'synthetic-secret'},counts:{Passed:1,Failed:1,Blocked:1},executionCounts:{Passed:1,Failed:0,Blocked:0},
    cases:[{id:'HAR-10',layer:'U',environment:'fixture',outcome:'Passed',durationMs:1},
      {id:'HAR-02',layer:'A',environment:'live',outcome:'Failed',reason:'REVISION',durationMs:0},
      {id:'LIFE-01',layer:'E',environment:'live',outcome:'Blocked',reason:'PREPARATION_FAILED',durationMs:0,
        blockedBy:{kind:'failure',caseId:'HAR-02',reason:'REVISION'}}]}, {phases:[]});
  expect(value.preparation).toMatchObject({outcome:'Failed',reason:'REVISION',setupStage:'input-validation'});
  expect(value.preparation?.message).toContain('input-validation');expect(value.preparation?.action).toBeTruthy();
  expect(value.evidenceCounts).toEqual({fixture:{Passed:1,Failed:0,Blocked:0},live:{Passed:0,Failed:1,Blocked:1}});
  expect(JSON.stringify(value)).not.toContain('synthetic-secret');
  const legacy=publicResult({cases:[{id:'HAR-10',layer:'U',outcome:'Passed',durationMs:1}]},{phases:[]});
  expect(legacy).not.toHaveProperty('evidenceCounts');expect(legacy).not.toHaveProperty('preparation');
  const invalid=publicResult({automaticPreparation:{version:1,outcome:'synthetic-secret',reason:'synthetic-secret'}},{phases:[]});
  expect(invalid.preparation).toMatchObject({outcome:'Failed',reason:'CONFIG'});
  expect(JSON.stringify(invalid)).not.toContain('synthetic-secret');
});
test('HAR-02 Kubernetes host-disconnect drills block before any host mutation',async()=>{
  const previous=process.env.REGRESSION_EXECUTION;process.env.REGRESSION_EXECUTION='kubernetes';
  try{await expect(runHostDrill(null as never,'BOOT-02')).rejects.toThrow('[EXTERNAL_RUNNER]');
    await expect(runHostDrill(null as never,'NET-05')).rejects.toThrow('[EXTERNAL_RUNNER]');}
  finally{if(previous===undefined)delete process.env.REGRESSION_EXECUTION;else process.env.REGRESSION_EXECUTION=previous;}
});
test('HAR-02 HAR-10 owning Kubernetes test intent, privacy, scheduling and report contracts',()=>{
  pythonSuite('../../../magic-cluster/apps/dashboard',['test_regression_api.RegressionApiTests']);
  pythonSuite('../../../magic-cluster/platform/magicstick-operator/controller',['test_regression_runs.RegressionRunsTests']);
  pythonSuite('../../..',['tests.test_regression_report_server','tests.test_regression_image_promotion']);
});
test('HAR-10 owning regression dashboard guards actions and preserves blocked traceability',()=>componentSuite('src/pages/RegressionPage.test.tsx',[]));
test('HAR-10 regression downloads and mutations reuse the shared authenticated API contract',()=>componentSuite('src/RegressionApi.test.ts',[]));
test('HAR-10 missing prerequisites are described per case and never copied from private values',()=>{
  expect(blockerDescription('PREREQUISITE','MESH-03','p7-mesh-03','A')).toContain('second, separately registered');
  expect(blockerDescription('PREREQUISITE','SSO-02','p5-sso-02','A')).toContain('OIDC/SAML');
  expect(blockerDescription('PREREQUISITE','MGPU-01','p3-multigpu-vllm-4','A')).toContain('four');
  expect(blockerDescription('PREREQUISITE','HAR-10',undefined,'B')).toContain('isolated');
  expect(blockerDescription('EXTERNAL_RUNNER','BOOT-02','p6-boot-02','O')).toContain('external Docker runner');
});
test('HAR-10 full campaign reports have an explicit bound without weakening private input limits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-campaign-'));
  try{
    await privateDirectory(directory);const file=join(directory,'summary.json');await writePrivate(file,'x'.repeat(2*1024*1024));
    await expect(readPrivate(file)).rejects.toThrow('[PRIVATE_FILE]');
    expect((await readPrivate(file,8*1024*1024)).length).toBe(2*1024*1024);
    await expect(readPrivate(file,64*1024*1024)).rejects.toThrow('[PRIVATE_FILE]');
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('HAR-07 HAR-10 export failure retains completed campaign results without inventing recovery',async()=>{
  const result=publicResult({counts:{Passed:4532,Failed:16,Blocked:145},executionCounts:{Passed:3402,Failed:6,Blocked:56},
    recoveryFenceActive:false,cases:[{id:'LIFE-02',layer:'A',environment:'live',outcome:'Failed',reason:'API',stage:'model-inference',durationMs:90_000}]},
    {phases:[{phase:2,state:'Failed',counts:{Passed:479,Failed:3,Blocked:14},executionCounts:{Passed:358,Failed:1,Blocked:3}}]});
  for(const recoveryRequired of [false,true]) {
    const snapshot={result,credentialRecoveryRequired:recoveryRequired,reportAvailable:false,outcome:'Failed' as const,message:'Execution finished.'};
    expect(await completeReportPublication(snapshot,async()=>{throw new Error('synthetic-private-path-and-credential');})).toBe(false);
    expect(snapshot.credentialRecoveryRequired).toBe(recoveryRequired);expect(snapshot.reportAvailable).toBe(false);
    expect(snapshot.result.executionCounts).toEqual(result.executionCounts);expect(snapshot.result.phases).toEqual(result.phases);
    expect(snapshot.result.counts).toEqual({...result.counts,Failed:17});
    expect(snapshot.result.cases).toEqual([expect.objectContaining({id:'HAR-10',reason:'REPORT_EXPORT',stage:'report-export'}),...result.cases]);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-private');expect(snapshot.message).not.toContain('Setup recovery is required');
  }
  const clean={result,credentialRecoveryRequired:false,reportAvailable:false,outcome:'Failed' as const,message:'Execution finished.'};
  expect(await completeReportPublication(clean,async()=>{})).toBe(true);expect(clean.result).toBe(result);expect(clean.reportAvailable).toBe(true);
});

test('HAR-10 HAR-11 report publication validates every product before exposing downloads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'magicstick-report-export-'));
  try {
    const source=join(directory,'source'),published=join(directory,'published');
    await privateDirectory(source);await privateDirectory(published);
    const products=['summary.html','junit.xml','report-artifacts.tar.gz'];
    for(const name of products)await writePrivate(join(source,name),'sanitized '+name);
    await truncate(join(source,'junit.xml'),maximumReportBytes+1);
    await expect(publishReportArtifacts(source,published)).rejects.toMatchObject({code:'REPORT_EXPORT',stage:'report-export'});
    await expect(lstat(join(published,'summary.html'))).rejects.toMatchObject({code:'ENOENT'});
    await writePrivate(join(source,'junit.xml'),'sanitized junit.xml');
    await rm(join(source,'report-artifacts.tar.gz'));await symlink(join(source,'summary.html'),join(source,'report-artifacts.tar.gz'));
    await expect(publishReportArtifacts(source,published)).rejects.toMatchObject({code:'REPORT_EXPORT'});
    await rm(join(source,'report-artifacts.tar.gz'));await writePrivate(join(source,'report-artifacts.tar.gz'),'sanitized report-artifacts.tar.gz');
    await publishReportArtifacts(source,published);
    for(const name of products) {
      expect(await readFile(join(published,name),'utf8')).toBe('sanitized '+name);
      expect((await lstat(join(published,name))).mode&0o077).toBe(0);
    }
    const chunks='sanitized report chunk '.repeat(10_000);
    await writePrivate(join(source,'junit.xml'),chunks);await publishReportArtifacts(source,published);
    expect(await readFile(join(published,'junit.xml'),'utf8')).toBe(chunks);
  }finally{await rm(directory,{recursive:true,force:true});}
});
