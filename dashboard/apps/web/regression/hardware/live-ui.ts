import {expect,type Page} from '@playwright/test';
import {GpuScenario,type GpuCreated} from '../core/gpu-scenario.ts';
import {activation,editRevision} from '../core/owned-model.ts';
import {requireSafe} from '../core/errors.ts';
import {browserMutation} from '../core/browser-action.ts';
import {modelActionButton,modelLifecycleReceipt,modelCard} from '../core/model-ui.ts';
export {modelCard} from '../core/model-ui.ts';
import type {HardwareGpuDevice} from '@magicstick/dashboard-contracts';

/** Several physical cards deliberately share the same vendor heading. Scope
 * the accordion by verified PCI identity, never by the first matching title. */
export async function gpuConfigurationUi(page:Page,device:HardwareGpuDevice) {
  const region=page.getByRole('region',{name:`GPU ${device.name} · ${device.pciAddress}`,exact:true});
  await expect(region).toBeVisible({timeout:60_000});
  const details=region.locator(':scope > details');
  if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();
  return region;
}

export async function installedReadyUi(page:Page,name:string) {
  // Ready is rendered twice (badge and progress caption). The semantic
  // progress target is unique and ModelsPage has a 15-second polling interval.
  await expect(modelCard(page,name).getByRole('progressbar',{name:'Ready: 100%',exact:true})).toBeVisible({timeout:60_000});
}
export async function logsUi(scenario:GpuScenario,page:Page,model:GpuCreated) {
  const logs = await model.client.logs();
  requireSafe(logs.model === model.client.name && logs.tailLines === 300 && logs.pods.some(p=>p.containers.some(c=>c.logs.some(l=>Boolean(l.text)))),'API');
  await scenario.openModels(page); await page.getByRole('button',{name:`View logs for ${model.client.name}`}).click();
  const dialog = page.getByRole('dialog',{name:`Runtime logs · ${model.client.name}`});
  await expect(dialog.locator('pre').first()).not.toBeEmpty();
  await dialog.getByRole('button',{name:'Close dialog'}).click();
}
/** Real browser lifecycle with an exact request fence, durable generation CAS
 * and independent Pod/route observations. No arbitrary model can be targeted. */
export async function lifecycleUi(scenario:GpuScenario,page:Page,model:GpuCreated,action:'stop'|'start'|'restart') {
  await scenario.openModels(page);
  const button=await modelActionButton(page,model.client.name,action);
  const before = activation(await model.client.models(),model.client.name);
  requireSafe(before?.metadata?.uid === model.uid && before.metadata.generation === model.generation,'OWNERSHIP');
  const body = {expectedRevision:editRevision(before)};
  scenario.allowed.splice(0,scenario.allowed.length,{method:'POST',path:`/api/models/${model.client.name}/${action}`,body});
  try {
    await browserMutation(page,{url:scenario.config.dashboardUrl+`/api/models/${model.client.name}/${action}`,body,
      timeoutMs:scenario.config.requestTimeoutMs,guard:scenario.live.guard,stage:action==='stop'?'model-stopped':'model-ready',
      acknowledge:async response=>{
        requireSafe(response.status()===200,'API');
        const after=modelLifecycleReceipt(before,await response.json(),action);
        await scenario.live.journal.modelGeneration(model.client.name,model.uid,model.generation,after.generation);
        model.generation=after.generation;
      }},()=>button.click());
  } finally {scenario.allowed.length=0;}
  if (action !== 'stop') {await scenario.ready(model); return;}
  await scenario.waitStopped(model);
}
