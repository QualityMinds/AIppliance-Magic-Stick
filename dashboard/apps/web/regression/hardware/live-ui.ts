import {expect,type Page} from '@playwright/test';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {GpuScenario,type GpuCreated} from '../core/gpu-scenario.ts';
import {activation,editRevision} from '../core/owned-model.ts';
import {requireSafe} from '../core/errors.ts';

export function modelCard(page:Page,name:string) {
  return page.locator('.panel').filter({has:page.getByRole('heading',{name,exact:true})}).last();
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
  const before = activation(await model.client.models(),model.client.name);
  requireSafe(before?.metadata?.uid === model.uid && before.metadata.generation === model.generation,'OWNERSHIP');
  const body = {expectedRevision:editRevision(before)};
  scenario.allowed.splice(0,scenario.allowed.length,{method:'POST',path:`/api/models/${model.client.name}/${action}`,body});
  await scenario.openModels(page);
  const response = page.waitForResponse(r=>new URL(r.url()).pathname === `/api/models/${model.client.name}/${action}` && r.request().method() === 'POST');
  await page.getByRole('button',{name:`${action[0]!.toUpperCase()+action.slice(1)} ${model.client.name}`,exact:true}).click();
  const http = await response; requireSafe(http.status() === 200,'API');
  const after = (await http.json() as {activation?:ModelActivation}).activation;
  requireSafe(after?.metadata?.uid === model.uid && Number(after.metadata.generation) > model.generation,'API');
  await scenario.live.journal.modelGeneration(model.client.name,model.uid,model.generation,Number(after.metadata.generation));
  model.generation = Number(after.metadata.generation); scenario.allowed.length = 0;
  if (action !== 'stop') {await scenario.ready(model); return;}
  await scenario.waitStopped(model);
}
