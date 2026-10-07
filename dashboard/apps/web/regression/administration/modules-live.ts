import {expect} from '@playwright/test';
import {moduleResourceLinks,gpuCompatibilityParameters} from '@magicstick/dashboard-core';
import {join} from 'node:path';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {readPrivate,writePrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {BorrowedModule} from '../core/borrowed-module.ts';

/** An optional catalog-owned module is borrowed only from a disabled baseline.
 * Never disable identity/dashboard/runtime/GPU or a module used by an app. */
export async function modulesWorkflow(live:LiveFoundation) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),fixture=profile.modules;
  requireSafe(fixture?.approveOptionalModule === true && /^[a-z0-9-]{1,63}$/.test(fixture.id) && fixture.parameters && typeof fixture.parameters === 'object','PREREQUISITE');
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const modules=await api.api.modules(),catalog=modules.catalogJson?.modules?.[fixture.id],baseline=modules.modules[fixture.id];
  requireSafe(catalog && baseline && !baseline.enabled && catalog.activationMode === 'moduleactivation' &&
    !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh/.test(fixture.id),'PREREQUISITE');
  const instances=Object.values((await api.api.instances()).instances).flat();
  requireSafe(!instances.some(item=>modules.catalogJson?.applications?.[String(item.spec?.application)]?.requiredModules?.includes(fixture.id)) &&
    Object.keys(fixture.parameters).every(key=>catalog.parameters?.some(item=>item.name === key)) &&
    Object.values(fixture.parameters).every(value=>typeof value === 'string' && value.length < 128),'CONFIG');
  const intentResource='moduleactivations.appliance.magicstick.dev',ns=live.config.expected.applianceNamespace;
  const prior=(await live.observer.list(intentResource,ns)).find(item=>item.spec?.module === fixture.id);
  // A disabled pre-created fixture is borrowed without changing its parameters.
  // The module API cannot remove a newly created intent or faithfully restore an
  // arbitrary original spec. Do not leave such a mutation behind on cleanup.
  requireSafe(prior?.spec?.enabled === false && JSON.stringify(prior.spec.parameters ?? {}) === JSON.stringify(fixture.parameters),'PREREQUISITE');
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'borrowed-module.json');
  const sharing=JSON.stringify(await api.api.gpuSharing());
  const borrowed=new BorrowedModule(prior,receipt,{read:async()=>{
    const current=(await live.observer.list(intentResource,ns)).find(item=>item.metadata.name === prior.metadata.name);
    requireSafe(current,'OWNERSHIP');return current;
  },set:async(enabled,parameters)=>{
    const body={parameters};return api.write({method:'POST',path:`/api/modules/${fixture.id}/${enabled ? 'enable' : 'disable'}`,body},
      ()=>enabled ? api.api.enableModule(fixture.id,parameters) : api.api.disableModule(fixture.id,parameters));
  }},live.guard);
  const unregister=live.registerRestoration(()=>borrowed.restore());
  const page=await live.context.newPage();
  try {
    const beforeInvalid=JSON.stringify((await api.api.modules()).modules[fixture.id]);
    const invalid={parameters:{unknownRegressionField:'invalid'}};
    let rejected=false;
    try{await borrowed.change(true,invalid.parameters,()=>api.write({method:'POST',path:`/api/modules/${fixture.id}/enable`,body:invalid},
      ()=>api.api.enableModule(fixture.id,invalid.parameters)));}
    catch(error){if(!(error instanceof AdministrationRejected))throw error;rejected=[400,422].includes(error.status);}
    requireSafe(rejected && JSON.stringify((await api.api.modules()).modules[fixture.id]) === beforeInvalid,'API');
    await page.goto(live.config.dashboardUrl+'/#/services');
    const card=page.locator('section.panel').filter({has:page.locator('.panel-meta').filter({hasText:new RegExp('^'+fixture.id+'$')})});
    await expect(card).toHaveCount(1);
    if(Object.keys(fixture.parameters).length){await card.locator('summary').filter({hasText:'Configure'}).click();
      for(const [key,value] of Object.entries(fixture.parameters))await card.getByLabel(catalog.parameters!.find(item=>item.name === key)!.label ?? key,{exact:true}).fill(String(value));}
    const payload=Object.keys(fixture.parameters).length ? {parameters:fixture.parameters} : {};
    const handler=async(route:import('@playwright/test').Route)=>{requireSafe(route.request().method() === 'POST' && JSON.stringify(route.request().postDataJSON()) === JSON.stringify(payload),'MUTATION');await live.guard();await route.continue();};
    await page.route(live.config.dashboardUrl+`/api/modules/${fixture.id}/enable`,handler);
    try{await borrowed.change(true,fixture.parameters,async()=>{
      const [response]=await Promise.all([page.waitForResponse(value=>value.url() === live.config.dashboardUrl+`/api/modules/${fixture.id}/enable` &&
        value.request().method() === 'POST'),card.getByRole('button',{name:'Enable',exact:true}).click()]);
      await response.finished();requireSafe(response.ok(),'API');
    });}
    finally{await page.unroute(live.config.dashboardUrl+`/api/modules/${fixture.id}/enable`,handler);}
    const intent=await poll(async()=>{await live.guard();return (await live.observer.list(intentResource,ns)).find(item=>item.spec?.module === fixture.id);},
      value=>Boolean(value?.metadata.uid && value.spec?.enabled === true),{timeoutMs:30_000,intervalMs:500,stage:'model-update'});
    requireSafe(intent?.metadata.uid === prior.metadata.uid,'OWNERSHIP');
    await poll(()=>api.api.modules(),value=>value.modules[fixture.id]?.enabled === true && value.modules[fixture.id]?.status?.phase === 'Ready',
      {timeoutMs:900_000,intervalMs:2000,stage:'model-ready'});
    const ready=(await api.api.modules()).modules[fixture.id]!,status=await live.api.status();
    requireSafe(JSON.stringify(ready.parameters ?? {}) === JSON.stringify(fixture.parameters) && JSON.stringify(await api.api.gpuSharing()) === sharing,'API');
    const links=moduleResourceLinks(fixture.id,catalog,status);requireSafe(links.length > 0,'PREREQUISITE');
    for(const link of links){const url=new URL(link.url);requireSafe(url.protocol === 'https:' && !url.username && !url.password,'CONFIG');
      const response=await live.context.request.get(url.href,{maxRedirects:0,timeout:live.config.requestTimeoutMs});requireSafe([200,302,303].includes(response.status()),'API');}
    await page.reload();await expect(card.getByRole('button',{name:'Disable',exact:true})).toBeVisible();
  } finally {
    await page.close();
    await borrowed.restore(); unregister();
    await poll(()=>api.api.modules(),value=>value.modules[fixture.id]?.enabled === false && ['Disabled','Suspended'].includes(value.modules[fixture.id]?.status?.phase ?? ''),
      {timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});
    requireSafe(JSON.stringify(await api.api.gpuSharing()) === sharing,'CLEANUP');
  }
  const disabled=await live.context.newPage();try{await disabled.goto(live.config.dashboardUrl+'/#/services');await expect(disabled.locator('section.panel').filter({hasText:fixture.id}).getByRole('button',{name:'Enable',exact:true}).first()).toBeVisible();}finally{await disabled.close();}
  return new Set(['MOD-03','MOD-04']);
}

/** Test the real generic profile write that originally discarded gpuSharing.
 * The alternative is explicit; no kernel/host operation or validation is run.
 * Only an idle managed AMD intent is borrowed, then restored exactly. */
export async function moduleProfileWorkflow(live:LiveFoundation) {
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
  const original=await read(),parameters=original.spec?.parameters as Record<string,string>;
  requireSafe(original.metadata.uid && original.metadata.generation && original.spec?.enabled === true && parameters?.gpuSharing &&
    !parameters.validationRequest,'PREREQUISITE');
  const payload=gpuCompatibilityParameters(plan.profileId,compatibility.profiles,plan.allowExperimental);
  const expected={...original.spec,parameters:{...parameters,...payload}};
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'borrowed-amd-profile.json');
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
    }
  }
}
