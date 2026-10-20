import {test,type BrowserContext} from '@playwright/test';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {readPrivate,writePrivate,journalFile} from '../core/private-files.ts';
import {atStage,requireProof as requireSafe} from '../core/errors.ts';
import {restartDashboardApi} from '../core/service-restart.ts';
import {LicenseResetter,type LicenseSecret} from '../core/license-baseline.ts';
import {LicenseTransaction,type LicenseSnapshot,licenseHash} from '../core/license-transaction.ts';
import {realLogin,type ExactDashboardRequest} from '../core/auth.ts';
import {withCleanup,bounded} from '../core/run-lifecycle.ts';
import {reviewLicenseUi} from './license-ui.cases.ts';

export type LicenseCase='LIC-02'|'LIC-03'|'LIC-04';
/** Exact permits for the existing context guard. Validation-only cannot arm
 * activation, while ordinary GET polling needs no write permit or JSON body. */
export function licenseUiPermits(document:string,revision:string,activate=false):ExactDashboardRequest[] {
  return [{method:'POST',path:'/api/license/validate',body:{document},mutating:false},
    ...(activate?[{method:'PUT' as const,path:'/api/license',body:{document,expectedRevision:revision}}]:[])];
}
export function licenseSnapshot(secret:LicenseSecret):LicenseSnapshot {
  requireSafe(secret.metadata.name==='magicstick-license'&&secret.metadata.namespace==='identity-system'&&secret.metadata.uid&&secret.metadata.resourceVersion,'IDENTITY');
  return {uid:secret.metadata.uid,revision:secret.metadata.resourceVersion,installationId:Buffer.from(secret.data.installationId??'','base64').toString(),
    document:Object.hasOwn(secret.data,'license.json')?Buffer.from(secret.data['license.json']!,'base64').toString():null,
    otherData:Object.fromEntries(Object.entries(secret.data).filter(([key])=>key!=='license.json'))};
}

/** A revision conflict or an authorization/outage error is not proof that an
 * invalid license was rejected by verification. Always compare the baseline. */
export async function rejectLicenseDocument(api:AdministrationApi,transaction:Pick<LicenseTransaction,'request'|'forwarded'|'unchanged'>,document:string,revision:string) {
  const preview=await api.write({method:'POST',path:'/api/license/validate',body:{document}},()=>api.api.inspectLicense(document));
  requireSafe(!preview.candidate.valid,'API');await transaction.unchanged();await transaction.request(document);
  let rejected=false;
  try{await api.write({method:'PUT',path:'/api/license',body:{document,expectedRevision:revision}},()=>api.api.importLicense(document,revision),()=>transaction.forwarded());}
  catch(error){if(!(error instanceof AdministrationRejected))throw error;rejected=[400,422].includes(error.status);}
  requireSafe(rejected,'API');await transaction.unchanged();return preview.candidate.state;
}

/** Independent cases: validation never activates, rejection never needs a
 * previous valid activation, and only persistence restarts the API Pod. */
export async function licensingWorkflow(live:LiveFoundation,selected:LicenseCase) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),fixture=profile.license;
  requireSafe(fixture?.approveLicenseReplacement===true&&typeof fixture.validFile==='string'&&Array.isArray(fixture.invalidFiles)&&fixture.invalidFiles.length>=3,'PREREQUISITE');
  if(selected==='LIC-02')requireSafe(typeof fixture.commercialFile==='string','PREREQUISITE');
  const baseline=fixture.baseline;
  requireSafe(baseline?.approveNoFileBaseline===true&&baseline.kubeconfig&&baseline.kubeconfig!==live.config.observerKubeconfig&&baseline.kubeconfig!==live.config.lock?.kubeconfig,'PREREQUISITE');
  if(selected==='LIC-04')requireSafe(fixture.restart?.approveApiRestart===true&&fixture.restart.kubeconfig,'PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const resetter=new LicenseResetter(baseline.kubeconfig,live.config.requestTimeoutMs);
  await resetter.verifyScope((await live.observer.list('namespaces')).map(item=>String(item.metadata.name)));
  const original=licenseSnapshot(await resetter.state()),before=await api.api.licenseStatus();
  requireSafe(before.installationId===original.installationId&&before.revision===original.revision&&before.hasDocument===(original.document!==null),'CONFLICT');
  requireSafe(original.document!==null||fixture.allowFirstActivation===true,'PREREQUISITE');
  const suffix=selected.toLowerCase(),receipt=journalFile(live.journal,`license-transaction-${suffix}.json`);
  if(original.document!==null)await writePrivate(journalFile(live.journal,`original-license-${suffix}.license`),original.document,true);
  let firstReceipt=true;
  const transaction=await new LicenseTransaction(original,{
    state:async()=>licenseSnapshot(await resetter.state()),guard:live.guard,
    restore:async(expected,document)=>{const current=await resetter.state();
      requireSafe(current.metadata.uid===expected.uid&&current.metadata.resourceVersion===expected.revision,'CONFLICT');
      await resetter.document(current,original.installationId,document);},
    record:async value=>{await writePrivate(receipt,value,firstReceipt);firstReceipt=false;},
  }).begin();
  const restore=()=>atStage('license-restore',async()=>{
    await transaction.restore();const restored=await api.api.licenseStatus();
    requireSafe(restored.installationId===original.installationId&&restored.hasDocument===(original.document!==null),'CLEANUP');
    if(original.document!==null)requireSafe(licenseHash((await api.api.exportLicense()).content)===licenseHash(original.document),'CLEANUP');
  });
  const unregister=live.registerRestoration(restore);
  let context:BrowserContext|undefined,permits:ExactDashboardRequest[]=[],blockedWrites=0;
  const ui=async(document:string,activate=false)=>{
    const browser=live.context.browser();requireSafe(browser,'CONFIG');
    permits=licenseUiPermits(document,original.revision,activate);
    context??=await realLogin(browser,live.config,{allowedDashboardRequests:()=>permits,
      assertMutationAllowed:async()=>{await live.guard();await transaction.forwarded();},onBlockedMutation:()=>{blockedWrites++;}});
    const preview=await reviewLicenseUi(context,{origin:live.config.dashboardUrl,document,timeoutMs:live.config.requestTimeoutMs,beforeRevision:original.revision,
      ...(activate?{activate:{before:()=>transaction.request(document),acknowledge:async(status)=>{await transaction.acknowledge(status.revision);}}}:{})});
    requireSafe(blockedWrites===0,'MUTATION');return preview;
  };
  await withCleanup(async()=>{
    if(selected==='LIC-03')await test.step('Reject invalid signed documents without altering the current license',()=>atStage('license-reject',async()=>{
      const states=new Set<string>();
      for(const filename of fixture.invalidFiles) {
        const document=await readPrivate(filename);requireSafe(document.length<=64*1024&&!document.includes('PRIVATE KEY'),'CONFIG');
        states.add(await rejectLicenseDocument(api,transaction,document,original.revision));
      }
      requireSafe(['expired','wrong_installation','invalid_signature'].every(state=>states.has(state)),'PREREQUISITE');
    }));
    else {
      const document=await readPrivate(fixture.validFile);requireSafe(document.length<64*1024&&!document.includes('PRIVATE KEY'),'CONFIG');
      await test.step(selected==='LIC-02'?'Review a valid license without activating it':'Review and activate with the current revision',async()=>{
        const preview=await ui(document,selected==='LIC-04');
        requireSafe(preview.candidate.claims?.installationId===original.installationId&&preview.candidate.claims.features.includes('federated-sso'),'API');
      });
      if(selected==='LIC-02') {
        await transaction.unchanged();
        if(fixture.commercialFile)await test.step('Review the separate commercial fixture without activation',async()=>{
          const commercial=await readPrivate(fixture.commercialFile);requireSafe(commercial.length<64*1024&&!commercial.includes('PRIVATE KEY'),'CONFIG');
          const preview=await ui(commercial);requireSafe(preview.candidate.claims?.edition==='commercial'&&preview.candidate.claims.installationId===original.installationId,'API');
          await transaction.unchanged();
        });
      }
      else {
        const current=await api.api.licenseStatus();
        requireSafe(current.valid&&licenseHash((await api.api.exportLicense()).content)===licenseHash(document),'API');
        await test.step('Reject stale revision without replacing the acknowledged document',()=>atStage('license-activate',async()=>{
          // An idempotent equal-document PUT is allowed not to advance the
          // Secret revision. Still exercise an actually non-current CAS token.
          const staleRevision=current.revision===original.revision?'stale-'+original.revision:original.revision;
          let stale=false;try{await api.write({method:'PUT',path:'/api/license',body:{document,expectedRevision:staleRevision}},()=>api.api.importLicense(document,staleRevision));}
          catch(error){if(!(error instanceof AdministrationRejected))throw error;stale=error.status===409;}
          requireSafe(stale&&(await api.api.licenseStatus()).revision===current.revision,'API');
        }));
        permits=[];await context!.unrouteAll({behavior:'wait'});await context!.close();context=undefined;
        await test.step('Verify the same document persists across the scoped API Pod restart',()=>atStage('license-restart',async()=>{
          await restartDashboardApi(live,fixture.restart);
          requireSafe((await api.api.licenseStatus()).revision===current.revision&&licenseHash((await api.api.exportLicense()).content)===licenseHash(document),'API');
        }));
      }
    }
  },async()=>{
    permits=[];
    try{if(context)await bounded(async()=>{await context!.unrouteAll({behavior:'wait'});await context!.close();},10_000,'license-restore',()=>context!.close());}
    finally{await test.step('Restore the exact pre-test license document and verify its receipt',async()=>{await restore();unregister();});}
  });
}
