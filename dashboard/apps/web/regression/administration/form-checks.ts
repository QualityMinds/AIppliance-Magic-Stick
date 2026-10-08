import {expect,type Page,type Locator} from '@playwright/test';
import {requireSafe} from '../core/errors.ts';

/** Move a native range through keyboard input. fill() can leave a React range
 * value tracker and a clamped draft out of sync; do not inject DOM events. */
export async function selectRange(slider:Locator,value:number) {
  const min=Number(await slider.getAttribute('min')),max=Number(await slider.getAttribute('max'));
  const step=Number(await slider.getAttribute('step'));
  const low=(value-min)/step,high=(max-value)/step;
  requireSafe([min,max,step,value].every(Number.isFinite) && step > 0 && value >= min && value <= max &&
    Number.isInteger(low) && Number.isInteger(high) && Math.min(low,high) <= 256,'CONFIG');
  const fromLow=low <= high;
  await slider.press(fromLow ? 'Home' : 'End');
  for(let index=0;index<(fromLow ? low : high);index++)await slider.press(fromLow ? 'ArrowRight' : 'ArrowLeft');
  await expect(slider).toHaveValue(String(value));
}

/** Exercise drafts in the actual UI. No request permit is granted and the
 * final confirmation is never clicked, even when it becomes enabled. */
export async function gpuMemoryDraft(page:Page,nodeName:string) {
  const node=page.getByRole('article',{name:`GPU node ${nodeName}`,exact:true});
  await expect(node).toBeVisible();
  const amd=node.locator('.gpu-configuration').filter({hasText:'GPU Configuration AMD'});
  requireSafe(await amd.count() === 1,'PREREQUISITE');
  const details=amd.locator(':scope > details');
  await expect(details).not.toHaveAttribute('open');
  await details.locator(':scope > summary').click();
  const memory=amd.locator('summary').filter({has:page.locator('strong').filter({hasText:/^Shared GPU memory$/})}).locator('..');
  await expect(memory).not.toHaveAttribute('open'); await memory.locator(':scope > summary').click();
  const dynamic=memory.getByRole('slider',{name:'Dynamic GPU memory limit',exact:true});
  const fixed=memory.getByRole('slider',{name:'Fixed GPU reservation (firmware)',exact:true});
  const review=memory.getByRole('button',{name:'Review memory configuration',exact:true});
  await expect(dynamic).toBeEnabled(); await expect(fixed).toBeEnabled();
  const current=Number(await dynamic.inputValue()),step=Number(await dynamic.getAttribute('step'));
  const min=Number(await dynamic.getAttribute('min')),max=Number(await dynamic.getAttribute('max'));
  requireSafe([current,step,min,max].every(Number.isFinite) && step > 0 && max > min,'PREREQUISITE');
  // A non-step-aligned current limit may intentionally offer a corrective
  // draft. Do not falsely require disabled Review in that case.
  const originallyEnabled=await review.isEnabled();
  const next=current-step >= min ? current-step : current+step;
  requireSafe(next >= min && next <= max,'PREREQUISITE');
  const originalReview=()=>originallyEnabled ? expect(review).toBeEnabled() : expect(review).toBeDisabled();
  await selectRange(dynamic,next); await expect(review).toBeEnabled();
  await selectRange(dynamic,current); await originalReview();
  const reservation=await fixed.inputValue(),other=reservation === '0' ? '1' : '0';
  requireSafe(Number(await fixed.getAttribute('max')) >= Number(other),'PREREQUISITE');
  await selectRange(fixed,Number(other)); await expect(review).toBeEnabled();
  // Increasing the reservation legitimately clamps the dynamic draft. Restore
  // both values, not just the reservation, before asserting unchanged state.
  await selectRange(fixed,Number(reservation)); await selectRange(dynamic,current); await originalReview();
  await selectRange(dynamic,next); await review.click();
  const dialog=page.getByRole('dialog',{name:'Configure GPU shared memory',exact:true});
  const confirm=dialog.getByRole('button',{name:'Apply memory configuration',exact:true});
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${nodeName} to confirm`,{exact:true}).fill(nodeName+'-wrong');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Type ${nodeName} to confirm`,{exact:true}).fill(nodeName);
  await expect(confirm).toBeEnabled();
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await review.click(); await expect(page.getByRole('dialog').getByLabel(`Type ${nodeName} to confirm`,{exact:true})).toHaveValue('');
  await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
}

export async function changedReverted(input:Locator,button:Locator,value:string) {
  const original=await input.inputValue();
  await expect(button).toBeDisabled();
  await input.fill(value); await expect(input).toHaveValue(value); await expect(button).toBeEnabled();
  await input.fill(original); await expect(button).toBeDisabled();
}

export async function settingsDrafts(page:Page,origin:string,nodeName:string,{domains=true,mesh=true}={}) {
  // These are real controls and product polling. No fetch mock or write permit
  // is used by the live caller; fixtures call the same browser interactions.
  await page.goto(origin+'/#/system/settings/network');
  const ethernet=page.getByRole('article').filter({hasText:'Ethernet'}).first();
  await ethernet.getByRole('button',{name:'Configure',exact:true}).click();
  const metric=ethernet.getByLabel('Route metric',{exact:true}),oldMetric=await metric.inputValue();
  await metric.fill(oldMetric === '101' ? '102' : '101');
  await page.getByRole('button',{name:'Refresh network',exact:true}).click();
  await expect(metric).toHaveValue(oldMetric === '101' ? '102' : '101');
  await metric.fill(oldMetric);await ethernet.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto(origin+'/#/system/settings/updates');
  const updates=page.getByRole('combobox',{name:'Automatic updates',exact:true}),saved=await updates.inputValue();
  const saveUpdates=page.getByRole('button',{name:'Save update settings',exact:true});
  await expect(saveUpdates).toBeDisabled();await updates.selectOption(saved === 'security' ? 'all' : 'security');
  await expect(saveUpdates).toBeEnabled();await updates.selectOption(saved);await expect(saveUpdates).toBeDisabled();
  await page.getByRole('combobox',{name:'Software channel',exact:true}).selectOption('commit');
  const commit=page.getByLabel('Full commit',{exact:true});await commit.fill('bad');
  await expect(page.getByRole('button',{name:'Check channel',exact:true})).toBeDisabled();
  await commit.fill('a'.repeat(40));await expect(page.getByRole('button',{name:'Check channel',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Apply channel',exact:true})).toBeDisabled();
  await page.goto(origin+'/#/system/hardware');await gpuMemoryDraft(page,nodeName);
  const node=page.getByRole('article',{name:`GPU node ${nodeName}`,exact:true});
  for(const provider of ['AMD','NVIDIA']) {
    const region=node.locator('.gpu-configuration').filter({hasText:`GPU Configuration ${provider}`});
    requireSafe(await region.count() === 1,'PREREQUISITE');
    const root=region.locator(':scope > details'),summary=root.locator(':scope > summary');
    if(await root.getAttribute('open') === null)await summary.click();
    const sharing=region.locator('details.gpu-sharing');
    if(await sharing.count() && await sharing.getAttribute('open') === null)await sharing.locator(':scope > summary').click();
    const mode=region.getByRole('combobox',{name:`${provider} allocation mode`,exact:true}),saved=await mode.inputValue();
    const apply=region.getByRole('button',{name:`Apply ${provider} sharing`,exact:true});
    const alternative=saved === 'shared' ? 'exclusive' : 'shared';
    requireSafe(!await mode.getByRole('option',{name:alternative === 'shared' ? 'Shared · multiple models' : 'Exclusive · one model per GPU',exact:true}).isDisabled(),'PREREQUISITE');
    await expect(apply).toBeDisabled();await mode.selectOption(alternative);
    await expect(apply).toBeEnabled();await mode.selectOption(saved);await expect(apply).toBeDisabled();
    await summary.click();await expect(root).not.toHaveAttribute('open');
  }
  if(mesh) {
    await page.goto(origin+'/#/mesh');await page.getByRole('tab',{name:'Network',exact:true}).click();
    const relay=page.getByRole('combobox',{name:'Relay mode',exact:true}),saved=await relay.inputValue(),save=page.getByRole('button',{name:'Save network',exact:true});
    await expect(save).toBeDisabled();await relay.selectOption(saved === 'public' ? 'auto' : 'public');
    await expect(save).toBeEnabled();await relay.selectOption(saved);await expect(save).toBeDisabled();
  }
  if(domains) {
    await page.goto(origin+'/#/system/settings');
    await changedReverted(page.getByLabel('Public Domain',{exact:true}),page.getByRole('button',{name:'Save Domains',exact:true}),'regression.example.invalid');
  }
}
