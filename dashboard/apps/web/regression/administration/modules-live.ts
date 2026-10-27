import {expect,test} from '@playwright/test';
import {moduleResourceLinks,gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import type {LiveFoundation} from '../core/live-foundation.ts';
import type {GpuCompatibility} from '@magicstick/dashboard-contracts';
import type {KubeObject} from '../core/observer.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {readPrivate,writePrivate,journalFile} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';
import {browserMutation} from '../core/browser-action.ts';
import {withCleanup} from '../core/run-lifecycle.ts';
import {requireGpuProvider} from '../hardware/prerequisites.ts';
import {gatewaySnapshot,assertGatewayStable} from '../core/gateway-stability.ts';
import {registerRuntimeDnsOrigins} from '../core/browser-dns.ts';
import {moduleProbeLinks,probeModuleServices} from '../core/service-probes.ts';
import {liveWorkflowEnabled} from '../core/engine-policy.ts';
const moduleSettings=(value:{enabled?:boolean;parameters?:unknown}|undefined)=>canonical({enabled:value?.enabled,parameters:value?.parameters??{}});
const sharingSettings=(value:{providers:Array<{provider:string;mode:string;maxModels:number;backend:string;nodeUid:string}>})=>
  canonical(value.providers.map(({provider,mode,maxModels,backend,nodeUid})=>({provider,mode,maxModels,backend,nodeUid})).sort((a,b)=>a.provider.localeCompare(b.provider)));

/** An idle optional catalog-owned service is borrowed and restored exactly.
 * Never disable identity/dashboard/runtime/GPU or a module used by an app. */
export async function modulesWorkflow(live:LiveFoundation) {
  requireSafe(liveWorkflowEnabled('modules'),'CONFIG');
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),fixture=profile.modules;
  requireSafe(fixture?.approveOptionalModule === true && /^[a-z0-9-]{1,63}$/.test(fixture.id) && fixture.parameters && typeof fixture.parameters === 'object','PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const modules=await api.api.modules(),catalog=modules.catalogJson?.modules?.[fixture.id],baseline=modules.modules[fixture.id];
  requireSafe(catalog && baseline && typeof baseline.enabled === 'boolean' && catalog.activationMode === 'moduleactivation' &&
    !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh/.test(fixture.id),'PREREQUISITE');
  const instances=Object.values((await api.api.instances()).instances).flat();
  requireSafe(!instances.some(item=>modules.catalogJson?.applications?.[String(item.spec?.application)]?.requiredModules?.includes(fixture.id)) &&
    Object.keys(fixture.parameters).every(key=>catalog.parameters?.some(item=>item.name === key)) &&
    Object.values(fixture.parameters).every(value=>typeof value === 'string' && value.length < 128),'CONFIG');
  const intentResource='moduleactivations.appliance.magicstick.dev',ns=live.config.expected.applianceNamespace;
  const prior=(await live.observer.list(intentResource,ns)).find(item=>item.spec?.module === fixture.id);
  // A pre-created fixture is borrowed without changing its parameters.
  // The module API cannot remove a newly created intent or faithfully restore an
  // arbitrary original spec. Do not leave such a mutation behind on cleanup.
  requireSafe(typeof prior?.spec?.enabled === 'boolean' && prior.spec.enabled === baseline.enabled &&
    canonical(prior.spec.parameters ?? {}) === canonical(fixture.parameters),'PREREQUISITE');
  const receipt=journalFile(live.journal,'borrowed-module.json');
  const sharing=sharingSettings(await api.api.gpuSharing());
  const gateway=await gatewaySnapshot(live.observer);
  const checkGateway=()=>test.step('Verify gateway process stability',async()=>assertGatewayStable(gateway,await gatewaySnapshot(live.observer)));
  const borrowed=new BorrowedModule(prior,receipt,{read:async()=>{
    const current=(await live.observer.list(intentResource,ns)).find(item=>item.metadata.name === prior.metadata.name);
    requireSafe(current,'OWNERSHIP');return current;
  },set:async(enabled,parameters)=>{
    const body=!Object.keys(parameters).length && (enabled || prior.spec?.parameters === undefined) ? {} : {parameters};return api.write({method:'POST',path:`/api/modules/${fixture.id}/${enabled ? 'enable' : 'disable'}`,body},
      ()=>enabled ? api.api.enableModule(fixture.id,parameters) : api.api.disableModule(fixture.id,'parameters' in body ? parameters : undefined));
  }},live.guard);
  const unregister=live.registerRestoration(()=>borrowed.restore());
  const page=await live.context.newPage();
  await withCleanup(async()=>{
    if(prior.spec!.enabled === true) {
      await borrowed.change(false,fixture.parameters);
      await poll(()=>api.api.modules(),value=>value.modules[fixture.id]?.enabled === false &&
        ['Disabled','Suspended'].includes(value.modules[fixture.id]?.status?.phase ?? ''),
        {timeoutMs:300_000,intervalMs:1000,stage:'module-ready'});
      await checkGateway();
    }
    const beforeInvalid=moduleSettings((await api.api.modules()).modules[fixture.id]);
    const invalid={parameters:{unknownRegressionField:'invalid'}};
    let rejected=false;
    try{await borrowed.change(true,invalid.parameters,()=>api.write({method:'POST',path:`/api/modules/${fixture.id}/enable`,body:invalid},
      ()=>api.api.enableModule(fixture.id,invalid.parameters)));}
    catch(error){if(!(error instanceof AdministrationRejected))throw error;rejected=[400,422].includes(error.status);}
    requireSafe(rejected && moduleSettings((await api.api.modules()).modules[fixture.id]) === beforeInvalid,'API');
    await page.goto(live.config.dashboardUrl+'/#/services');
    const card=page.locator('section.panel').filter({has:page.locator('.panel-meta').filter({hasText:new RegExp('^'+fixture.id+'$')})});
    await expect(card).toHaveCount(1);
    if(Object.keys(fixture.parameters).length){await card.locator('summary').filter({hasText:'Configure'}).click();
      for(const [key,value] of Object.entries(fixture.parameters))await card.getByLabel(catalog.parameters!.find(item=>item.name === key)!.label ?? key,{exact:true}).fill(String(value));}
    const payload=Object.keys(fixture.parameters).length ? {parameters:fixture.parameters} : {};
    await borrowed.change(true,fixture.parameters,acknowledge=>browserMutation(page,{url:live.config.dashboardUrl+`/api/modules/${fixture.id}/enable`,
      body:payload,timeoutMs:live.config.requestTimeoutMs,guard:live.guard,acknowledge:async()=>acknowledge()},
      ()=>card.getByRole('button',{name:'Enable',exact:true}).click({timeout:live.config.requestTimeoutMs})));
    const intent=await poll(async()=>{await live.guard();return (await live.observer.list(intentResource,ns)).find(item=>item.spec?.module === fixture.id);},
      value=>Boolean(value?.metadata.uid && value.spec?.enabled === true),{timeoutMs:30_000,intervalMs:500,stage:'model-update'});
    requireSafe(intent?.metadata.uid === prior.metadata.uid,'OWNERSHIP');
    await poll(async()=>{await live.guard();return api.api.modules();},value=>value.modules[fixture.id]?.enabled === true && value.modules[fixture.id]?.status?.phase === 'Ready',
      {timeoutMs:900_000,intervalMs:2000,stage:'module-ready'});
    await checkGateway();
    const ready=(await api.api.modules()).modules[fixture.id]!,status=await live.api.status();
    requireSafe(canonical(ready.parameters ?? {}) === canonical(fixture.parameters) && sharingSettings(await api.api.gpuSharing()) === sharing,'API');
    await test.step('Verify enabled service on the registered connection scope (not its TLS certificate)',async()=>{
      const links=moduleProbeLinks(moduleResourceLinks(fixture.id,catalog,status),live.config.dashboardUrl);
      await registerRuntimeDnsOrigins(links.map(link=>new URL(link.url).origin),live.config.dashboardUrl);
      await probeModuleServices(live.context.request,links,live.config.requestTimeoutMs);
    });
    await page.reload();await expect(card.getByRole('button',{name:'Disable',exact:true})).toBeVisible();
    await borrowed.change(false,fixture.parameters);
    await poll(()=>api.api.modules(),value=>value.modules[fixture.id]?.enabled === false &&
      ['Disabled','Suspended'].includes(value.modules[fixture.id]?.status?.phase ?? ''),
      {timeoutMs:300_000,intervalMs:1000,stage:'module-ready'});
    await page.reload();await expect(card.getByRole('button',{name:'Enable',exact:true})).toBeVisible();
  },()=>test.step('Restore exact borrowed module settings',()=>withCleanup(async()=>{
    await page.close().catch(()=>{});
    await borrowed.restore(); unregister();
    await poll(async()=>{await live.guard();return api.api.modules();},value=>value.modules[fixture.id]?.enabled === prior.spec!.enabled &&
      (prior.spec!.enabled ? value.modules[fixture.id]?.status?.phase === 'Ready' : ['Disabled','Suspended'].includes(value.modules[fixture.id]?.status?.phase ?? '')),
      {timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});
    requireSafe(sharingSettings(await api.api.gpuSharing()) === sharing,'CLEANUP');
  },checkGateway)));
  const restored=await live.context.newPage();try{await restored.goto(live.config.dashboardUrl+'/#/services');await expect(restored.locator('section.panel').filter({hasText:fixture.id}).getByRole('button',{name:prior.spec!.enabled?'Disable':'Enable',exact:true}).first()).toBeVisible();}finally{await restored.close();}
  return new Set(['MOD-03','MOD-04']);
}

/** A confirmed intent write can precede its controller projection. Reload only
 * after that exact revision is observed, never after an arbitrary sleep or by
 * accepting another writer's profile. Read/API errors remain errors. */
export async function waitModuleProfileReadback(read:()=>Promise<{intent:KubeObject;compatibility?:GpuCompatibility}>,
  expected:KubeObject,options:{timeoutMs?:number;stage?:'module-ready'|'recovery-module'}={}) {
  requireSafe(expected.metadata.uid&&expected.metadata.generation&&expected.spec?.parameters,'OWNERSHIP');
  const parameters=expected.spec.parameters as Record<string,string>;
  return poll(async()=>{
    const observed=await read();
    requireSafe(!observed.intent.metadata.deletionTimestamp&&observed.intent.metadata.uid===expected.metadata.uid&&observed.intent.metadata.generation===expected.metadata.generation&&
      canonical(observed.intent.spec)===canonical(expected.spec),'CONFLICT');
    return observed;
  },value=>value.intent.status?.observedGeneration===expected.metadata.generation&&
    typeof value.compatibility?.selectedProfile==='string'&&value.compatibility.selectedProfile===(parameters.compatibilityProfile??'')&&
    value.compatibility.allowExperimental===(parameters.allowExperimental==='true'),
  {timeoutMs:options.timeoutMs??120_000,intervalMs:1000,stage:options.stage??'module-ready'});
}

/** Test the real generic profile write that originally discarded gpuSharing.
 * The alternative is explicit; no kernel/host operation or validation is run.
 * Only an idle managed AMD intent is borrowed, then restored exactly. */
export async function moduleProfileWorkflow(live:LiveFoundation) {
  requireGpuProvider(live.config,'amd');
  const plan=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)).moduleProfile;
  requireSafe(plan?.approveTemporaryProfile === true && typeof plan.profileId === 'string' && typeof plan.allowExperimental === 'boolean' && live.config.gpu,'PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const compatibility=(await live.api.status()).hardwareOperators?.['amd-gpu']?.compatibility;
  requireSafe(compatibility && plan.profileId !== (compatibility.selectedProfile ?? '') &&
    (!plan.profileId || compatibility.profiles.some(profile=>profile.id === plan.profileId)),'PREREQUISITE');
  const read=async()=>{
    const matches=(await live.observer.list('moduleactivations.appliance.magicstick.dev','ai-system')).filter(item=>item.spec?.module === 'amd-gpu');
    requireSafe(matches.length === 1,'OWNERSHIP');return matches[0]!;
  };
  const readback=async()=>{
    await live.guard();
    return {intent:await read(),compatibility:(await live.api.status()).hardwareOperators?.['amd-gpu']?.compatibility};
  };
  const original=await read(),parameters=original.spec?.parameters as Record<string,string>;
  requireSafe(original.metadata.uid && original.metadata.generation && original.spec?.enabled === true && parameters?.gpuSharing &&
    !parameters.validationRequest,'PREREQUISITE');
  const payload=gpuCompatibilityParameters(plan.profileId,compatibility.profiles,plan.allowExperimental);
  const expected={...original.spec,parameters:{...parameters,...payload}};
  const receipt=journalFile(live.journal,'borrowed-amd-profile.json');
  await writePrivate(receipt,{version:1,uid:original.metadata.uid,generation:original.metadata.generation,originalSpec:original.spec,state:'requested'},true);
  let applied:Awaited<ReturnType<typeof read>>|undefined;
  try {
    const page=await live.context.newPage();
    try {
      await page.goto(live.config.dashboardUrl+'/#/system/hardware');
      const node=page.getByRole('article',{name:`GPU node ${live.config.gpu.nodeName}`,exact:true});
      await node.getByText('GPU Configuration AMD',{exact:true}).click();await node.getByText('AMD runtime profile',{exact:true}).click();
      await node.getByRole('combobox',{name:'AMD compatibility profile',exact:true}).selectOption(plan.profileId);
      if(plan.profileId && compatibility.profiles.find(profile=>profile.id === plan.profileId)?.experimental)
        await node.getByRole('checkbox',{name:'I accept the experimental hardware profile and its limitations.',exact:true}).check();
      const handler=async(route:import('@playwright/test').Route)=>{
        const fresh=await read();requireSafe(fresh.metadata.uid === original.metadata.uid && fresh.metadata.generation === original.metadata.generation &&
          canonical(fresh.spec) === canonical(original.spec) && route.request().method() === 'POST' && canonical(route.request().postDataJSON()) === canonical({parameters:payload}),'MUTATION');
        await live.guard();await route.continue();
      };
      await page.route(live.config.dashboardUrl+'/api/modules/amd-gpu/enable',handler);
      await node.getByRole('button',{name:'Save hardware profile',exact:true}).click();
      applied=await poll(read,item=>item.metadata.uid === original.metadata.uid && item.metadata.generation === Number(original.metadata.generation)+1,
        {timeoutMs:30_000,intervalMs:500,stage:'model-update'});
      requireSafe(canonical(applied.spec) === canonical(expected) && (applied.spec?.parameters as Record<string,string>).gpuSharing === parameters.gpuSharing,'API');
      await writePrivate(receipt,{version:1,uid:applied.metadata.uid,generation:applied.metadata.generation,originalSpec:original.spec,appliedSpec:applied.spec,state:'applied'});
      await test.step('Wait for the saved module profile status',()=>waitModuleProfileReadback(readback,applied!));
      await page.reload();await node.getByText('GPU Configuration AMD',{exact:true}).click();await node.getByText('AMD runtime profile',{exact:true}).click();
      await expect(node.getByRole('combobox',{name:'AMD compatibility profile',exact:true})).toHaveValue(plan.profileId);
    }finally{await page.close();}
  }finally{
    if(applied) {
      const current=await read();requireSafe(current.metadata.uid === applied.metadata.uid && current.metadata.generation === applied.metadata.generation && canonical(current.spec) === canonical(applied.spec),'CONFLICT');
      const restore={compatibilityProfile:parameters.compatibilityProfile ?? '',allowExperimental:parameters.allowExperimental ?? 'false'};
      await api.write({method:'POST',path:'/api/modules/amd-gpu/enable',body:{parameters:restore}},()=>api.api.enableModule('amd-gpu',restore));
      const restored=await poll(read,item=>item.metadata.generation === Number(applied!.metadata.generation)+1,{timeoutMs:30_000,intervalMs:500,stage:'cleanup'});
      requireSafe(restored.metadata.uid === original.metadata.uid && canonical(restored.spec) === canonical(original.spec),'CLEANUP');
      await writePrivate(receipt,{version:1,uid:restored.metadata.uid,generation:restored.metadata.generation,state:'restored'});
      await test.step('Wait for the restored module profile status',()=>waitModuleProfileReadback(readback,restored,{stage:'recovery-module'}));
    }
  }
}
