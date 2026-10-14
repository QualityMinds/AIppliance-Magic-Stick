import {expect,type Page,type Locator} from '@playwright/test';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {canonical} from './borrowed-sharing.ts';
import {HarnessError,requireSafe} from './errors.ts';
import {parseMemoryMi} from '../../../../packages/core/src/local-model-configuration.ts';

export function modelCard(page:Page,name:string) {
  return page.locator('.panel').filter({has:page.getByRole('heading',{name,exact:true})}).last();
}

/** The Models view polls every 15 seconds, independently of API/Pod readiness.
 * Wait before submitting a mutation, rather than timing out an already sent
 * write while the Stop -> Stopping -> Start state catches up. */
export async function modelActionButton(page:Page,name:string,action:'start'|'stop'|'restart',timeoutMs=60_000) {
  const button=page.getByRole('button',{name:`${action[0]!.toUpperCase()+action.slice(1)} ${name}`,exact:true});
  try {await expect(button).toBeEnabled({timeout:timeoutMs});}
  catch {throw new HarnessError('DEADLINE','Failed',action==='stop'?'model-stopped':'model-ready');}
  return button;
}

/** Only the exact acknowledged lifecycle change is journalable. Never adopt a
 * newer generation by name or loosen the cleanup generation precondition. */
export function modelLifecycleReceipt(before:ModelActivation,value:unknown,action:'start'|'stop'|'restart') {
  const after=(value as {activation?:ModelActivation}|null)?.activation;
  const expected=structuredClone(before.spec);
  requireSafe(expected && before.metadata?.uid && before.metadata.name && Number.isSafeInteger(before.metadata.generation),'OWNERSHIP');
  expected.enabled=action!=='stop';
  if(action==='restart') {
    const nonce=after?.spec?.local?.realtime?.restartNonce;
    requireSafe(expected.local?.realtime && typeof nonce==='string' && /^[a-f0-9]{32}$/.test(nonce) &&
      nonce!==expected.local.realtime.restartNonce,'API');
    expected.local.realtime.restartNonce=nonce;
  }
  requireSafe(after?.metadata?.uid===before.metadata.uid && after.metadata.name===before.metadata.name &&
    after.metadata.namespace===before.metadata.namespace && after.metadata.generation===Number(before.metadata.generation)+1 &&
    canonical(after.spec)===canonical(expected),'API');
  return {uid:before.metadata.uid,generation:Number(after.metadata.generation)};
}

/** Stored budgets are per card, while split Edit displays their group total.
 * Do not derive the expectation from a stale/pre-normalisation fixture or from
 * current telemetry; replica budgets remain per complete copy. */
export function savedGpuBudget(item:ModelActivation,uid:string,generation:number) {
  const local=item.spec?.local,devices=local?.gpuDevices;
  requireSafe(item.metadata?.uid===uid && item.metadata.generation===generation && local?.computeTarget==='nvidia-gpu' &&
    Array.isArray(devices) && devices.length>=2 && devices.length<=16 &&
    new Set(devices.map(d=>d.uuid)).size===devices.length,'OWNERSHIP');
  const perCard=parseMemoryMi(local.vramMi??local.vram);
  requireSafe(perCard>0 && (local.gpuDeployment==='split'||local.gpuDeployment==='replicated'),'API');
  return {perCardMi:perCard,totalMi:perCard*devices.length,
    displayedMi:perCard*(local.gpuDeployment==='replicated'?1:devices.length),
    label:local.gpuDeployment==='replicated'?'VRAM budget (MiB)':'Total VRAM budget (MiB)'};
}

export async function gpuBudgetInput(dialog:Locator,budget:{label:string;displayedMi:number},timeoutMs=60_000) {
  const input=dialog.getByLabel(budget.label,{exact:true});
  try {await expect(input).toBeVisible({timeout:timeoutMs});}
  catch {throw new HarnessError('DEADLINE','Failed','model-estimate');}
  await expect(input).toHaveValue(String(budget.displayedMi));
  return input;
}

export function gpuSlotCapacity(physicalCount:number,mode:'exclusive'|'shared',maxModels:number) {
  requireSafe(Number.isSafeInteger(physicalCount) && physicalCount>0 && physicalCount<=64 &&
    Number.isSafeInteger(maxModels) && maxModels>0 && maxModels<=64,'CAPABILITY');
  return physicalCount*(mode==='exclusive'?1:maxModels);
}

/** Leave the same two exercise slots on larger device-plugin node pools.
 * Additional small owned intents reserve the remainder; no foreign workload
 * or fabricated reduction of advertised capacity is used. */
export function slotFillCount(total:number) {
  requireSafe(Number.isSafeInteger(total) && total>=2 && total<=32,'CAPABILITY');
  return total-2;
}
