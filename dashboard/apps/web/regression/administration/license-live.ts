import {expect} from '@playwright/test';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {restartDashboardApi} from '../core/service-restart.ts';

const fingerprint=(document:string)=>createHash('sha256').update(document).digest('hex');
export async function licensingWorkflow(live:LiveFoundation) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),fixture=profile.license;
  requireSafe(fixture?.approveLicenseReplacement === true && typeof fixture.validFile === 'string' && Array.isArray(fixture.invalidFiles) && fixture.invalidFiles.length >= 3,'PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard),before=await api.api.licenseStatus();
  const original=before.hasDocument ? await api.api.exportLicense() : undefined;
  requireSafe(original || fixture.allowFirstActivation === true,'PREREQUISITE');
  const document=await readPrivate(fixture.validFile);requireSafe(document.length < 64*1024 && !document.includes('PRIVATE KEY'),'CONFIG');
  const inspected=await api.write({method:'POST',path:'/api/license/validate',body:{document}},()=>api.api.inspectLicense(document));
  requireSafe(inspected.candidate.valid && inspected.candidate.claims?.installationId === before.installationId && inspected.candidate.claims.features.includes('federated-sso'),'PREREQUISITE');
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'license-transaction.json');
  await writePrivate(receipt,{version:1,installationId:before.installationId,beforeRevision:before.revision,originalHash:original ? fingerprint(original.content) : null,
    selectedHash:fingerprint(document),restoreAvailable:Boolean(original),state:'reviewed'},true);
  if(original)await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'original-license.license'),original.content,true);
  let changed=false,activationAttempted=false,revision=before.revision;
  try {
    const page=await live.context.newPage();
    try {
      await page.goto(live.config.dashboardUrl+'/#/system/license');await page.getByLabel('License file',{exact:true}).setInputFiles({name:'registered.license',mimeType:'application/json',buffer:Buffer.from(document)});
      const permit=async(route:import('@playwright/test').Route)=>{
        const body=route.request().postDataJSON();requireSafe(body.document === document &&
          (route.request().method() === 'POST' || route.request().method() === 'PUT' && body.expectedRevision === before.revision),'MUTATION');await live.guard();await route.continue();};
      await page.route(live.config.dashboardUrl+'/api/license{,/validate}',permit);
      try {
        await page.getByRole('button',{name:'Validate license',exact:true}).click();await expect(page.getByRole('button',{name:'Activate license',exact:true})).toBeEnabled();
        activationAttempted=true;await page.getByRole('button',{name:'Activate license',exact:true}).click();await expect(page.getByText('License saved. Installed capabilities with a valid entitlement are now available.',{exact:true})).toBeVisible();
      }finally{await page.unroute(live.config.dashboardUrl+'/api/license{,/validate}',permit);}
      const current=await api.api.licenseStatus();requireSafe(current.valid && current.revision !== before.revision && current.claims?.licenseId === inspected.candidate.claims.licenseId,'API');
      revision=current.revision;changed=true;await page.reload();await expect(page.getByText('Valid license',{exact:true})).toBeVisible();
      requireSafe(fingerprint((await api.api.exportLicense()).content) === fingerprint(document),'API');
    }finally{await page.close();}
    const invalidStates=new Set<string>();
    for(const filename of fixture.invalidFiles) {
      const invalid=await readPrivate(filename);requireSafe(invalid.length <= 64*1024,'CONFIG');
      const preview=await api.write({method:'POST',path:'/api/license/validate',body:{document:invalid}},()=>api.api.inspectLicense(invalid));
      requireSafe(!preview.candidate.valid,'API');invalidStates.add(preview.candidate.state);
      let refused=false;
      try{await api.write({method:'PUT',path:'/api/license',body:{document:invalid,expectedRevision:revision}},()=>api.api.importLicense(invalid,revision));}
      catch(error){refused=error instanceof AdministrationRejected && [400,409,422].includes(error.status);}
      requireSafe(refused && (await api.api.licenseStatus()).revision === revision && fingerprint((await api.api.exportLicense()).content) === fingerprint(document),'API');
    }
    requireSafe(invalidStates.has('expired') && invalidStates.has('wrong_installation') && invalidStates.has('invalid_signature'),'PREREQUISITE');
    let stale=false;try{await api.write({method:'PUT',path:'/api/license',body:{document,expectedRevision:before.revision}},()=>api.api.importLicense(document,before.revision));}
    catch(error){stale=error instanceof AdministrationRejected && error.status === 409;}requireSafe(stale,'API');
    await restartDashboardApi(live,fixture.restart);
    requireSafe((await api.api.licenseStatus()).revision === revision && fingerprint((await api.api.exportLicense()).content) === fingerprint(document),'API');
    return new Set(['LIC-02','LIC-03','LIC-04']);
  }finally{
    // Reconcile ambiguous UI acceptance before deciding whether restoration is
    // needed. A timeout after PUT must not leave an unrecorded replacement.
    const observed=await api.api.licenseStatus();
    if(activationAttempted && observed.hasDocument && observed.revision !== before.revision &&
      fingerprint((await api.api.exportLicense()).content) === fingerprint(document)){changed=true;revision=observed.revision;}
    if(changed && original) {
      const current=await api.api.licenseStatus();requireSafe(current.revision === revision,'CONFLICT');
      await api.write({method:'PUT',path:'/api/license',body:{document:original.content,expectedRevision:revision}},()=>api.api.importLicense(original.content,revision));
      requireSafe(fingerprint((await api.api.exportLicense()).content) === fingerprint(original.content),'CLEANUP');
    }
    await writePrivate(receipt,{version:1,installationId:before.installationId,originalHash:original ? fingerprint(original.content) : null,
      state:changed && !original ? 'first-activation-retained-by-approval' : 'restored'});
  }
}
