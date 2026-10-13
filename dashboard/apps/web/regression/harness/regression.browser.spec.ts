import {test,expect,type Request} from '@playwright/test';
import {fixturePage,origin} from '../fixtures/dashboard.ts';

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
