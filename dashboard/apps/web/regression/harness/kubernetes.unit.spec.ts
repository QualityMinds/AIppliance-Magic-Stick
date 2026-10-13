import {test,expect} from '@playwright/test';
import {KubernetesProgress,publicResult} from '../core/kubernetes-progress.ts';
import {runHostDrill} from '../core/host-drill.ts';
import {blockedAction} from '../core/report.ts';
import {blockerDescription} from '../core/blocker-description.ts';
import {privateDirectory,writePrivate,readPrivate} from '../core/private-files.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {componentSuite,pythonSuite} from '../components/owning.ts';

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
test('HAR-10 blocked results retain source phase, stage, variant and filtered trace location',()=>{
  const value=publicResult({counts:{Blocked:1},executionCounts:{Blocked:1},cases:[{id:'BOOT-02',layer:'O',variant:'p6-boot',outcome:'Blocked',reason:'EXTERNAL_RUNNER',
    stage:'host-boot',durationMs:0,traceRunId:'reg-11111111-2222-3333-4444-555555555555',executionId:'a'.repeat(24),message:'synthetic-secret'}]},
    {phases:[{phase:6,state:'Blocked',counts:{Blocked:1},executionCounts:{Blocked:1}}]});
  expect(value.cases[0]).toMatchObject({id:'BOOT-02',phase:6,stage:'host-boot',reason:'EXTERNAL_RUNNER'});
  expect(value.cases[0]!.tracePath).toContain('/traces/'+'a'.repeat(24));expect(JSON.stringify(value)).not.toContain('synthetic-secret');
  expect(blockedAction('EXTERNAL_RUNNER')).toContain('external Docker runner');
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
