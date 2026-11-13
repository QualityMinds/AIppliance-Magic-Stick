import {expect,test,type Browser,type BrowserContext,type Page} from '@playwright/test';
import {instanceResourceLinks} from '@magicstick/dashboard-core';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AppCleaner,OwnedAppClient,appTypes,type AppFixture,ownedChild} from '../core/owned-app.ts';
import {AdministrationApi} from '../core/administration-api.ts';
import {OwnedIdentityClient} from '../core/owned-identity.ts';
import {realLogin} from '../core/auth.ts';
import {readPrivate,writePrivate,journalFile} from '../core/private-files.ts';
import {join,dirname} from 'node:path';
import {BorrowedModule} from '../core/borrowed-module.ts';
import {applicationModuleIds,protectedModule} from '../core/application-modules.ts';
import {poll} from '../core/poll.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {gatewaySnapshot,assertGatewayStable} from '../core/gateway-stability.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {registerRuntimeDnsOrigins} from '../core/browser-dns.ts';
import {applicationModel,applicationEditContext} from '../core/application-model.ts';
import {preparationApi,estimateInput} from '../core/preparation-api.ts';
import {regressionContextOptions} from '../core/https-policy.ts';
import {repositoryAppAdapter} from '../core/application-adapters.ts';
import {HermesTerminalEvidence,observeHermesTerminal,verifyHermesTerminalChat} from '../core/hermes-terminal.ts';
import {OpenCodeChatEvidence,observeOpenCodeChat,verifyOpenCodeChat,openCodeChatPath} from '../core/opencode-chat.ts';
import {applicationFixtureEnabled,liveWorkflowEnabled} from '../core/engine-policy.ts';
import {serviceRegressionEnabled} from '../core/service-selection.ts';
import type {LocalModelFixture} from '../core/config.ts';
import {ModuleRuntimeProof} from '../core/module-runtime-proof.ts';

/** Dependencies are prepared before opening Create. Borrow only a disabled
 * baseline seeded by setup; never adopt an enable that lost its acknowledgement. */
async function prepareApplications(live:LiveFoundation,api:AdministrationApi,fixtures:AppFixture[]) {
  const modules=await api.api.modules();
  for(const id of applicationModuleIds(modules,fixtures.map(f=>f.type))) {
    if(!modules.modules[id]?.enabled) {
      requireSafe(!protectedModule(id)&&modules.catalogJson?.modules?.[id]?.activationMode==='moduleactivation','PREREQUISITE');
      const original=(await live.observer.list('moduleactivations.appliance.magicstick.dev','ai-system')).find(item=>item.spec?.module===id);
      requireSafe(original?.spec?.enabled===false,'PREREQUISITE');
      const parameters=(original.spec.parameters??{}) as Record<string,string>;
      const borrowed=new BorrowedModule(original,join(dirname(live.journal.filename),`borrowed-module-${id}.json`),{
        read:()=>live.observer.get('moduleactivations.appliance.magicstick.dev','ai-system',original.metadata.name!),
        set:async(enabled,parameters)=>{
          if(!enabled) {
            const instances=Object.values((await api.api.instances()).instances).flat();
            requireSafe(!instances.some(item=>modules.catalogJson?.applications?.[String(item.spec?.application)]?.requiredModules?.includes(id)),'CONFLICT');
          }
          const body=!Object.keys(parameters).length && (enabled || original.spec?.parameters === undefined) ? {} : {parameters};
          return api.write({method:'POST',path:`/api/modules/${id}/${enabled?'enable':'disable'}`,body},
            ()=>enabled?api.api.enableModule(id,parameters):api.api.disableModule(id,'parameters' in body ? parameters : undefined));
        },
      },live.guard);
      const runtimeProof=serviceRegressionEnabled()?new ModuleRuntimeProof(live,original,borrowed.receipt,
        String(modules.catalogJson?.modules?.[id]?.kustomizationName??''),modules.catalogJson?.modules?.[id]?.uninstallPolicy==='keep-data'):undefined;
      await runtimeProof?.capture();
      live.registerRestoration(async()=>{await runtimeProof?.capture();await borrowed.restore();await runtimeProof?.verifyRestored();});
      await borrowed.change(true,parameters);
    }
    await poll(async()=>{await live.guard();return api.api.modules();},value=>value.modules[id]?.enabled===true&&value.modules[id]?.status?.phase==='Ready',
      {timeoutMs:900_000,intervalMs:2000,stage:'module-ready'});
  }
}

export function validateAppFixtures(value:unknown):AppFixture[] {
  const automatic=Array.isArray(value) && value.length > 0 && value.every(item=>item&&repositoryAppAdapter(item));
  const required=appTypes.filter(applicationFixtureEnabled);
  requireSafe(Array.isArray(value) && value.length > 0 && value.length <= appTypes.length &&
    (automatic || required.every(type=>value.some(item=>item?.type===type))) &&
    new Set(value.map(item=>item.type)).size === value.length,'CONFIG');
  for(const item of value) {
    requireSafe(appTypes.includes(item.type) && (repositoryAppAdapter(item) ?
      Object.keys(item).sort().join(',') === 'adapter,originTemplate,responseMarker,type' :
      Object.keys(item).sort().join(',') === 'originTemplate,promptLabel,responseMarker,responseSelector,sendButton,type') &&
      (repositoryAppAdapter(item) ? ['responseMarker'] : ['promptLabel','responseMarker','responseSelector','sendButton']).every(key=>typeof item[key] === 'string' && item[key].length > 0 && item[key].length < 256) &&
      typeof item.originTemplate === 'string' && item.originTemplate.split('{name}').length === 2,'CONFIG');
    if(['hermes-terminal-v1','opencode-chat-v1'].includes(item.adapter))requireSafe(/^[A-Za-z0-9_-]{1,64}$/.test(item.responseMarker),'CONFIG');
    const url=new URL(item.originTemplate.replace('{name}','reg-fixture'));
    requireSafe(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,'CONFIG');
  }return value.filter(item=>applicationFixtureEnabled(item.type));
}
export function applicationPageReady(status:number|undefined,address:string,body:string|null,origin:string) {
  requireSafe(status===200&&new URL(address).origin===origin&&body?.trim()&&
    !/^(?:(?:403|404|500|502|503|504)\s|forbidden(?:\s|$)|access denied(?:\s|$)|not authorized(?:\s|$)|bad gateway(?:\s|$)|service unavailable(?:\s|$)|internal server error(?:\s|$))/i.test(body.trim()),'API');
}
async function appPage(context:BrowserContext,origin:string,guard:()=>Promise<void>,options:{path?:string;observe?:(page:Page)=>void|Promise<void>;reachable?:true}={}) {
  const page=await context.newPage();
  // Only the exact run-owned application's origin is admitted. Cross-origin
  // provider/API traffic remains fenced by the existing login context.
  await page.route(origin+'/**',async route=>{requireSafe(new URL(route.request().url()).origin === origin,'MUTATION');await guard();await route.continue();});
  try {await options.observe?.(page);const response=await page.goto(origin+(options.path??'/'),{waitUntil:'domcontentloaded'});
    if(options.reachable) {
      requireSafe(response?.status()===200&&new URL(page.url()).origin===origin,'API');
      await poll(async()=>{await guard();const body=await page.locator('body').textContent();if(!body?.trim())return false;
        applicationPageReady(response.status(),page.url(),body,origin);return true;},Boolean,{timeoutMs:120_000,intervalMs:250,stage:'app-ready'});
    }return page;}
  catch(error){await page.close();throw error;}
}
async function credentials(api:AdministrationApi,page:Page,name:string,supported:boolean) {
  const card=page.locator('article.service-instance').filter({hasText:name});
  if(!supported){await expect(card.getByRole('button',{name:'Credentials',exact:true})).toHaveCount(0);return;}
  const response=await api.request.get(api.origin+`/api/instances/${name}/credentials`,{timeout:api.timeoutMs,maxRedirects:0});
  requireSafe(response.status() === 200 && response.headers()['cache-control']?.includes('no-store'),'API');
  const payload=await response.json(),secrets=(payload.credentials ?? []).map((item:{value:string})=>item.value).filter((item:unknown)=>typeof item === 'string' && item.length >= 8);
  requireSafe(secrets.length > 0,'API');
  const listed=JSON.stringify(await api.api.instances());requireSafe(secrets.every((secret:string)=>!listed.includes(secret)),'API');
  await card.getByRole('button',{name:'Credentials',exact:true}).click();await expect(page.getByRole('dialog').locator('.credential-list')).toBeVisible();
  await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();
  const body=await page.locator('body').textContent(),storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
  requireSafe(secrets.every((secret:string)=>!body?.includes(secret) && !storage.includes(secret)),'API');
}

/** Inspect only the generated non-secret catalog, not application Secrets or
 * raw runtime logs. Every consumer-specific configuration must move together. */
export function catalogContext(data:Record<string,string>,name:string,context:number) {
  const parse=(key:string)=>{const text=data[key];if(!text || text.length > 1024*1024)return undefined;try{return JSON.parse(text);}catch{return undefined;}};
  const catalog=parse('catalog.json'),openclaw=parse('openclaw.json'),hermes=parse('hermes.yaml');
  const opencode=parse('opencode-providers.json'),paperclip=parse('paperclip-opencode-providers.json');
  const entry=catalog?.models?.find((item:{id:string})=>item.id === name),paperclipLimit=paperclip?.litellm?.models?.[name]?.limit;
  return /^[0-9a-f]{16}$/.test(catalog?.hash ?? '') && entry?.contextWindow === context &&
    openclaw?.models?.providers?.litellm?.models?.some((item:{id:string;contextWindow:number})=>item.id === name && item.contextWindow === context) &&
    hermes?.providers?.litellm?.models?.[name]?.context_length === context && opencode?.litellm?.models?.[name]?.limit?.context === context &&
    Number.isInteger(paperclipLimit?.context) && paperclipLimit.context > 0 && paperclipLimit.context <= context &&
    Number.isInteger(paperclipLimit?.output) && paperclipLimit.output > 0 && paperclipLimit.output <= paperclipLimit.context;
}

export async function applicationsWorkflow(live:LiveFoundation,browser:Browser) {
  requireSafe(liveWorkflowEnabled('applications'),'CONFIG');
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.identity?.approveDisposableUsers === true && profile.applications?.cleanerKubeconfig,'PREREQUISITE');
  const fixtures=validateAppFixtures(profile.applications.fixtures),cleaner=new AppCleaner(profile.applications.cleanerKubeconfig,live.config.requestTimeoutMs);
  requireSafe(fixtures.length>0,'PREREQUISITE');
  await cleaner.verifyConfiguration();const apps=new OwnedAppClient(live,cleaner),users=new OwnedIdentityClient(live);
  const gateway=await gatewaySnapshot(live.observer),actors:BrowserContext[]=[];
  const checkGateway=()=>test.step('Verify gateway process stability',async()=>assertGatewayStable(gateway,await gatewaySnapshot(live.observer)));
  return withCleanup(async()=>{
    const modules=await apps.api.api.modules(),models=await apps.api.api.models(),types=fixtures.map(fixture=>fixture.type);
    const fixture=await test.step('Select and size a native-context-compatible application model',()=>
      applicationModel(models,modules,types,async model=>{
        await live.guard();
        return preparationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,[model]).estimateMemory(estimateInput(model));
      }));
    await prepareApplications(live,apps.api,fixtures);
    await checkGateway();
    const before=(await apps.api.api.instances()).instances;
    const baseline=Object.values(before).flat().map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
    const model=await live.createModel('app-model',live.journal,fixture);await live.waitReady(model.client,model.uid,model.generation);
    const allowed=await users.create('app-allowed','user'),denied=await users.create('app-denied','user');
    for(const actor of [allowed,denied]) actors.push(await realLogin(browser,live.config,{actor:{username:actor.user.username,password:actor.password,
      initialPassword:actor.initialPassword,subject:actor.user.id,role:'magicstick-user'}}));
    for(const fixture of fixtures) {
      const page=await live.context.newPage();let name:string|undefined;
      try {
        name=await apps.createInUi(page,fixture.type,'app-'+fixture.type,model.client.name);
        const ready=await apps.ready(name),links=instanceResourceLinks(ready.item,await live.api.status());await checkGateway();
        const origin=new URL(fixture.originTemplate.replace('{name}',name.slice(fixture.type.length+1))).origin;
        requireSafe(links.some(link=>new URL(link.url).origin === origin) && ready.item.spec?.access?.exposure === 'local' && !ready.item.status?.publicURL,'API');
        await registerRuntimeDnsOrigins([origin],live.config.dashboardUrl);
        const routes=(await live.observer.list('httproutes.gateway.networking.k8s.io','identity-system')).filter(item=>ownedChild(item,name!,ready.item.metadata!.uid!));
        requireSafe(routes.length > 0 && routes.every(item=>!JSON.stringify(item.spec).includes('NodePort')),'API');
        const anonymous=await browser.newContext(regressionContextOptions());
        try {
          const result=await anonymous.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
          requireSafe([302,303,401,403].includes(result.status()),'API');
        }finally{await anonymous.close();}
        // The actual application UI must invoke the selected local model.
        const terminal=fixture.adapter==='hermes-terminal-v1'?new HermesTerminalEvidence(origin,model.client.name):undefined;
        const opencode=fixture.adapter==='opencode-chat-v1'?new OpenCodeChatEvidence(origin,model.client.name):undefined;
        const app=await appPage(actors[0]!,origin,live.guard,terminal?{path:'/chat',observe:page=>{observeHermesTerminal(page,terminal);}}:
          opencode?{path:openCodeChatPath,observe:page=>observeOpenCodeChat(page,opencode,live.guard)}:{});
        try {
          requireSafe(new URL(app.url()).origin === origin,'AUTH');
          if(terminal) {
            await withCleanup(()=>test.step('Use the native Hermes terminal and copy its fresh assistant response',()=>
              verifyHermesTerminalChat(app,terminal,live.guard,fixture.responseMarker)),
            ()=>writePrivate(journalFile(live.journal,'hermes-chat-proof.json'),{version:1,...terminal.snapshot()}));
          }else if(opencode) {
            await withCleanup(()=>test.step('Submit through native OpenCode and verify its owned-model assistant turn',()=>
              verifyOpenCodeChat(app,opencode,live.guard,fixture.responseMarker,{requestMs:live.config.requestTimeoutMs})),
            ()=>writePrivate(journalFile(live.journal,'opencode-chat-proof.json'),{version:1,...opencode.snapshot()}));
          }else if(fixture.adapter === 'semantic-chat-v1') {
            // Discover a unique visible semantic chat control, not a manually
            // maintained CSS selector. A wrong built-in adapter is a harness
            // failure, not a missing external prerequisite or fake inference.
            const input=app.getByRole('textbox').filter({visible:true});
            const send=app.getByRole('button',{name:/^(send|send message|submit|send prompt)$/i}).filter({visible:true});
            requireSafe(await input.count() === 1 && await send.count() === 1,'API');
            const responses=app.getByRole('article',{name:/assistant|assistant response/i})
              .or(app.getByRole('region',{name:/assistant response/i}));
            // Do not count the prompt echoed in a chat log as an answer.
            requireSafe(await responses.count() <= 1,'API');
            await input.fill('Reply with exactly '+fixture.responseMarker);await send.click();
            await expect(responses).toContainText(fixture.responseMarker,{timeout:180_000});
          } else {
            await app.getByLabel(fixture.promptLabel!,{exact:true}).fill('Reply with exactly '+fixture.responseMarker);
            await app.getByRole('button',{name:fixture.sendButton!,exact:true}).click();
            await expect(app.locator(fixture.responseSelector!)).toContainText(fixture.responseMarker,{timeout:180_000});
          }
        }finally{await app.close();}
        await page.goto(live.config.dashboardUrl+'/#/services');
        const catalog=(await apps.api.api.modules()).catalogJson?.applications?.[fixture.type];
        requireSafe(catalog?.displayName,'PREREQUISITE');
        const panel=page.locator('section.service-application').filter({has:page.getByText(catalog.displayName,{exact:true})}).first();
        const show=panel.getByRole('button',{name:'▸ Show',exact:true});if(await show.count())await show.click();
        await credentials(apps.api,page,name,['openclaw','odysseus','paperclip'].includes(fixture.type));
        const initial=await apps.api.api.instanceAccess(name);requireSafe(initial.authentication === 'sso' && initial.guardReady,'API');
        const sharing={mode:'selected' as const,users:[allowed.user.id],groups:[]};
        await apps.api.write({method:'PUT',path:`/api/instances/${name}/access`,body:{sharing,expectedRevision:initial.revision}},
          ()=>apps.api.api.updateInstanceAccess(name!,sharing,initial.revision));await apps.recordGeneration(name);
        await poll(()=>apps.api.api.instanceAccess(name!),value=>value.guardReady && value.sharing.mode === 'selected' && value.sharing.users?.includes(allowed.user.id) === true,
          {timeoutMs:120_000,intervalMs:1000,stage:'host-readiness'});
        for(let index=0;index<actors.length;index++) {
          const actorApi=new AdministrationApi(actors[index]!.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
          const listed=JSON.stringify(await actorApi.api.myInstances());requireSafe(listed.includes(name) === (index === 0),'API');
          const response=await actors[index]!.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
          if(index === 0) {
            const permitted=await appPage(actors[index]!,origin,live.guard);try{requireSafe(new URL(permitted.url()).origin === origin,'AUTH');}finally{await permitted.close();}
          } else {
            // Existing app sessions must be invalidated by the current ACL.
            const refused=await appPage(actors[index]!,origin,live.guard);try{requireSafe((await refused.locator('body').textContent())?.match(/forbidden|access denied|not authorized/i),'API');}finally{await refused.close();}
            requireSafe(response.status() !== 200,'API');
            for(const suffix of ['access','credentials']){
              const result=await actors[index]!.request.get(live.config.dashboardUrl+`/api/instances/${name}/${suffix}`,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
              requireSafe(result.status() === 403,'API');
            }
          }
        }
        const restore={mode:'all' as const,users:[],groups:[]},current=await apps.api.api.instanceAccess(name);
        await apps.api.write({method:'PUT',path:`/api/instances/${name}/access`,body:{sharing:restore,expectedRevision:current.revision}},
          ()=>apps.api.api.updateInstanceAccess(name!,restore,current.revision));await apps.recordGeneration(name);
        // Stop/start the catalog model and inspect freshly reconciled consumer
        // Helm values. No Secret is read; public-safe values carry model/context.
        const state=await live.modelState(model.client,model.uid),context=applicationEditContext(modules,types,Number(state.item!.spec?.local?.contextWindow));
        const edited=await model.client.editContext(state.item!,context);await live.journal.modelGeneration(model.client.name,model.uid,Number(state.item!.metadata?.generation),edited.generation);
        await live.waitReady(model.client,model.uid,edited.generation);
        await poll(async()=>{
          await live.guard();const map=await live.observer.get('configmaps','ai','ai-model-catalog') as unknown as {data?:Record<string,string>};
          return map.data && catalogContext(map.data,model.client.name,context);
        },Boolean,{timeoutMs:180_000,intervalMs:1000,stage:'model-update'});
        const releases=(await live.observer.list('helmreleases.helm.toolkit.fluxcd.io',ready.target.namespace)).filter(item=>
          item.metadata.name===ready.target.name && item.metadata.labels?.['app.kubernetes.io/managed-by']==='magicstick-operator' &&
          ownedChild(item,name!,ready.item.metadata!.uid!));
        requireSafe(releases.some(item=>JSON.stringify(item.spec?.values ?? {}).includes(model.client.name)),'API');
        await page.goto(live.config.dashboardUrl+'/#/services');
        const expand=panel.getByRole('button',{name:'▸ Show',exact:true});if(await expand.count())await expand.click();
        await apps.removeInUi(page,name);name=undefined;
        await checkGateway();
      }finally{await page.close();if(name)await apps.remove(name);}
    }
    // Explicit public instance, isolated from the SSO instances above. Canceling
    // the public choice first is checked before the approved owned creation.
    const page=await live.context.newPage();
    try {
      const type=fixtures[0]!.type;
      await page.goto(live.config.dashboardUrl+'/#/services');await page.getByRole('button',{name:'Create Instance',exact:true}).click();
      await page.getByRole('dialog').getByRole('combobox',{name:'Access',exact:true}).selectOption('none');
      await expect(page.getByRole('dialog').getByText(/public|without login/i).first()).toBeVisible();
      await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
      const name=await apps.createInUi(page,type,'public',model.client.name,true),ready=await apps.ready(name);
      const fixture=fixtures.find(item=>item.type === type)!,origin=new URL(fixture.originTemplate.replace('{name}',name.slice(type.length+1))).origin;
      requireSafe(instanceResourceLinks(ready.item,await live.api.status()).some(link=>new URL(link.url).origin===origin),'API');
      await registerRuntimeDnsOrigins([origin],live.config.dashboardUrl);
      const anonymous=await browser.newContext(regressionContextOptions());
      try{requireSafe((await anonymous.request.get(origin,{timeout:live.config.requestTimeoutMs,maxRedirects:0})).status() === 200,'API');}
      finally{await anonymous.close();await apps.remove(name);}
      // Restoration is an owned replacement with a fresh UID, never a blind
      // patch to an existing user's public instance.
      const protectedName=await apps.createInUi(page,type,'protected',model.client.name);await apps.ready(protectedName);await apps.remove(protectedName);
    }finally{await page.close();}
    const remaining=Object.values((await apps.api.api.instances()).instances).flat().map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
    requireSafe(remaining === baseline,'CLEANUP');
    return new Set(['APP-02','APP-05','APP-06','APP-07','APP-09','APP-10','ACL-01','ACL-02','ACL-04','ACL-06']);
  },()=>withCleanup(()=>withCleanup(async()=>{
    const closed=await Promise.allSettled(actors.map(context=>context.close()));
    requireSafe(closed.every(result=>result.status==='fulfilled'),'CLEANUP');
  },()=>live.cleanup()),checkGateway));
}


export type ApplicationServiceStage='installation'|'access';
/** This first service suite intentionally does not credit model integration. */
export function applicationStageIds(stage:ApplicationServiceStage) {
  requireSafe(['installation','access'].includes(stage),'CONFIG');
  return new Set(stage==='installation'?['APP-02','APP-10']:['APP-05','APP-07','ACL-01','ACL-02','ACL-04','ACL-06']);
}

/** The app form requires a deployed catalog model even when this suite does
 * not test inference. Keep its ordinary owned name within native admission. */
export async function prepareApplicationInstallModel(live:LiveFoundation,fixture:LocalModelFixture) {
  const model=await live.createModel('app-setup',live.journal,fixture);
  await live.waitReady(model.client,model.uid,model.generation);return model;
}

export function applicationSsoChallenge(status:number,location:string|undefined,identityUrl:string,clientId:string,redirectUrl:string) {
  requireSafe([302,303].includes(status)&&location,'AUTH');
  const target=new URL(location);
  requireSafe(target.origin===new URL(identityUrl).origin&&target.pathname==='/realms/magicstick/protocol/openid-connect/auth'&&
    !target.username&&!target.password&&target.searchParams.get('client_id')===clientId&&
    target.searchParams.get('redirect_uri')===redirectUrl&&target.searchParams.get('response_type')==='code'&&
    target.searchParams.get('scope')?.split(' ').includes('openid')&&target.searchParams.get('state'),'AUTH');
}

/** Narrow service-only path: normal installation, authenticated/public access
 * and exact uninstall. The deployed chat model is only the product form's
 * setup prerequisite; no prompt, inference or catalog-propagation test runs. */
export async function applicationServiceStage(live:LiveFoundation,browser:Browser,stage:ApplicationServiceStage,type?:string) {
  requireSafe(serviceRegressionEnabled()&&['installation','access'].includes(stage),'CONFIG');
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.applications?.cleanerKubeconfig&&(stage==='installation'||profile.identity?.approveDisposableUsers===true),'PREREQUISITE');
  const fixtures=validateAppFixtures(profile.applications.fixtures).filter(fixture=>!type||fixture.type===type);
  requireSafe(fixtures.length>0&&(!type||fixtures.length===1),'CONFIG');
  const cleaner=new AppCleaner(profile.applications.cleanerKubeconfig,live.config.requestTimeoutMs);
  await cleaner.verifyConfiguration();
  const apps=new OwnedAppClient(live,cleaner),users=new OwnedIdentityClient(live),actors:BrowserContext[]=[];
  const gateway=await gatewaySnapshot(live.observer);
  const verifyGateway=async()=>assertGatewayStable(gateway,await gatewaySnapshot(live.observer));
  const removeInUi=async(page:Page,name:string,type:string)=>{
    await page.goto(live.config.dashboardUrl+'/#/services');
    const catalog=(await apps.api.api.modules()).catalogJson?.applications?.[type];requireSafe(catalog?.displayName,'CONFIG');
    const panel=page.locator('section.service-application').filter({has:page.getByText(catalog.displayName,{exact:true})}).first();
    const show=panel.getByRole('button',{name:'▸ Show',exact:true});if(await show.count())await show.click();
    await apps.removeInUi(page,name);
  };
  const verifySso=async(name:string,uid:string,origin:string)=>{
    const [routes,policies]=await Promise.all([live.observer.list('httproutes.gateway.networking.k8s.io','identity-system'),
      live.observer.list('securitypolicies.gateway.envoyproxy.io','identity-system')]);
    const ownedRoutes=routes.filter(item=>ownedChild(item,name,uid)),ownedPolicies=policies.filter(item=>ownedChild(item,name,uid));
    requireSafe(ownedRoutes.length>0&&ownedRoutes.every(item=>!JSON.stringify(item.spec).includes('NodePort'))&&ownedPolicies.length===1,'API');
    const oidc=ownedPolicies[0]!.spec?.oidc as {provider?:{issuer?:string};clientID?:string;redirectURL?:string}|undefined,
      targets=ownedPolicies[0]!.spec?.targetRefs as Array<{kind?:string;name?:string}>|undefined;
    requireSafe(oidc?.provider?.issuer===live.config.identityUrl+'/realms/magicstick'&&oidc.clientID&&oidc.redirectURL&&
      targets?.length&&targets.every(target=>target.kind==='HTTPRoute'&&ownedRoutes.some(route=>route.metadata.name===target.name)),'AUTH');
    const callback=new URL(oidc.redirectURL);
    requireSafe(callback.origin===live.config.dashboardUrl&&callback.pathname.startsWith('/oauth2/callback/')&&
      ownedRoutes.some(route=>route.metadata.name===callback.pathname.slice('/oauth2/callback/'.length)),'AUTH');
    const anonymous=await browser.newContext(regressionContextOptions());
    try {await poll(async()=>{await live.guard();const result=await anonymous.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
      try {if([502,503,504].includes(result.status()))return false;
        applicationSsoChallenge(result.status(),result.headers().location,live.config.identityUrl,oidc.clientID!,oidc.redirectURL!);return true;}
      finally{await result.dispose();}},Boolean,{timeoutMs:120_000,intervalMs:1000,stage:'login-form'});}
    finally{await anonymous.close();}
  };
  return withCleanup(async()=>{
    const modules=await apps.api.api.modules(),models=await apps.api.api.models();
    const fixture=await test.step('Prepare the product-required owned CPU model configuration; no inference acceptance',()=>
      applicationModel(models,modules,fixtures.map(item=>item.type),async model=>{
        await live.guard();return preparationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,[model]).estimateMemory(estimateInput(model));
      }));
    await prepareApplications(live,apps.api,fixtures);await verifyGateway();
    const baseline=Object.values((await apps.api.api.instances()).instances).flat()
      .map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
    const model=await prepareApplicationInstallModel(live,fixture);
    const allowed=stage==='access'?await users.create('app-allowed','user'):undefined,
      denied=stage==='access'?await users.create('app-denied','user'):undefined;
    for(const actor of [allowed,denied])if(actor)actors.push(await realLogin(browser,live.config,{actor:{
      username:actor.user.username,password:actor.password,initialPassword:actor.initialPassword,subject:actor.user.id,role:'magicstick-user'}}));
    for(const fixture of fixtures) {
      const page=await live.context.newPage();let name:string|undefined;
      await withCleanup(async()=>{
        name=await apps.createInUi(page,fixture.type,'app-'+fixture.type,model.client.name);
        const ready=await apps.ready(name);await verifyGateway();
        if(stage==='access') {
          const origin=new URL(fixture.originTemplate.replace('{name}',name.slice(fixture.type.length+1))).origin;
          requireSafe(instanceResourceLinks(ready.item,await live.api.status()).some(link=>new URL(link.url).origin===origin)&&
            ready.item.spec?.access?.authentication==='sso'&&ready.item.spec.access.exposure==='local'&&!ready.item.status?.publicURL,'API');
          await registerRuntimeDnsOrigins([origin],live.config.dashboardUrl);
          await verifySso(name,ready.item.metadata!.uid!,origin);
          await page.goto(live.config.dashboardUrl+'/#/services');
          const catalog=(await apps.api.api.modules()).catalogJson?.applications?.[fixture.type];requireSafe(catalog?.displayName,'CONFIG');
          const panel=page.locator('section.service-application').filter({has:page.getByText(catalog.displayName,{exact:true})}).first();
          const show=panel.getByRole('button',{name:'▸ Show',exact:true});if(await show.count())await show.click();
          await credentials(apps.api,page,name,['openclaw','odysseus','paperclip'].includes(fixture.type));
          const initial=await apps.api.api.instanceAccess(name);requireSafe(initial.authentication==='sso'&&initial.guardReady,'API');
          const sharing={mode:'selected' as const,users:[allowed!.user.id],groups:[]};
          await apps.api.write({method:'PUT',path:`/api/instances/${name}/access`,body:{sharing,expectedRevision:initial.revision}},
            ()=>apps.api.api.updateInstanceAccess(name!,sharing,initial.revision));await apps.recordGeneration(name);
          await poll(()=>apps.api.api.instanceAccess(name!),value=>value.guardReady&&value.sharing.mode==='selected'&&value.sharing.users?.includes(allowed!.user.id)===true,
            {timeoutMs:120_000,intervalMs:1000,stage:'host-readiness'});
          for(let index=0;index<actors.length;index++) {
            const actorApi=new AdministrationApi(actors[index]!.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
            const listed=JSON.stringify(await actorApi.api.myInstances());requireSafe(listed.includes(name)===(index===0),'API');
            const access=await actors[index]!.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
            try {
              const native=await appPage(actors[index]!,origin,live.guard,index===0?{reachable:true}:{});
              try {if(index===0)requireSafe([200,302,303].includes(access.status())&&new URL(native.url()).origin===origin,'AUTH');
                else {requireSafe((await native.locator('body').textContent())?.match(/forbidden|access denied|not authorized/i),'API');
                  requireSafe(access.status()!==200,'API');}}
              finally{await native.close();}
              if(index!==0)for(const suffix of ['access','credentials']) {
                const refused=await actors[index]!.request.get(live.config.dashboardUrl+`/api/instances/${name}/${suffix}`,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
                try{requireSafe(refused.status()===403,'API');}finally{await refused.dispose();}
              }
            }finally{await access.dispose();}
          }
        }
        await removeInUi(page,name,fixture.type);name=undefined;await verifyGateway();
      },()=>withCleanup(()=>page.close(),async()=>{if(name)await apps.remove(name);}));
      if(stage==='access') {
        const publicPage=await live.context.newPage();let publicName:string|undefined;
        await withCleanup(async()=>{
          await publicPage.goto(live.config.dashboardUrl+'/#/services');await publicPage.getByRole('button',{name:'Create Instance',exact:true}).click();
          await publicPage.getByRole('dialog').getByRole('combobox',{name:'Access',exact:true}).selectOption('none');
          await expect(publicPage.getByRole('dialog').getByText(/public|without login/i).first()).toBeVisible();
          await publicPage.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
          publicName=await apps.createInUi(publicPage,fixture.type,'public',model.client.name,true);
          const ready=await apps.ready(publicName),origin=new URL(fixture.originTemplate.replace('{name}',publicName.slice(fixture.type.length+1))).origin;
          requireSafe(ready.item.spec?.access?.authentication==='none'&&instanceResourceLinks(ready.item,await live.api.status()).some(link=>new URL(link.url).origin===origin),'API');
          await registerRuntimeDnsOrigins([origin],live.config.dashboardUrl);
          const anonymous=await browser.newContext(regressionContextOptions());
          try {const response=await anonymous.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
            try{requireSafe(response.status()===200,'API');}finally{await response.dispose();}
            const native=await appPage(anonymous,origin,live.guard,{reachable:true});
            try{requireSafe(new URL(native.url()).origin===origin,'AUTH');}finally{await native.close();}}
          finally{await anonymous.close();}
          await removeInUi(publicPage,publicName,fixture.type);publicName=undefined;
          // Restoring SSO is a new owned replacement, never patching user data.
          const protectedName=await apps.createInUi(publicPage,fixture.type,'protected',model.client.name),protectedReady=await apps.ready(protectedName);
          requireSafe(protectedReady.item.spec?.access?.authentication==='sso','API');
          const protectedOrigin=new URL(fixture.originTemplate.replace('{name}',protectedName.slice(fixture.type.length+1))).origin;
          await registerRuntimeDnsOrigins([protectedOrigin],live.config.dashboardUrl);await verifySso(protectedName,protectedReady.item.metadata!.uid!,protectedOrigin);
          await removeInUi(publicPage,protectedName,fixture.type);await verifyGateway();
        },()=>withCleanup(()=>publicPage.close(),async()=>{if(publicName)await apps.remove(publicName);}));
      }
    }
    const remaining=Object.values((await apps.api.api.instances()).instances).flat().map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
    requireSafe(remaining===baseline,'CLEANUP');return applicationStageIds(stage);
  },()=>withCleanup(()=>withCleanup(async()=>{
    const closed=await Promise.allSettled(actors.map(context=>context.close()));requireSafe(closed.every(result=>result.status==='fulfilled'),'CLEANUP');
  },()=>live.cleanup()),verifyGateway));
}
