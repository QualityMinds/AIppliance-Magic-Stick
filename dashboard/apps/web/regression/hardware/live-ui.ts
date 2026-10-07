import {expect,type Page} from '@playwright/test';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import type {GpuModelFixture} from '../core/config.ts';
import {GpuScenario,type GpuCreated} from '../core/gpu-scenario.ts';
import {OwnedModelClient,activation,editRevision} from '../core/owned-model.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {requireSafe} from '../core/errors.ts';
import {freeTokenNodeCapacity} from '../core/freetoken-inventory.ts';

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

export async function freeTokenForm(scenario:GpuScenario,page:Page,fixture:GpuModelFixture) {
  await scenario.openModels(page); await page.getByRole('button',{name:'Create',exact:true}).click();
  const dialog = page.getByRole('dialog',{name:'Create Model'});
  await dialog.getByLabel('Inference Engine').selectOption('FreeToken');
  await dialog.getByLabel('Hardware').selectOption('nvidia-gpu');
  await dialog.getByLabel('Model source').selectOption('direct');
  await dialog.getByLabel('Hugging Face model reference').fill(fixture.url);
  await expect(dialog.getByLabel('Memory strategy')).toHaveValue('auto');
  await expect(dialog.getByLabel('KV Cache')).toHaveCount(0);
  await expect(dialog.getByLabel('FreeToken GPU count')).toHaveValue('1');
  const advanced = dialog.locator('details').filter({has:page.getByText('Advanced Settings',{exact:true})});
  await expect(advanced).not.toHaveAttribute('open','');
  const models = await scenario.live.api.models();
  const capacity=freeTokenNodeCapacity(models,scenario.config.gpu!.nodeName),{capability,device}=capacity;
  requireSafe(device.id === fixture.freetoken!.gpuDevice && capacity.maxGpuCount === 1 &&
    capacity.gpuAvailableMi > 0 && capacity.systemAvailableMi > 0,'CAPABILITY');
  const gpu = dialog.getByRole('slider',{name:'FreeToken GPU memory'}),ram = dialog.getByRole('slider',{name:'FreeToken system RAM'});
  const gpuMax = Number(await gpu.getAttribute('max')),ramMax = Number(await ram.getAttribute('max'));
  requireSafe(gpuMax > 0 && gpuMax <= capacity.gpuAvailableMi && ramMax > 0 && ramMax <= capacity.systemAvailableMi,'CAPABILITY');
  await dialog.getByLabel('GPU memory limit total (MiB)').fill(String(gpuMax+1));
  await expect(dialog.getByLabel('GPU memory limit total (MiB)')).toHaveValue(String(gpuMax));
  await dialog.getByLabel('GPU memory limit total (MiB)').fill(String(fixture.freetoken!.gpuMemoryMi));
  await dialog.getByLabel('System RAM reservation (MiB)').fill(String(ramMax+1));
  await expect(dialog.getByLabel('System RAM reservation (MiB)')).toHaveValue(String(ramMax));
  await dialog.getByLabel('System RAM reservation (MiB)').fill(String(fixture.freetoken!.systemMemoryMi));
  await advanced.locator('summary').click();
  await dialog.getByLabel('Context length').fill(String(fixture.contextWindow));
  await dialog.getByLabel('Maximum running requests').fill('1');
  if (fixture.freetoken!.advanced.cacheType) {
    requireSafe(capability.advanced?.cacheType?.includes(fixture.freetoken!.advanced.cacheType),'CAPABILITY');
    await dialog.getByLabel('Cache type').selectOption(fixture.freetoken!.advanced.cacheType);
  }
  return dialog;
}

export async function createFreeTokenUi(scenario:GpuScenario,page:Page,fixture:GpuModelFixture):Promise<GpuCreated> {
  const label = 'freetoken',name = scenario.live.journal.prefix+label;
  requireSafe(!(await scenario.live.cleaner.find(name)),'OWNERSHIP');
  const client = new OwnedModelClient(scenario.live.context.request,scenario.config.dashboardUrl,scenario.config.requestTimeoutMs,
    name,fixture,scenario.live.journal.prefix,scenario.live.guard);
  const dialog = await freeTokenForm(scenario,page,fixture); await dialog.getByLabel('Name').fill(name);
  const body = client.payload();
  scenario.allowed.splice(0,scenario.allowed.length,{method:'POST',path:'/api/models/local',body});
  await scenario.live.guard(); await scenario.live.journal.requested('model',name);
  const response = page.waitForResponse(r=>new URL(r.url()).pathname === '/api/models/local' && r.request().method() === 'POST');
  await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeEnabled(); await dialog.getByRole('button',{name:'Add Local Model'}).click();
  const http = await response;
  // An accepted response is not ownership. Resolve exact UID/generation before
  // teardown can delete anything; an ambiguous create remains requested.
  const observed = await scenario.live.cleaner.find(name);
  if (!observed && [400,401,403,404,409,422].includes(http.status())) await scenario.live.journal.rejected('model',name);
  requireSafe(http.status() === 200 && observed?.metadata.uid && observed.metadata.generation &&
    canonical((observed.spec?.local as {freetoken?:unknown}|undefined)?.freetoken) === canonical(fixture.freetoken),'API');
  await scenario.live.journal.owned('model',name,observed.metadata.uid,observed.metadata.generation);
  client.adopt(observed.metadata.uid); scenario.allowed.length = 0;
  return {client,fixture,uid:observed.metadata.uid,generation:observed.metadata.generation};
}
