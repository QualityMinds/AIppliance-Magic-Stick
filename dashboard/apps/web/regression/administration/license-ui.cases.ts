import {test,type BrowserContext} from '@playwright/test';
import type {LicensePreview,LicenseStatus} from '@magicstick/dashboard-contracts';
import {atStage,requireProof as requireSafe} from '../core/errors.ts';
import {bounded} from '../core/run-lifecycle.ts';

/** The context's normal exact-request guard is the only route handler. Never
 * stack/unroute a page handler while Dashboard polling is still in flight. */
export async function reviewLicenseUi(context:BrowserContext,input:{origin:string;document:string;timeoutMs:number;
  beforeRevision:string;activate?:{before:()=>Promise<void>;acknowledge:(status:LicenseStatus)=>Promise<void>}}) {
  const {origin,document,timeoutMs}=input,page=await context.newPage();
  try {return await atStage('license-review',()=>bounded(async()=>{
    await page.goto(origin+'/#/system/license',{timeout:timeoutMs});
    await page.getByLabel('License file',{exact:true}).setInputFiles({name:'regression.license',mimeType:'application/json',buffer:Buffer.from(document)});
    const response=page.waitForResponse(value=>value.url()===origin+'/api/license/validate'&&value.request().method()==='POST',{timeout:timeoutMs});
    const [result]=await Promise.all([response,page.getByRole('button',{name:'Validate license',exact:true}).click({timeout:timeoutMs})]);
    requireSafe(result.status()===200,'API');const preview=await result.json() as LicensePreview;
    requireSafe(preview.current.revision===input.beforeRevision&&preview.candidate.valid&&preview.candidate.claims,'API');
    const panel=page.locator('[aria-label="License preview"]');
    await panel.getByRole('button',{name:'Activate license',exact:true}).waitFor({state:'visible',timeout:timeoutMs});
    requireSafe(await panel.getByRole('button',{name:'Activate license',exact:true}).isEnabled(),'API');
    for(const text of [preview.candidate.claims.edition==='commercial'?'Commercial':'Free Registered',preview.candidate.claims.licenseId])
      requireSafe(await panel.getByText(text,{exact:true}).isVisible(),'API');
    requireSafe((await panel.textContent())?.includes(preview.candidate.claims.features.join(', ')),'API');
    if(input.activate)await test.step('Explicitly activate the reviewed license and retain its acknowledgement',()=>atStage('license-activate',async()=>{
      await input.activate!.before();
      const response=page.waitForResponse(value=>value.url()===origin+'/api/license'&&value.request().method()==='PUT',{timeout:timeoutMs});
      const [result]=await Promise.all([response,panel.getByRole('button',{name:'Activate license',exact:true}).click({timeout:timeoutMs})]);
      requireSafe(result.status()===200,'API');
      // Persist the confirmed revision before any toast/reload assertion can
      // fail or a worker is terminated. Equal-document PUTs may be no-ops.
      const status=await result.json() as LicenseStatus;await input.activate!.acknowledge(status);
      requireSafe(status.valid&&status.claims?.licenseId===preview.candidate.claims!.licenseId,'API');
      await page.getByText('License saved. Installed capabilities with a valid entitlement are now available.',{exact:true}).waitFor({state:'visible',timeout:timeoutMs});
      await page.reload({timeout:timeoutMs});
      await page.getByText('Valid license',{exact:true}).waitFor({state:'visible',timeout:timeoutMs});
    }));
    return preview;
  },Math.max(timeoutMs*3,30_000),'license-review',()=>page.close()));}
  finally{await page.close();}
}
