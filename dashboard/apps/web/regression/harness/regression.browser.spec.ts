import {test,expect,type Request} from '@playwright/test';
import {fixturePage,origin} from '../fixtures/dashboard.ts';

for(const viewport of ['desktop','mobile'] as const)test(`HAR-02 HAR-10 UX-02 ${viewport} failed preparation explains why passed isolated checks are not live acceptance`,async({page},info)=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  let writes=0;
  const payload={registered:true,applianceUid:'fixture-appliance',runtimeAvailable:true,sourceRevision:'b'.repeat(40),message:'',
    executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],runs:[{
      id:'regression-'+'a'.repeat(32),uid:'fixture-run-uid',createdAt:'2026-10-14T12:00:00Z',sourceRevision:'b'.repeat(40),
      phase:'Failed',phases:[0,1,2,3,4,5,6,7,8],message:'Regression execution finished.',credentialsCleaned:true,reportAvailable:true,
      progress:{percent:100,completedPhases:9,totalPhases:9},result:{counts:{Passed:100,Failed:1,Blocked:30},
        executionCounts:{Passed:80,Failed:0,Blocked:0},omittedCases:0,recoveryRequired:false,phases:[],cases:[],
        evidenceCounts:{fixture:{Passed:100,Failed:0,Blocked:0},live:{Passed:0,Failed:1,Blocked:30}},
        preparation:{version:1,outcome:'Failed',reason:'REVISION',setupStage:'input-validation',
          message:'Automatic preparation: Failed (REVISION); setup stage: input-validation.',action:'Check the installed image and source revisions.'}}}]};
  await fixturePage(page,{'/api/regression':(request:Request)=>{if(request.method()!=='GET')writes++;return payload;}});
  await page.goto(origin+'/#/system/regression');
  const preparation=page.getByRole('alert',{name:'Automatic preparation result'});
  await expect(preparation).toContainText('input-validation');await expect(preparation).toContainText('REVISION');
  await expect(preparation).toContainText('Passed isolated checks are not live acceptance');
  await expect(page.getByLabel('Live evidence results')).toContainText('0 passed · 1 failed · 30 blocked');
  await page.reload();await expect(preparation).toBeVisible();expect(writes).toBe(0);
  await expect(page.getByRole('button',{name:'Download report',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`regression-preparation-${viewport}.png`),fullPage:true});
});

for(const viewport of ['desktop','mobile'] as const)test(`HAR-04 HAR-07 HAR-10 UX-02 ${viewport} stale-lock recovery is confirmed, bounded and never starts a suite`,async({page},info)=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  const revision='11111111-2222-3333-4444-555555555555:42';let requested=false,external=false;
  const writes:string[]=[];
  const payload=()=>({registered:true,applianceUid:'fixture-appliance',runtimeAvailable:true,sourceRevision:'b'.repeat(40),message:'',
    executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],
    lock:{state:requested?'free':'stale',canRecover:!external&&!requested,revision,
      message:external?'The old lock needs its external runner journal.':'Only the exact old journal will be recovered.'},
    runs:requested?[{id:'regression-'+'a'.repeat(32),uid:'fixture-run-uid',createdAt:'2026-10-13T12:00:00Z',
      sourceRevision:'b'.repeat(40),operation:'recover-lock',phases:[],phase:'Passed',message:'Recovery verified. No tests were started.',
      credentialsCleaned:true,reportAvailable:true,progress:{percent:100,totalPhases:0}}]:[]});
  await fixturePage(page,{'/api/regression':payload,
    '/api/regression/recover-lock':(request:Request)=>{
      expect(request.method()).toBe('POST');expect(request.postDataJSON()).toEqual({
        requestId:expect.stringMatching(/^[a-f0-9]{32}$/),expectedLockRevision:revision,acknowledgeCleanup:true});
      writes.push('recovery');requested=true;return {};
    },'/api/regression/runs':()=>{writes.push('unexpected-suite');return {};}});
  await page.goto(origin+'/#/system/regression');
  const recover=page.getByRole('button',{name:'Recover stale lock',exact:true});
  await expect(recover).toBeEnabled();await page.reload();expect(writes).toEqual([]);
  await recover.focus();await page.keyboard.press('Enter');
  const dialog=page.getByRole('dialog',{name:'Recover stale regression lock'});
  await expect(dialog.getByText(/No new regression tests will start/)).toBeVisible();expect(writes).toEqual([]);
  await dialog.getByRole('button',{name:'Recover lock',exact:true}).click();
  await expect(page.getByText('Lock recovery',{exact:true})).toBeVisible();
  await expect(page.getByText(/No test phases are selected/)).toBeVisible();expect(writes).toEqual(['recovery']);
  requested=false;external=true;await page.getByRole('button',{name:'Refresh tests',exact:true}).click();
  await expect(recover).toBeDisabled();await expect(page.getByText('The old lock needs its external runner journal.')).toBeVisible();
  await expect(page.getByRole('button',{name:'Start regression tests',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`regression-lock-recovery-${viewport}.png`),fullPage:true});
});

for(const viewport of ['desktop','mobile'] as const)test(`HAR-10 UX-02 ${viewport} regression results distinguish prerequisites from failure dependencies`,async({page},info)=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  const counts={Passed:10,Failed:1,Blocked:2},executionCounts={Passed:5,Failed:1,Blocked:1},blockedCounts={prerequisite:1,failure:1,cancelled:0,unknown:0};
  const payload={registered:true,applianceUid:'fixture-appliance',runtimeAvailable:true,sourceRevision:'b'.repeat(40),message:'',
    executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],runs:[{
      id:'regression-'+'a'.repeat(32),uid:'fixture-run-uid',createdAt:'2026-10-13T12:00:00Z',sourceRevision:'b'.repeat(40),
      phase:'Failed',phases:[0,1,2,3,4,5,6,7,8],message:'The model-stop check failed; dependent start was not reached.',credentialsCleaned:true,reportAvailable:true,
      progress:{percent:100,completedPhases:9,totalPhases:9},result:{counts,executionCounts,blockedCounts,
        executionBlockedCounts:{prerequisite:1,failure:0,cancelled:0,unknown:0},recoveryRequired:false,omittedCases:0,
        phases:[{phase:3,outcome:'Failed',counts,executionCounts,blockedCounts}],
        cases:[{id:'LIFE-03',outcome:'Failed',layer:'E',variant:'p3-runtime-stop',reason:'DEADLINE',stage:'model-stopped',message:'Model stop timed out.',action:'Inspect the stop operation.',durationMs:1},
          {id:'HW-01',outcome:'Blocked',layer:'A',variant:'p3-inventory',reason:'CAPABILITY',message:'Required GPU hardware is missing.',action:'Provide GPU hardware.',durationMs:0,blockedBy:{kind:'prerequisite',reason:'CAPABILITY'}},
          {id:'LIFE-04',outcome:'Blocked',layer:'E',variant:'p3-runtime-start',reason:'DEPENDENCY',message:'Model stop failed earlier.',action:'Fix the earlier model-stop failure.',durationMs:0,
            blockedBy:{kind:'failure',caseId:'LIFE-03',reason:'DEADLINE',stage:'model-stopped',executionId:'a'.repeat(24),traceRunId:'reg-11111111-2222-3333-4444-555555555555'}}]}
    }]};
  await fixturePage(page,{'/api/regression':payload});await page.goto(origin+'/#/system/regression');
  await page.getByText('Failures and blocked checks (3)',{exact:true}).click();
  await expect(page.getByText('Blocked by prerequisite',{exact:true})).toBeVisible();
  await expect(page.getByText('Blocked by failure',{exact:true})).toBeVisible();
  await expect(page.locator('p').filter({hasText:'Blocking check:'})).toContainText('LIFE-03 · DEADLINE · Stage: model-stopped');
  await page.getByText('Blocking scenario trace',{exact:true}).click();
  await expect(page.getByText('report-artifacts/reg-11111111-2222-3333-4444-555555555555/traces/'+'a'.repeat(24)+'.json',{exact:true})).toBeVisible();
  await expect(page.locator('p').filter({hasText:'Blocked evidence (case / variant / layer):'})).toContainText('1 by prerequisite · 1 by failure');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath(`regression-blocked-${viewport}.png`),fullPage:true});
});

for(const viewport of ['desktop','mobile'] as const)test(`HAR-10 UX-02 ${viewport} regression refresh stays stable during automatic polling`,async({page},info)=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  let reads=0,writes=0,hold=false,percent=34,release:(()=>void)|undefined;
  const payload=()=>({registered:true,applianceUid:'fixture-appliance',runtimeAvailable:true,sourceRevision:'b'.repeat(40),message:'',
    executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],runs:[{
      id:'regression-'+'a'.repeat(32),uid:'fixture-run-uid',createdAt:'2026-10-13T12:00:00Z',sourceRevision:'b'.repeat(40),
      phase:'Running',phases:[0,1,2,3,4,5,6,7,8],message:'Fixture execution.',credentialsCleaned:false,reportAvailable:false,
      progress:{percent,completedPhases:3,totalPhases:9,currentPhase:3,executionCounts:{Passed:20,Failed:0,Blocked:0}}}]});
  await fixturePage(page,{'/api/regression':async(request:Request)=>{
    if(request.method()!=='GET')writes++;
    reads++;if(hold)await new Promise<void>(resolve=>{release=resolve;});
    return payload();
  }});
  try{
    await page.goto(origin+'/#/system/regression');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow','34');
    const refresh=page.getByRole('button',{name:'Refresh tests',exact:true});
    await expect(refresh).toBeEnabled();hold=true;
    await page.waitForRequest(request=>new URL(request.url()).pathname==='/api/regression'&&request.method()==='GET');
    await expect.poll(()=>Boolean(release)).toBe(true);
    await expect(refresh).toBeEnabled();
    const pendingReads=reads;
    await refresh.click();await expect(refresh).toBeDisabled();expect(reads).toBe(pendingReads);
    hold=false;percent=61;release!();
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow','61');
    await expect(refresh).toBeEnabled();expect(writes).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath(`regression-refresh-${viewport}.png`),fullPage:true});
  }finally{hold=false;release?.();}
});

for(const viewport of ['desktop','mobile'] as const)test(`HAR-10 SEC-01 UX-02 ${viewport} administrators enable, register, start, cancel and download without a license`,async({page})=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  let enabled=false,registered=false,id='',cancelled=false,licenseReads=0;
  const writes:string[]=[];
  const run=()=>({id,uid:'fixture-run-uid',createdAt:'2026-10-13T12:00:00Z',sourceRevision:'b'.repeat(40),
    phases:[0,1,2,3,4,5,6,7,8],phase:cancelled?'Cancelled':'Running',message:'Fixture execution.',
    credentialsCleaned:cancelled,reportAvailable:cancelled,
    progress:{percent:cancelled?34:0,completedPhases:0,totalPhases:9,executionCounts:{Passed:0,Failed:0,Blocked:0}}});
  await fixturePage(page,{
    '/api/license':()=>{licenseReads++;return {state:'missing',valid:false,hasDocument:false,features:[]};},
    '/api/regression':()=>({registered,applianceUid:'fixture-appliance',runtimeAvailable:enabled,sourceRevision:'b'.repeat(40),
      message:enabled?'':'Enable the regression runner.',executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],runs:id?[run()]:[]}),
    '/api/modules/regression/enable':(request:Request)=>{expect(request.method()).toBe('POST');enabled=true;writes.push('enable');return {};},
    '/api/regression/register':(request:Request)=>{
      expect(request.postDataJSON()).toEqual({confirmation:'DISPOSABLE TEST SERVER',acknowledgeDisruption:true});
      registered=true;writes.push('register');return {};
    },
    '/api/regression/runs':(request:Request)=>{
      const body=request.postDataJSON();expect(body).toEqual({requestId:expect.stringMatching(/^[a-f0-9]{32}$/),acknowledgeDisruption:true});
      id='regression-'+body.requestId;writes.push('start');return run();
    },
  });
  await page.route('**/api/regression/runs/*/*',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(path===`/api/regression/runs/${id}/cancel`){
      expect(request.postDataJSON()).toEqual({acknowledgeDisruption:true});cancelled=true;writes.push('cancel');
      await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(run())});
    }else if(path===`/api/regression/runs/${id}/archive`){
      expect(cancelled).toBe(true);expect(request.method()).toBe('GET');
      await route.fulfill({status:200,contentType:'application/gzip',body:'synthetic sanitized report fixture'});
    }else await route.abort();
  });
  await page.goto(origin+'/#/system/regression');
  await expect(page.getByText(/No license is required to run regression tests or download reports/)).toBeVisible();
  await page.getByRole('button',{name:'Enable regression runner'}).click();
  await page.getByRole('button',{name:'Register test Appliance'}).click();
  const registration=page.getByRole('dialog');
  await registration.getByLabel('Type DISPOSABLE TEST SERVER to confirm').fill('DISPOSABLE TEST SERVER');
  await registration.getByRole('button',{name:'Register test Appliance'}).click();
  await page.getByRole('button',{name:'Start regression tests'}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Start tests'}).click();
  await expect(page.getByRole('progressbar')).toBeVisible();
  await page.getByRole('button',{name:'Cancel tests'}).click();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel tests'}).click();
  await expect(page.getByRole('button',{name:'Download report'})).toBeEnabled();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download report'}).click();
  expect((await downloaded).suggestedFilename()).toBe(`magicstick-${id}.tar.gz`);
  expect(writes).toEqual(['enable','register','start','cancel']);expect(licenseReads).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

for(const viewport of ['desktop','mobile'] as const)test(`HAR-10 UX-02 ${viewport} Kubernetes regression dashboard is inert, resumable and explains blocked checks`,async({page},info)=>{
  await page.setViewportSize(viewport==='mobile'?{width:390,height:844}:{width:1440,height:1000});
  let state='Running',writes=0;
  const id='regression-'+'a'.repeat(32);
  const payload=()=>({registered:true,applianceUid:'fixture-appliance',runtimeAvailable:true,sourceRevision:'b'.repeat(40),message:'',executionLocation:'appliance-kubernetes',externalRunnerRequired:['reboot'],runs:[{
    id,uid:'fixture-run-uid',createdAt:'2026-10-13T12:00:00Z',sourceRevision:'b'.repeat(40),phase:state,phases:[0,1,2,3,4,5,6,7,8],message:'Fixture execution.',credentialsCleaned:state==='Blocked',
    reportAvailable:state==='Blocked',progress:{percent:state==='Blocked'?100:34,completedPhases:state==='Blocked'?9:3,totalPhases:9,currentPhase:3,currentTest:'MGPU-01: exact physical card use',executionCounts:{Passed:20,Failed:0,Blocked:1}},
    ...(state==='Blocked'?{result:{counts:{Passed:100,Failed:0,Blocked:1},executionCounts:{Passed:20,Failed:0,Blocked:1},omittedCases:0,recoveryRequired:false,
      phases:[{phase:6,outcome:'Blocked',counts:{Passed:10,Failed:0,Blocked:1},executionCounts:{Passed:5,Failed:0,Blocked:1}}],
      cases:[{id:'BOOT-02',outcome:'Blocked',layer:'O',variant:'p6-reboot',phase:6,stage:'host-boot',reason:'EXTERNAL_RUNNER',message:'An external runner must observe host recovery.',action:'Use the external Docker runner.',durationMs:0,
        tracePath:'report-artifacts/reg-11111111-2222-3333-4444-555555555555/traces/'+'a'.repeat(24)+'.json'}]}}:{})}]});
  await fixturePage(page,{'/api/regression':payload,[`/api/regression/runs/${id}/cancel`]:(request:Request)=>{writes++;expect(request.postDataJSON()).toEqual({acknowledgeDisruption:true});state='Blocked';return {};}});
  await page.goto(origin+'/#/system/regression');
  await expect(page.getByRole('heading',{name:'Regression tests',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start regression tests'})).toBeDisabled();
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow','34');expect(writes).toBe(0);
  await page.reload();await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow','34');expect(writes).toBe(0);
  await page.getByRole('button',{name:'Cancel tests'}).click();expect(writes).toBe(0);
  await page.getByRole('dialog').getByRole('button',{name:'Cancel tests'}).click();
  await expect.poll(()=>writes).toBe(1);await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow','100');
  await page.getByText('Failures and blocked checks (1)',{exact:true}).click();
  await expect(page.getByText('EXTERNAL_RUNNER',{exact:true})).toBeVisible();
  await expect(page.getByText('Phase 6 · Check layer O · Stage: host-boot',{exact:true})).toBeVisible();
  await page.getByText('Trace in report archive',{exact:true}).click();
  await expect(page.getByRole('button',{name:'Download report'})).toBeEnabled();
  await page.screenshot({path:info.outputPath(`regression-dashboard-${viewport}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
