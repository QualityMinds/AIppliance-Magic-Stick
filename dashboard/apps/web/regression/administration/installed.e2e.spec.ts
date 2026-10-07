import {test,expect,type Browser,type BrowserContext} from '@playwright/test';
import {join} from 'node:path';
import type {LabConfig} from '../core/config.ts';
import {loadLabConfig} from '../core/config.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {gpuWorkerJournal} from '../core/gpu-scenario.ts';
import {AdministrationApi} from '../core/administration-api.ts';
import {OwnedIdentityClient} from '../core/owned-identity.ts';
import {HarnessError,requireSafe} from '../core/errors.ts';
import {readPrivate} from '../core/private-files.ts';
import {realLogin,openInferenceSession} from '../core/auth.ts';
import {InferenceProbe} from '../core/inference.ts';
import {poll} from '../core/poll.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {remainingPhase,remainingVariants,remainingVariantEnabled,type P0Definition} from '../profiles/remaining-p0.ts';
import {runHostDrill} from '../core/host-drill.ts';
import {realtimeWorkflow} from './realtime-live.ts';
import {gpuMemoryDraft,settingsDrafts} from './form-checks.ts';
import {kubernetesWorkflow} from './kubernetes-live.ts';
import {applicationsWorkflow} from './apps-live.ts';
import {modulesWorkflow,moduleProfileWorkflow} from './modules-live.ts';
import {licensingWorkflow} from './license-live.ts';
import {withUnlicensedBaseline} from '../core/license-baseline.ts';
import {meshWorkflow,stableMesh} from './mesh-live.ts';
import {federationWorkflow} from './federation-live.ts';
import {rbacWorkflow,unmanagedKeyWorkflow,securityCiWorkflow} from './security-live.ts';
import {cacheProtection,freeTokenCache} from './cache-live.ts';
import {companionWorkflow} from './companion-live.ts';

type Profile={version:1;identity?:{approveDisposableUsers:true};repeat?:{cycles:number;maximumMemoryGrowthMi:number;maximumNonCacheDiskGrowthBytes:number}};
let config:LabConfig,live:LiveFoundation|undefined,client:AdministrationApi;
const phase=remainingPhase(process.env.REGRESSION_MODE);
const workflows=new Map<string,Promise<Set<string>>>();
const contexts:BrowserContext[]=[];
let writesBlocked=0;
async function privateProfile():Promise<Profile> {
  requireSafe(process.env.REGRESSION_REMAINING_PROFILE,'PREREQUISITE');
  try {
    const value=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE));
    requireSafe(value?.version === 1 && Object.keys(value).every(key=>['version','identity','repeat','realtime','applications','modules','license','federation','kubernetes','mesh','unmanagedKey','cache','companion','moduleProfile','securityCi'].includes(key)),'CONFIG'); return value;
  } catch(error) {if(error instanceof HarnessError && error.code === 'PRIVATE_FILE') throw new HarnessError('PREREQUISITE'); throw error;}
}
function checked(condition:unknown) {if(!condition) throw new HarnessError('API','Failed');}
async function visible(route:string,text:string) {
  const page=await live!.context.newPage();
  try {await page.goto(config.dashboardUrl+'/#/'+route,{waitUntil:'domcontentloaded'}); await expect(page.getByText(text,{exact:true}).first()).toBeVisible();}
  finally {await page.close();}
}
async function denied(context:BrowserContext,path:string,method='GET',body?:unknown) {
  const response=await context.request.fetch(config.dashboardUrl+path,{method,timeout:config.requestTimeoutMs,maxRedirects:0,
    headers:{Accept:'application/json','X-MagicStick-CSRF':'dashboard',Origin:config.dashboardUrl},
    ...(body ? {data:JSON.stringify(body),headers:{Accept:'application/json','Content-Type':'application/json','X-MagicStick-CSRF':'dashboard',Origin:config.dashboardUrl}} : {})});
  checked([401,403].includes(response.status()));
}

async function identityWorkflow(browser:Browser) {
  const profile=await privateProfile(); requireSafe(profile.identity?.approveDisposableUsers === true,'PREREQUISITE');
  const identities=new OwnedIdentityClient(live!);
  const proofs=new Set<string>();
  const actors=new Map<string,{context:BrowserContext;password:string;user:Awaited<ReturnType<typeof identities.create>>['user']}>();
  for(const level of ['user','viewer','operator','admin'] as const) {
    const created=await identities.create('actor-'+level,level);
    const context=await realLogin(browser,config,{actor:{username:created.user.username,password:created.password,
      initialPassword:created.initialPassword,subject:created.user.id,role:`magicstick-${level}`},onBlockedMutation:()=>writesBlocked++});
    contexts.push(context); actors.set(level,{context,password:created.password,user:created.user});
    const session=await new AdministrationApi(context.request,config.dashboardUrl,config.requestTimeoutMs,async()=>{throw new HarnessError('MUTATION');}).api.session();
    checked(session.subject === created.user.id && session.username === created.user.username &&
      (level === 'admin' || !session.roles.includes('magicstick-admin')) &&
      (['admin','operator'].includes(level) || !session.roles.includes('magicstick-operator')));
    const changed=await identities.profile(created.user); checked(changed.firstName === 'Updated');
    await visible('system/users',created.user.username);
  }
  proofs.add('USER-02');
  const viewer=actors.get('viewer')!;
  await identities.enabled(viewer.user,false);
  checked(!(await identities.current(viewer.user)).enabled);
  const disabled=await viewer.context.request.get(config.dashboardUrl+'/api/users',{timeout:config.requestTimeoutMs,maxRedirects:0});
  checked([401,403,302,303].includes(disabled.status()));
  await identities.enabled(viewer.user,true); checked((await identities.current(viewer.user)).enabled);
  const initialPassword=await identities.reset(viewer.user);
  const newPassword='Reg4!'+live!.journal.runId;
  const replacement=await realLogin(browser,config,{actor:{username:viewer.user.username,subject:viewer.user.id,role:'magicstick-viewer',
    initialPassword,password:newPassword},onBlockedMutation:()=>writesBlocked++}); contexts.push(replacement);
  actors.set('viewer',{...viewer,context:replacement,password:newPassword});
  await visible('system/users',viewer.user.username); proofs.add('USER-03');
  // An owned actor's self-disable is the live guard fixture. Never demote or
  // disable the appliance's last administrator/recovery account to test it.
  const admin=actors.get('admin')!;
  const self=await admin.context.request.post(config.dashboardUrl+`/api/users/${admin.user.id}/disable`,{
    data:{},timeout:config.requestTimeoutMs,maxRedirects:0,headers:{Origin:config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'}});
  checked([400,409].includes(self.status()) && (await identities.current(admin.user)).enabled); proofs.add('USER-04');
  const mutations:Array<[string,string,unknown]>= [
    ['/api/users','POST',{username:live!.journal.prefix+'never',password:'invalid',enabled:false,accessLevel:'user'}],
    [`/api/users/${viewer.user.id}/roles`,'PUT',{accessLevel:'admin'}],
    [`/api/kubernetes-access/${viewer.user.id}`,'PUT',{accessLevel:'viewer'}],
    ['/api/host-management/operations','POST',{action:'reboot',nodeName:'invalid-fixture',nodeUid:'invalid-fixture',bootId:'invalid',confirmation:'wrong'}],
    ['/api/hardware/gpu-sharing','POST',{provider:'amd',mode:'shared',maxModels:2,expectedRevision:'invalid-fixture'}],
    [`/api/models/${live!.journal.prefix}missing/start`,'POST',{expectedRevision:'generation:missing:1'}],
    ['/api/api-access','POST',{name:'INVALID NAME'}], ['/api/mesh/invite','POST',{type:'invalid-fixture'}],
    ['/api/license','PUT',{document:'invalid-fixture',expectedRevision:'invalid-fixture'}],
    ['/api/federated-sso/providers','POST',{alias:'INVALID NAME',protocol:'invalid'}],
  ];
  for(const level of ['user','viewer'] as const) {
    const actor=actors.get(level)!;
    for(const [path,method,body] of mutations) await denied(actor.context,path,method,body);
    await denied(actor.context,`/api/models/${live!.journal.prefix}missing/logs?tailLines=300`);
    await denied(actor.context,'/api/modules/litellm/credentials');
    const page=await actor.context.newPage();
    try {await page.goto(config.dashboardUrl+'/#/system/users'); await expect(page.getByRole('button',{name:'Create user',exact:true})).toHaveCount(0);}
    finally {await page.close();}
  }
  await denied(actors.get('operator')!.context,`/api/models/${live!.journal.prefix}missing/logs?tailLines=300`);
  proofs.add('AUTH-04'); proofs.add('LOG-03');
  await identities.roles(admin.user,'viewer');
  await denied(admin.context,'/api/users');
  const refreshed=await realLogin(browser,config,{actor:{username:admin.user.username,password:admin.password,
    subject:admin.user.id,role:'magicstick-viewer'}});
  // The old administrator session is invalidated. Do not accept an old JWT or
  // a front-end role label as proof of live authorization after demotion.
  contexts.push(refreshed);
  await denied(refreshed,'/api/users');
  checked((await identities.current(admin.user)).accessLevel === 'viewer'); proofs.add('AUTH-08');
  for(const context of contexts.splice(0)) await context.close();
  await live!.cleanup();
  for(const {user} of actors.values()) checked(!(await identities.client.api.users(user.username,0,25)).users.some(item=>item.id === user.id));
  await visible('system/users','Users'); proofs.add('USER-05'); return proofs;
}
async function repeatWorkflow() {
  const profile=await privateProfile(); const limits=profile.repeat;
  requireSafe(limits && Number.isInteger(limits.cycles) && limits.cycles >= 3 && limits.cycles <= 10 &&
    Number.isSafeInteger(limits.maximumMemoryGrowthMi) && limits.maximumMemoryGrowthMi >= 0 && limits.maximumMemoryGrowthMi <= 8192 &&
    Number.isSafeInteger(limits.maximumNonCacheDiskGrowthBytes) && limits.maximumNonCacheDiskGrowthBytes >= 0 &&
    limits.maximumNonCacheDiskGrowthBytes <= 10*1024**3 && config.smokeModel && config.inferenceUrl,'PREREQUISITE');
  await openInferenceSession(live!.context,config.inferenceUrl,config.loginTimeoutMs);
  const baseline=await sample();
  for(let cycle=0;cycle<limits.cycles;cycle++) {
    const created=await live!.createModel('repeat-'+cycle);
    const key=await live!.createKey('repeat-key-'+cycle);
    const inference=new InferenceProbe(live!.context.request,config.inferenceUrl,key.secret);
    let state=await live!.waitReady(created.client,created.uid,created.generation);
    await inference.chat(created.client.name,config.smokeModel.url.split('://')[1]);
    const edited=await created.client.editContext(state.item!,config.smokeModel.contextWindow === 256 ? 512 : 256);
    await live!.journal.modelGeneration(created.client.name,created.uid,created.generation,edited.generation);
    state=await live!.waitReady(created.client,created.uid,edited.generation);
    const stopped=await created.client.stop(state.item!);
    await live!.journal.modelGeneration(created.client.name,created.uid,edited.generation,stopped.generation);
    const stoppedState=await poll(()=>live!.modelState(created.client,created.uid),value=>value.item?.spec?.enabled === false &&
      value.pods.length === 0 && !value.models.models?.some(model=>model.id === created.client.name),{timeoutMs:300_000,intervalMs:1000,stage:'model-stopped'});
    await inference.refusesStopped(created.client.name);
    const started=await created.client.start(stoppedState.item!);
    await live!.journal.modelGeneration(created.client.name,created.uid,stopped.generation,started.generation);
    await live!.waitReady(created.client,created.uid,started.generation); await inference.chat(created.client.name,config.smokeModel.url.split('://')[1]);
    await live!.cleanup(); checked(live!.journal.recoveryPlan().length === 0);
    const after=await sample();
    const {writePrivate}=await import('../core/private-files.ts');
    await writePrivate(join(process.env.REGRESSION_RUN_DIR!,`cycle-${cycle}.json`),{version:1,cycle,
      memoryGrowthMi:baseline.freeMi-after.freeMi,nonCacheDiskGrowthBytes:baseline.diskFree-after.diskFree-(after.cacheBytes-baseline.cacheBytes),
      cacheGrowthBytes:after.cacheBytes-baseline.cacheBytes,objectCountsStable:after.modelIds === baseline.modelIds && after.podIds === baseline.podIds &&
        after.intentIds === baseline.intentIds && after.claimIds === baseline.claimIds && after.routeIds === baseline.routeIds && after.keyIds === baseline.keyIds},true);
    checked(after.modelIds === baseline.modelIds && after.podIds === baseline.podIds && after.intentIds === baseline.intentIds &&
      after.claimIds === baseline.claimIds && after.routeIds === baseline.routeIds && after.keyIds === baseline.keyIds &&
      baseline.freeMi-after.freeMi <= limits.maximumMemoryGrowthMi &&
      baseline.diskFree-after.diskFree-(after.cacheBytes-baseline.cacheBytes) <= limits.maximumNonCacheDiskGrowthBytes);
  }
  return new Set(['PERF-02']);
}
async function sample() {
  const [models,pods,intents,claims,routes,hosts,keys]=await Promise.all([live!.api.models(),live!.observer.list('pods','ai'),
    live!.observer.list('modelactivations.appliance.magicstick.dev','ai-system'),live!.observer.list('resourceclaims.resource.k8s.io','ai'),
    live!.observer.list('httproutes.gateway.networking.k8s.io','identity-system'),client.api.hostManagement(),live!.keys.list()]);
  const cpu=models.computeMemory?.devices?.find(item=>item.computeTarget === 'cpu');
  const host=hosts.nodes.find(item=>config.expected.nodes.some(node=>node.uid === item.nodeUid));
  requireSafe(Number.isFinite(cpu?.freeMi) && Number.isFinite(host?.modelCache?.freeBytes) && Array.isArray(host?.modelCache?.caches),'PREREQUISITE');
  const ids=(items:Array<{metadata:{uid?:string}}>)=>items.map(item=>item.metadata.uid).sort().join(',');
  return {modelIds:models.activations.map(item=>item.metadata?.uid).sort().join(','),podIds:ids(pods),intentIds:ids(intents),claimIds:ids(claims),routeIds:ids(routes),
    keyIds:keys.items.map(item=>item.id).sort().join(','),freeMi:cpu!.freeMi!,diskFree:host!.modelCache!.freeBytes!,
    cacheBytes:host!.modelCache!.caches.reduce((sum,item)=>sum+Number(item.usedBytes ?? 0),0)};
}
async function oneWorkflow(name:string,execute:()=>Promise<Set<string>>,id:string) {
  let running=workflows.get(name); if(!running) {running=execute();workflows.set(name,running);}
  requireSafe((await running).has(id),'PREREQUISITE');
}
async function credentialWorkflow(browser:Browser) {
  requireSafe((await privateProfile()).identity?.approveDisposableUsers === true,'PREREQUISITE');
  const modules=await client.api.modules();
  const eligible=Object.keys(modules.modules).find(id=>modules.modules[id]?.enabled && modules.catalogJson?.modules?.[id]?.credentials?.provider);
  requireSafe(eligible,'PREREQUISITE');
  const identities=new OwnedIdentityClient(live!);
  const secrets:string[]=[];
  for(const level of ['operator','viewer'] as const) {
    const created=await identities.create('creds-'+level,level);
    const context=await realLogin(browser,config,{actor:{username:created.user.username,password:created.password,initialPassword:created.initialPassword,
      subject:created.user.id,role:`magicstick-${level}`}});contexts.push(context);
    const response=await context.request.get(config.dashboardUrl+`/api/modules/${eligible}/credentials`,{timeout:config.requestTimeoutMs,maxRedirects:0});
    if(level === 'viewer') checked(response.status() === 403);
    else {
      checked(response.status() === 200 && (response.headers()['cache-control'] ?? '').includes('no-store'));
      const payload=await response.json();checked(Array.isArray(payload.credentials) && payload.credentials.length > 0);
      for(const item of payload.credentials) if(typeof item.value === 'string' && item.value.length >= 8) secrets.push(item.value);
      const page=await context.newPage();
      try {
        await page.goto(config.dashboardUrl+'/#/services');
        const card=page.locator('section').filter({has:page.getByText(modules.catalogJson!.modules![eligible]!.displayName ?? eligible,{exact:true})}).first();
        await card.getByRole('button',{name:'Credentials',exact:true}).first().click();
        const dialog=page.getByRole('dialog');await expect(dialog.locator('.credential-list')).toBeVisible();
        await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
        const body=await page.locator('body').textContent();checked(secrets.every(secret=>!body?.includes(secret)));
        const storage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));checked(secrets.every(secret=>!storage.includes(secret)));
      } finally {await page.close();}
    }
    checked(secrets.every(secret=>!JSON.stringify(modules).includes(secret)));
    await context.close();contexts.splice(contexts.indexOf(context),1);await live!.cleanup(live!.journal,{kind:'identity',name:created.user.username});
  }
  return new Set(['MOD-10']);
}
async function runCase(definition:P0Definition,browser:Browser) {
  const id=definition.id;
  if(['USER-02','USER-03','USER-04','USER-05','AUTH-04','AUTH-08','LOG-03'].includes(id))
    return oneWorkflow('identity',()=>identityWorkflow(browser),id);
  if(id === 'MOD-10') return oneWorkflow('credentials',()=>credentialWorkflow(browser),id);
  if(id.startsWith('K8S-')) return oneWorkflow('kubernetes',()=>kubernetesWorkflow(live!,browser),id);
  if(id.startsWith('APP-') || id.startsWith('ACL-')) return oneWorkflow('applications',()=>applicationsWorkflow(live!,browser),id);
  if(['MOD-03','MOD-04'].includes(id)) return oneWorkflow('modules',()=>modulesWorkflow(live!),id);
  if(id === 'MOD-06')return moduleProfileWorkflow(live!);
  if(['LIC-02','LIC-03','LIC-04'].includes(id)) return oneWorkflow('license',()=>licensingWorkflow(live!),id);
  if(['SSO-02','SSO-04','SSO-05'].includes(id)) return oneWorkflow('federation',()=>federationWorkflow(live!,browser),id);
  if(['MESH-03','MESH-04','MESH-05','MESH-06','MESH-07'].includes(id)) return oneWorkflow('mesh',()=>meshWorkflow(live!,browser),id);
  if(id === 'PERF-02') return oneWorkflow('repeat',repeatWorkflow,id);
  if(id === 'KEY-04')return unmanagedKeyWorkflow(live!);
  if(id === 'SEC-04')return rbacWorkflow(live!);
  if(id === 'SEC-03')return securityCiWorkflow(live!);
  if(id === 'CACHE-02')return cacheProtection(live!);
  if(id === 'CACHE-07')return freeTokenCache(live!);
  if(id === 'MESH-09')return companionWorkflow(live!);
  if(id === 'UX-02') {
    const page=await live!.context.newPage(),host=(await live!.api.hostManagement()).nodes.find(item=>item.available);
    requireSafe(host,'PREREQUISITE');
    try{await settingsDrafts(page,config.dashboardUrl,host.name);checked(writesBlocked === 0);}finally{await page.close();}
    return;
  }
  if(id.startsWith('RT-')) return oneWorkflow('realtime',()=>realtimeWorkflow(live!),id);
  if(id === 'GPUHOST-01') {
    const hosts=await client.api.hostManagement(),host=hosts.nodes.find(item=>item.available && item.gpuMemory?.supported);
    requireSafe(host,'PREREQUISITE');const page=await live!.context.newPage();
    try {await page.goto(config.dashboardUrl+'/#/system/hardware');await gpuMemoryDraft(page,host.name);checked(writesBlocked === 0);}
    finally {await page.close();}return;
  }
  if(definition.gate && ['maintenance','network','channel','cache','reboot'].includes(definition.gate))
    return runHostDrill(live!,id).then(()=>undefined);
  if(id === 'HOST-01') {
    const hosts=await client.api.hostManagement(); checked(hosts.nodes.length > 0);
    for(const host of hosts.nodes) checked(typeof host.name === 'string' && typeof host.nodeUid === 'string' &&
      !Object.keys(host).some(key=>['password','secret','command','path'].includes(key)));
    return;
  }
  if(id === 'HOST-02') {
    const page=await live!.context.newPage();
    try {
      await page.goto(config.dashboardUrl+'/#/system/power');
      const restart=page.getByRole('button',{name:'Restart computer',exact:true}).first();
      await expect(restart).toBeEnabled(); await restart.click();
      await expect(page.getByRole('dialog').getByRole('button',{name:'Restart computer',exact:true})).toBeDisabled();
      await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
      checked(writesBlocked === 0);
    } finally {await page.close();} return;
  }
  if(id === 'MESH-01') {
    const before=stableMesh(await client.api.mesh()); const modules=JSON.stringify(await client.api.modules());
    await visible('system/settings/mesh','Private Mesh');
    checked(stableMesh(await client.api.mesh()) === before && JSON.stringify(await client.api.modules()) === modules && writesBlocked === 0); return;
  }
  if(id === 'LIC-01' || id === 'SSO-01') {
    return withUnlicensedBaseline(live!,async()=>{
    const license=await client.api.licenseStatus();requireSafe(license.edition === 'free' && !license.hasDocument,'PREREQUISITE');
    checked(!license.features.some(feature=>['mesh','gpu-sharing','models'].includes(feature.id)));
    const page=await live!.context.newPage();
    try {await page.goto(config.dashboardUrl+'/#/system/license');await expect(page.getByLabel('License file')).toBeVisible();
      await page.getByRole('tab',{name:'Settings',exact:true}).click();
      await expect(page.getByRole('tab',{name:'Federated SSO (registration or commercial license required)',exact:true})).toBeDisabled();
      await expect(page.getByRole('button',{name:'Mesh',exact:true})).toBeVisible();
    } finally {await page.close();}
    if(id === 'SSO-01') {
      const response=await live!.context.request.post(config.dashboardUrl+'/api/federated-sso/validate',{
        data:{protocol:'oidc',metadataUrl:'https://fixture.invalid/.well-known/openid-configuration'},headers:{Origin:config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'},timeout:config.requestTimeoutMs,maxRedirects:0});
      checked(response.status() === 403);
    }
    });
  }
  if(['AUTH-03','AUTH-05','SEC-01'].includes(id)) {
    const anonymous=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
    try {for(const path of ['/api/session','/api/users','/api/license','/api/api-access','/api/mesh']) {
      const response=await anonymous.request.get(config.dashboardUrl+path,{timeout:config.requestTimeoutMs,maxRedirects:0,
        headers:{'X-Auth-Request-User':'attacker','X-Auth-Request-Groups':'magicstick-admin'}});
      checked([401,403,302,303].includes(response.status()));
    }} finally {await anonymous.close();}
    if(id === 'AUTH-05') {
      const response=await live!.context.request.post(config.dashboardUrl+'/api/api-access',{timeout:config.requestTimeoutMs,maxRedirects:0,
        headers:{Origin:'https://attacker.example.invalid','Content-Type':'application/json'},data:{name:'INVALID NAME'}});
      checked(response.status() === 403);
    } return;
  }
  if(['KEY-02','KEY-05'].includes(id)) {
    const before=(await live!.keys.list()).items.map(item=>item.id).sort().join(',');
    const key=await live!.createKey('secrecy-'+id.toLowerCase());
    const listed=JSON.stringify(await live!.keys.list()); checked(!listed.includes(key.secret));
    if(id === 'KEY-05') {
      const anonymous=await browser.newContext({serviceWorkers:'block',acceptDownloads:false});
      try {
        for(const path of ['/api/users','/api/license','/api/mesh']) {
          const response=await anonymous.request.get(config.dashboardUrl+path,{headers:{Authorization:'Bearer '+key.secret},timeout:config.requestTimeoutMs,maxRedirects:0});
          checked([401,403,302,303].includes(response.status()));
        }
      } finally {await anonymous.close();}
    }
    await visible('api-access','API Access'); await live!.cleanup();
    checked((await live!.keys.list()).items.map(item=>item.id).sort().join(',') === before); return;
  }
  // An unimplemented dispatch is a harness defect, never a lab prerequisite.
  throw new HarnessError('CONFIG','Failed');
}

test.beforeAll(async({browser},testInfo)=>{
  requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR && process.env.REGRESSION_RUN_ID,'CONFIG');
  config=await loadLabConfig(process.env.REGRESSION_CONFIG);
  const {journal}=await gpuWorkerJournal(process.env.REGRESSION_RUN_DIR,testInfo.workerIndex,config.expected.applianceUid);
  live=await LiveFoundation.open(browser,config,journal,{inferenceOrigin:config.inferenceUrl,onBlockedMutation:()=>writesBlocked++});
  client=new AdministrationApi(live.context.request,config.dashboardUrl,config.requestTimeoutMs,live.guard);
});
test.afterAll(async()=>{for(const context of contexts.splice(0)) await context.close(); if(live) await live.close();});
for(const [variant,definition] of Object.entries(remainingVariants).filter(([,item])=>remainingVariantEnabled(item) && item.phase === phase &&
  (!process.env.REGRESSION_REMAINING_CASE || item.id === process.env.REGRESSION_REMAINING_CASE))
  .sort(([,a],[,b])=>Number(!['LIC-01','SSO-01'].includes(a.id))-Number(!['LIC-01','SSO-01'].includes(b.id)))) {
  const layers=definition.layers.filter(layer=>['A','E','O','N'].includes(layer));
  if(layers.length) test(`${definition.id} installed ${definition.group} acceptance`,
    evidenceAnnotations(...layers.map(layer=>({id:definition.id,variant,layer}))),({browser})=>runCase(definition,browser));
}
