import {test,expect,type Page} from '@playwright/test';
import {fixturePage,origin} from '../fixtures/dashboard.ts';
import {evidenceAnnotations} from '../core/evidence.ts';

const variants=[
  {viewport:'desktop',rate:1,variant:'status-history-desktop'},
  {viewport:'mobile',rate:1,variant:'status-history-mobile'},
  {viewport:'desktop',rate:12,variant:'status-history-desktop-slow'},
  {viewport:'mobile',rate:12,variant:'status-history-mobile-slow'},
] as const;

async function selectedStatus(page:Page,section:'overview'|'flux'|'network') {
  const label={overview:'Overview',flux:'Flux',network:'Network & routes'}[section];
  await expect(page).toHaveURL(origin+'/#/system/status'+(section==='overview'?'':'/'+section));
  await expect(page.getByRole('tablist',{name:'System Status sections',exact:true})
    .getByRole('tab',{name:label,exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tabpanel',{name:label,exact:true})).toBeVisible();
}

for(const {viewport,rate,variant} of variants)
test(`NAV-02 ${viewport} CPU ${rate} System Status Back and Forward preserve the selected tab`,
  evidenceAnnotations({id:'NAV-02',variant,layer:'B'}),async({page,context})=>{
    await page.setViewportSize(viewport==='desktop'?{width:1440,height:1000}:{width:390,height:844});
    // Chromium is the runner's selected engine. Each test context owns and
    // closes this session; throttling never reaches an appliance browser.
    const cdp=await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate',{rate});
    let writes=0;
    page.on('request',request=>{
      if(new URL(request.url()).pathname.startsWith('/api/')&&!['GET','HEAD'].includes(request.method()))writes++;
    });
    await fixturePage(page);await page.goto(origin+'/#/system/status');await selectedStatus(page,'overview');
    for(let cycle=0;cycle<3;cycle++) {
      // A same-document goto resolves before React has necessarily followed
      // the hash and normalized history. Confirm the UI before the next action.
      await test.step('Open Flux and confirm URL, selected tab and panel',async()=>{
        await page.goto(origin+'/#/system/status/flux');await selectedStatus(page,'flux');
      });
      await test.step('Open Network routes and confirm URL, selected tab and panel',async()=>{
        await page.goto(origin+'/#/system/status/network');await selectedStatus(page,'network');
      });
      await test.step('Browser Back restores Flux URL, selected tab and panel',async()=>{
        await page.goBack();await selectedStatus(page,'flux');
      });
      await test.step('Browser Forward restores Network URL, selected tab and panel',async()=>{
        await page.goForward();await selectedStatus(page,'network');
      });
    }
    expect(writes).toBe(0);
  });
