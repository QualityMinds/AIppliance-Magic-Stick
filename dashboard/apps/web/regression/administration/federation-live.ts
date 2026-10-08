import {expect,type Browser} from '@playwright/test';
import {join} from 'node:path';
import type {FederationInput,FederationProvider} from '@magicstick/dashboard-contracts';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {IdentityFixtureClient} from '../core/identity-fixture.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {realLogin} from '../core/auth.ts';
import {validateTestLicenseSigner,testLicenseDocument} from '../core/test-license-fixtures.ts';

const stableProvider=({revision:_,enabled:__,...provider}:FederationProvider)=>canonical(provider);

/** Real controlled OIDC and SAML providers, actual browser broker login and
 * fixed claim/role mapping. Fixture administration never changes production
 * clients/realm roles and deletes only link-bound disposable identities. */
export async function federationWorkflow(live:LiveFoundation,browser:Browser) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),plan=profile.federation;
  requireSafe(plan?.approveDisposableProviders === true && plan.upstream && plan.brokerCleaner && plan.expiringLicenseFile && plan.restoreLicenseFile &&
    Array.isArray(plan.fixtures) && plan.fixtures.length === 2 && new Set(plan.fixtures.map((item:{protocol:string})=>item.protocol)).size === 2,'PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  requireSafe((await api.api.federatedSso()).feature.available === true,'PREREQUISITE');
  requireSafe(plan.upstream.origin !== live.config.identityUrl && plan.brokerCleaner.origin === live.config.identityUrl,'CONFIG');
  const upstream=new IdentityFixtureClient(live.context.request,plan.upstream,live.guard,live.config.requestTimeoutMs),cleaner=new IdentityFixtureClient(live.context.request,plan.brokerCleaner,live.guard,live.config.requestTimeoutMs);
  await upstream.authenticate();await cleaner.authenticate();
  const baseline=(await api.api.federatedSso()).providers.map(item=>`${item.alias}:${item.revision}`).sort().join(',');
  requireSafe(baseline === '', 'PREREQUISITE');
  const owned:Array<{alias:string;username:string;id?:string;revision?:string;provider?:string}>=[],
    unknownActors:Array<{alias:string;username:string;id?:string}>=[],filename=join(process.env.REGRESSION_RUN_DIR!,'federation.json');
  await writePrivate(filename,{version:1,runId:live.journal.runId,state:'requested',aliases:[]},true);
  try {
    for(const fixture of plan.fixtures) {
      requireSafe(['oidc','saml'].includes(fixture.protocol) && fixture.metadataUrl && new URL(fixture.metadataUrl).origin === plan.upstream.origin &&
        /^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(fixture.claim),'CONFIG');
      const alias=live.journal.prefix+fixture.protocol;
      requireSafe(!(await api.api.federatedSso()).providers.some(item=>item.alias === alias),'OWNERSHIP');
      const secret=fixture.protocol === 'oidc' ? (await readPrivate(fixture.clientSecretFile)).trim() : undefined;
      const input:FederationInput={alias,displayName:alias,protocol:fixture.protocol,metadataUrl:fixture.metadataUrl,enabled:true,trustEmail:false,
        mappings:[{source:fixture.claim,value:'regression-user',accessLevel:'user'}],expectedRevision:'new',
        ...(fixture.protocol === 'oidc' ? {clientId:fixture.clientId,clientSecret:secret,scopes:'openid profile email'} : {})};
      await api.write({method:'POST',path:'/api/federated-sso/validate',body:{protocol:input.protocol,metadataUrl:input.metadataUrl}},()=>api.api.validateFederation(input));
      const entry={alias,username:live.journal.prefix+fixture.protocol+'-login',id:undefined as string|undefined,revision:undefined as string|undefined,provider:undefined as string|undefined};owned.push(entry);
      await writePrivate(filename,{version:1,runId:live.journal.runId,state:'requested',actors:owned});
      const result=await api.write({method:'POST',path:'/api/federated-sso/providers',body:input},()=>api.api.createFederation(input));
      requireSafe(result.providers.some(item=>item.alias === alias && item.enabled && item.protocol === input.protocol && item.mappings[0]?.accessLevel === 'user') &&
        (!secret || !JSON.stringify(result).includes(secret)),'API');
      entry.revision=result.providers.find(item=>item.alias === alias)!.revision;
      entry.provider=stableProvider(result.providers.find(item=>item.alias === alias)!);
      await writePrivate(filename,{version:1,runId:live.journal.runId,state:'provider-owned',actors:owned});
      const actor=await upstream.create(entry.username,live.journal.runId,fixture.claim,'regression-user');entry.id=actor.id;
      await writePrivate(filename,{version:1,runId:live.journal.runId,state:'owned',actors:owned});
      const brokerLogin=async(actor:{username:string;password:string},mapped:boolean)=>{
      const context=await browser.newContext({serviceWorkers:'block',acceptDownloads:false}),page=await context.newPage();
      try {
        await context.route('**/*',async route=>{
          const url=new URL(route.request().url()),method=route.request().method();
          requireSafe([live.config.dashboardUrl,live.config.identityUrl,plan.upstream.origin].includes(url.origin) &&
            (url.origin !== live.config.dashboardUrl || ['GET','HEAD','OPTIONS'].includes(method)),'MUTATION');await route.continue();});
        await page.goto(live.config.dashboardUrl,{waitUntil:'domcontentloaded'});requireSafe(new URL(page.url()).origin === live.config.identityUrl,'AUTH');
        await page.getByRole('link',{name:alias,exact:true}).click();await page.locator('#username').fill(actor.username);await page.locator('#password').fill(actor.password);
        await page.locator('#kc-login').click();await page.waitForURL(url=>url.origin === live.config.dashboardUrl,{timeout:live.config.loginTimeoutMs});
        const session=await new AdministrationApi(context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard).api.session();
        requireSafe(session.username === actor.username && (!mapped || session.roles.includes('magicstick-user')) && !session.roles.some(role=>['magicstick-admin','magicstick-operator','magicstick-viewer'].includes(role)),'AUTH');
        for(const path of ['/api/users','/api/federated-sso'])requireSafe((await context.request.get(live.config.dashboardUrl+path,{timeout:live.config.requestTimeoutMs,maxRedirects:0})).status() === 403,'AUTH');
        const forbidden=await context.request.post(live.config.dashboardUrl+'/api/federated-sso/providers',{data:{alias:'invalid'},
          headers:{Origin:live.config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'},timeout:live.config.requestTimeoutMs,maxRedirects:0});requireSafe(forbidden.status() === 403,'AUTH');
      }finally{await page.close();await context.close();}
      };
      await brokerLogin(actor,true);
      const unknown={alias,username:live.journal.prefix+fixture.protocol+'-unknown',id:undefined as string|undefined};unknownActors.push(unknown);
      const unmapped=await upstream.create(unknown.username,live.journal.runId,fixture.claim,'unmapped-regression-claim');unknown.id=unmapped.id;
      await writePrivate(filename,{version:1,runId:live.journal.runId,state:'owned',actors:owned,unknownActors});
      await brokerLogin(unmapped,false);
      const adminPage=await live.context.newPage();try{await adminPage.goto(live.config.dashboardUrl+'/#/system/federated-sso');await expect(adminPage.getByText(alias,{exact:true}).first()).toBeVisible();}
      finally{await adminPage.close();}
    }
    // Entitlement expiry uses a signed, installation-bound short-lived file.
    // Never delete a trust Secret or adjust the host clock to manufacture it.
    let expiring:string;
    const restore=await readPrivate(plan.restoreLicenseFile);
    if(plan.testSignerFile) {
      // Setup's disposable signer is installation-bound and already locally
      // trusted. Mint immediately before expiry testing, not hours before it.
      const status=await api.api.licenseStatus();
      const signer=validateTestLicenseSigner(JSON.parse(await readPrivate(plan.testSignerFile)),live.config.expected.applianceUid,status.installationId);
      requireSafe(status.trustedKeyIds.includes(signer.kid),'PREREQUISITE');
      expiring=testLicenseDocument(signer,'short-lived');
      await writePrivate(join(process.env.REGRESSION_RUN_DIR!,'federation-expiring.license'),expiring,true);
    } else expiring=await readPrivate(plan.expiringLicenseFile);
    requireSafe((await api.api.exportLicense()).content === restore,'PREREQUISITE');
    const preview=await api.write({method:'POST',path:'/api/license/validate',body:{document:expiring}},()=>api.api.inspectLicense(expiring));
    requireSafe(preview.candidate.valid && Number(preview.candidate.claims?.expiresAt)*1000 > Date.now()+10_000 && Number(preview.candidate.claims?.expiresAt)*1000 <= Date.now()+300_000,'PREREQUISITE');
    const backup=await api.write({method:'POST',path:'/api/license/validate',body:{document:restore}},()=>api.api.inspectLicense(restore));requireSafe(backup.candidate.valid,'PREREQUISITE');
    const revision=(await api.api.licenseStatus()).revision;
    await api.write({method:'PUT',path:'/api/license',body:{document:expiring,expectedRevision:revision}},()=>api.api.importLicense(expiring,revision));
    try {
      await poll(()=>api.api.federatedSso(),value=>!value.feature.available && value.providers.filter(item=>owned.some(actor=>actor.alias === item.alias)).every(item=>!item.enabled),
        {timeoutMs:360_000,intervalMs:2000,stage:'host-readiness'});
      requireSafe((await api.api.session()).roles.includes('magicstick-admin'),'AUTH');
      const local=await realLogin(browser,live.config);
      try{requireSafe((await new AdministrationApi(local.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard).api.session()).roles.includes('magicstick-admin'),'AUTH');}
      finally{await local.close();}
      const fresh=await browser.newContext({serviceWorkers:'block',acceptDownloads:false}),login=await fresh.newPage();
      try{await login.goto(live.config.dashboardUrl,{waitUntil:'domcontentloaded'});
        requireSafe(new URL(login.url()).origin === live.config.identityUrl,'AUTH');
        for(const actor of owned)await expect(login.getByRole('link',{name:actor.alias,exact:true})).toHaveCount(0);
      }finally{await login.close();await fresh.close();}
      let denied=false;try{await api.write({method:'POST',path:'/api/federated-sso/validate',body:{protocol:'oidc',metadataUrl:plan.fixtures[0].metadataUrl}},()=>api.api.validateFederation({protocol:'oidc',metadataUrl:plan.fixtures[0].metadataUrl}));}
      catch(error){denied=error instanceof AdministrationRejected && error.status === 403;}requireSafe(denied,'AUTH');
    }finally {
      const current=(await api.api.licenseStatus()).revision;
      requireSafe((await api.api.exportLicense()).content === expiring,'CONFLICT');
      await api.write({method:'PUT',path:'/api/license',body:{document:restore,expectedRevision:current}},()=>api.api.importLicense(restore,current));
    }
    return new Set(['SSO-02','SSO-04','SSO-05']);
  }finally {
    for(const actor of unknownActors.reverse()) {
      if(actor.id)await cleaner.removeBrokered(actor.username,actor.alias,actor.id);
      await upstream.removePending(actor.username,live.journal.runId,actor.id);
    }
    for(const actor of owned.reverse()) {
      if(actor.id)await cleaner.removeBrokered(actor.username,actor.alias,actor.id);
      await upstream.removePending(actor.username,live.journal.runId,actor.id);
      const current=(await api.api.federatedSso()).providers.find(item=>item.alias === actor.alias);
      if(current){requireSafe(actor.revision,'OWNERSHIP');
        requireSafe(actor.provider && stableProvider(current) === actor.provider,'CONFLICT');
        await api.write({method:'DELETE',path:'/api/federated-sso/providers/'+actor.alias,body:{expectedRevision:current.revision}},()=>api.api.deleteFederation(actor.alias,current.revision));}
    }
    requireSafe((await api.api.federatedSso()).providers.map(item=>`${item.alias}:${item.revision}`).sort().join(',') === baseline,'CLEANUP');
    await writePrivate(filename,{version:1,runId:live.journal.runId,state:'removed'});
  }
}
