import {expect,type Browser,type BrowserContext,type Page} from '@playwright/test';
import {instanceResourceLinks} from '@magicstick/dashboard-core';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AppCleaner,OwnedAppClient,appTypes,type AppFixture,ownedChild} from '../core/owned-app.ts';
import {AdministrationApi} from '../core/administration-api.ts';
import {OwnedIdentityClient} from '../core/owned-identity.ts';
import {realLogin} from '../core/auth.ts';
import {readPrivate} from '../core/private-files.ts';
import {poll} from '../core/poll.ts';
import {requireProof as requireSafe} from '../core/errors.ts';

export function validateAppFixtures(value:unknown):AppFixture[] {
  const automatic=Array.isArray(value) && value.length > 0 && value.every(item=>item.adapter === 'semantic-chat-v1');
  requireSafe(Array.isArray(value) && (automatic ? value.length <= appTypes.length : value.length === appTypes.length) &&
    new Set(value.map(item=>item.type)).size === value.length,'CONFIG');
  for(const item of value) {
    requireSafe(appTypes.includes(item.type) && (item.adapter === 'semantic-chat-v1' ?
      Object.keys(item).sort().join(',') === 'adapter,originTemplate,responseMarker,type' :
      Object.keys(item).sort().join(',') === 'originTemplate,promptLabel,responseMarker,responseSelector,sendButton,type') &&
      (item.adapter === 'semantic-chat-v1' ? ['responseMarker'] : ['promptLabel','responseMarker','responseSelector','sendButton']).every(key=>typeof item[key] === 'string' && item[key].length > 0 && item[key].length < 256) &&
      typeof item.originTemplate === 'string' && item.originTemplate.split('{name}').length === 2,'CONFIG');
    const url=new URL(item.originTemplate.replace('{name}','reg-fixture'));
    requireSafe(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,'CONFIG');
  }return value;
}
async function appPage(context:BrowserContext,origin:string,guard:()=>Promise<void>) {
  const page=await context.newPage();
  // Only the exact run-owned application's origin is admitted. Cross-origin
  // provider/API traffic remains fenced by the existing login context.
  await page.route(origin+'/**',async route=>{requireSafe(new URL(route.request().url()).origin === origin,'MUTATION');await guard();await route.continue();});
  await page.goto(origin,{waitUntil:'domcontentloaded'});return page;
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
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.identity?.approveDisposableUsers === true && profile.applications?.cleanerKubeconfig,'PREREQUISITE');
  const fixtures=validateAppFixtures(profile.applications.fixtures),cleaner=new AppCleaner(profile.applications.cleanerKubeconfig,live.config.requestTimeoutMs);
  await cleaner.verifyConfiguration();const apps=new OwnedAppClient(live,cleaner),users=new OwnedIdentityClient(live);
  const before=(await apps.api.api.instances()).instances;
  const baseline=Object.values(before).flat().map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
  const model=await live.createModel('app-model');await live.waitReady(model.client,model.uid,model.generation);
  const allowed=await users.create('app-allowed','user'),denied=await users.create('app-denied','user');
  const actors:BrowserContext[]=[];
  try {
    for(const actor of [allowed,denied]) actors.push(await realLogin(browser,live.config,{actor:{username:actor.user.username,password:actor.password,
      initialPassword:actor.initialPassword,subject:actor.user.id,role:'magicstick-user'}}));
    for(const fixture of fixtures) {
      const page=await live.context.newPage();let name:string|undefined;
      try {
        name=await apps.createInUi(page,fixture.type,'app-'+fixture.type,model.client.name);
        const ready=await apps.ready(name),links=instanceResourceLinks(ready.item,await live.api.status());
        const origin=new URL(fixture.originTemplate.replace('{name}',name.slice(fixture.type.length+1))).origin;
        requireSafe(links.some(link=>new URL(link.url).origin === origin) && ready.item.spec?.access?.exposure === 'local' && !ready.item.status?.publicURL,'API');
        const routes=(await live.observer.list('httproutes.gateway.networking.k8s.io','identity-system')).filter(item=>ownedChild(item,name!,ready.item.metadata!.uid!));
        requireSafe(routes.length > 0 && routes.every(item=>!JSON.stringify(item.spec).includes('NodePort')),'API');
        const anonymous=await browser.newContext({serviceWorkers:'block'});
        try {
          const result=await anonymous.request.get(origin,{maxRedirects:0,timeout:live.config.requestTimeoutMs});
          requireSafe([302,303,401,403].includes(result.status()),'API');
        }finally{await anonymous.close();}
        // The actual application UI must invoke the selected local model.
        const app=await appPage(actors[0]!,origin,live.guard);
        try {
          requireSafe(new URL(app.url()).origin === origin,'AUTH');
          if(fixture.adapter === 'semantic-chat-v1') {
            // Discover a unique visible semantic chat control, not a manually
            // maintained CSS selector. Ambiguous/unsupported app surfaces are
            // a missing adapter prerequisite, never synthetic inference.
            const input=app.getByRole('textbox').filter({visible:true});
            const send=app.getByRole('button',{name:/^(send|send message|submit|send prompt)$/i}).filter({visible:true});
            requireSafe(await input.count() === 1 && await send.count() === 1,'PREREQUISITE');
            const responses=app.getByRole('article',{name:/assistant|assistant response/i})
              .or(app.getByRole('region',{name:/assistant response/i}));
            // Do not count the prompt echoed in a chat log as an answer.
            requireSafe(await responses.count() <= 1,'PREREQUISITE');
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
        const state=await live.modelState(model.client,model.uid),context=Number(state.item!.spec?.local?.contextWindow) === 256 ? 512 : 256;
        const edited=await model.client.editContext(state.item!,context);await live.journal.modelGeneration(model.client.name,model.uid,Number(state.item!.metadata?.generation),edited.generation);
        await live.waitReady(model.client,model.uid,edited.generation);
        await poll(async()=>{
          await live.guard();const map=await live.observer.get('configmaps','ai','ai-model-catalog') as unknown as {data?:Record<string,string>};
          return map.data && catalogContext(map.data,model.client.name,context);
        },Boolean,{timeoutMs:180_000,intervalMs:1000,stage:'model-update'});
        const releases=(await live.observer.list('helmreleases.helm.toolkit.fluxcd.io','ai')).filter(item=>ownedChild(item,name!,ready.item.metadata!.uid!));
        requireSafe(releases.some(item=>JSON.stringify(item.spec?.values ?? {}).includes(model.client.name)),'API');
        await page.goto(live.config.dashboardUrl+'/#/services');
        const expand=panel.getByRole('button',{name:'▸ Show',exact:true});if(await expand.count())await expand.click();
        await apps.removeInUi(page,name);name=undefined;
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
      const name=await apps.createInUi(page,type,'public',model.client.name,true);await apps.ready(name);
      const fixture=fixtures.find(item=>item.type === type)!,origin=new URL(fixture.originTemplate.replace('{name}',name.slice(type.length+1))).origin;
      const anonymous=await browser.newContext({serviceWorkers:'block'});
      try{requireSafe((await anonymous.request.get(origin,{timeout:live.config.requestTimeoutMs,maxRedirects:0})).status() === 200,'API');}
      finally{await anonymous.close();await apps.remove(name);}
      // Restoration is an owned replacement with a fresh UID, never a blind
      // patch to an existing user's public instance.
      const protectedName=await apps.createInUi(page,type,'protected',model.client.name);await apps.ready(protectedName);await apps.remove(protectedName);
    }finally{await page.close();}
    const remaining=Object.values((await apps.api.api.instances()).instances).flat().map(item=>`${item.metadata?.uid}:${item.metadata?.generation}`).sort().join(',');
    requireSafe(remaining === baseline,'CLEANUP');
    return new Set(['APP-02','APP-05','APP-06','APP-07','APP-09','APP-10','ACL-01','ACL-02','ACL-04','ACL-06']);
  }finally{for(const context of actors)await context.close();await live.cleanup();}
}
