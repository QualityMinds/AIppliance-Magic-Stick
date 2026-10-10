import {expect} from '@playwright/test';
import {join} from 'node:path';
import type {RuntimeModelFixture} from '../core/config.ts';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {readPrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {BorrowedSharing} from '../core/borrowed-sharing.ts';
import {sharingAdapter,podSpec} from '../core/gpu-scenario.ts';
import {realtimeSession} from '../core/realtime-probe.ts';
import {openInferenceSession} from '../core/auth.ts';
import {InferenceProbe} from '../core/inference.ts';
import {poll} from '../core/poll.ts';
import {activation,editRevision,modelContextUpdateReceipt,OwnedModelClient} from '../core/owned-model.ts';
import {browserMutation,MutationNotSubmitted} from '../core/browser-action.ts';
import {selectRange} from './form-checks.ts';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {modelCard} from '../hardware/live-ui.ts';
import {permittedUiAction} from './ui-actions.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';

/** Exercise Create in the actual shared form, retaining exact intent and UID-bound cleanup. */
async function createRealtimeThroughForm(live:LiveFoundation,suffix:string,fixture:RuntimeModelFixture) {
  requireSafe(fixture.realtime && !fixture.realtime.restartNonce,'CONFIG');
  const name=live.journal.prefix+suffix;
  const client=new OwnedModelClient(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,name,fixture,live.journal.prefix,live.guard);
  await live.guard();requireSafe(!await live.cleaner.find(name) && !activation(await client.models(),name),'OWNERSHIP');
  const page=await live.context.newPage();
  try {
    await page.goto(live.config.dashboardUrl+'/#/models');
    await page.getByRole('button',{name:'Create',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create Model'});
    await dialog.getByLabel('Inference Engine').selectOption('VLLM-Omni');
    await dialog.getByLabel('Realtime profile').selectOption(fixture.realtime.profile);
    await dialog.getByLabel('Name',{exact:true}).fill(name);
    await dialog.getByLabel('Model source').selectOption('direct');
    await dialog.getByLabel('Hugging Face URL').fill(fixture.url);
    await dialog.getByLabel('Compute node').selectOption(fixture.realtime.gpuNode);
    await dialog.getByLabel('GPUs',{exact:true}).selectOption(String(fixture.realtime.gpuCount));
    await dialog.getByLabel('Context Size',{exact:true}).fill(String(fixture.contextWindow));
    await dialog.getByLabel('Concurrent sessions').fill('1');
    await dialog.getByLabel('System RAM (MiB)').fill(String(fixture.realtime.systemMemoryMi));
    await selectRange(dialog.getByLabel('GPU memory budget'),fixture.realtime.gpuMemoryFraction);
    await dialog.getByText('Advanced',{exact:true}).click();
    await dialog.getByLabel('Thinker CPU offload (GiB)').fill(String(fixture.realtime.thinkerCpuOffloadGiB));
    if(fixture.realtime.runtimeImage)await dialog.getByLabel('Runtime image (optional)').fill(fixture.realtime.runtimeImage);
    await expect(dialog.getByLabel('CPU reservation (cores)')).toHaveValue('');
    await expect(dialog.getByLabel('CPU limit (cores, 0 = unlimited)')).toHaveValue('');
    await live.journal.requested('model',name);
    let accepted:ModelActivation;
    try {
      const response=await browserMutation(page,{url:live.config.dashboardUrl+'/api/models/local',method:'POST',body:client.payload(),
        timeoutMs:live.config.requestTimeoutMs,guard:live.guard,stage:'model-create'},
        ()=>dialog.getByRole('button',{name:'Add Realtime Model',exact:true}).click());
      try {accepted=await response.json() as ModelActivation;}catch {accepted=await live.cleaner.find(name) as ModelActivation;}
    }catch(error) {
      if(error instanceof MutationNotSubmitted && !await live.cleaner.find(name))await live.journal.rejected('model',name);
      throw error;
    }
    requireSafe(accepted?.metadata?.name === name && accepted.metadata.namespace === live.config.expected.applianceNamespace &&
      accepted.metadata.uid && Number.isSafeInteger(accepted.metadata.generation) && Number(accepted.metadata.generation) > 0,'API');
    const uid=accepted.metadata.uid,generation=Number(accepted.metadata.generation);
    await live.journal.owned('model',name,uid,generation);client.adopt(uid);
    return {client,uid,generation};
  }finally{await page.close();}
}

export async function realtimeWorkflow(live:LiveFoundation) {
  requireSafe(process.env.REGRESSION_REMAINING_PROFILE && live.config.gpu && live.config.inferenceUrl,'PREREQUISITE');
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE));
  const plan=profile.realtime as {approveGpuTransitions?:boolean;fixtures?:Array<{fixture:RuntimeModelFixture;mode:'exclusive'|'shared';maxModels:2}>};
  requireSafe(plan?.approveGpuTransitions === true && plan.fixtures?.length === 2 &&
    plan.fixtures.some(item=>item.mode === 'exclusive') && plan.fixtures.some(item=>item.mode === 'shared'),'PREREQUISITE');
  for(const row of plan.fixtures) requireSafe(['exclusive','shared'].includes(row.mode) && row.maxModels === 2 && row.fixture.engine === 'VLLM' &&
    ['amd-gpu','nvidia-gpu'].includes(row.fixture.computeTarget) && row.fixture.realtime?.gpuNode === live.config.gpu.nodeName &&
    row.fixture.contextWindow >= 256 && row.fixture.contextWindow <= 4096 && row.fixture.maxNumSeqs === 1 &&
    /^hf:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:@[a-f0-9]{40})?$/.test(row.fixture.url),'CONFIG');
  const sharing=await BorrowedSharing.create(join(process.env.REGRESSION_RUN_DIR!,'realtime-sharing.json'),{
    runId:live.journal.runId,targetUid:live.config.expected.applianceUid,nodeName:live.config.gpu.nodeName,nodeUid:live.config.gpu.nodeUid},sharingAdapter(live),live.guard);
  const key=await live.createKey('rt-key');
  await openInferenceSession(live.context,live.config.inferenceUrl,live.config.loginTimeoutMs);
  const ordinary=await live.createModel('rt-control');await live.waitReady(ordinary.client,ordinary.uid,ordinary.generation);
  const inference=new InferenceProbe(live.context.request,live.config.inferenceUrl,key.secret);
  try {
    for(const [index,row] of plan.fixtures.entries()) {
      const provider=row.fixture.computeTarget === 'amd-gpu' ? 'amd' : 'nvidia';
      if(!sharing.entries.some(entry=>entry.provider === provider))await sharing.borrow(provider);
      await sharing.change(provider,row.mode,row.maxModels);
      const models=await poll(()=>live.api.models(),value=>value.computeTargets.realtimeDevices?.some(device=>device.profile === row.fixture.realtime!.profile &&
        device.node === row.fixture.realtime!.gpuNode && device.supported && device.freeGpuCount >= row.fixture.realtime!.gpuCount &&
        (row.mode === 'exclusive' ? !device.allocationMode || device.allocationMode === 'exclusive' : device.allocationMode !== 'exclusive')) === true,
      {timeoutMs:300_000,intervalMs:1500,stage:'gpu-backend'});
      const capability=models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles?.[row.fixture.realtime!.profile];
      requireSafe(capability?.gpuCounts.includes(row.fixture.realtime!.gpuCount) && (row.mode !== 'shared' || row.fixture.realtime!.gpuCount === 1),'CAPABILITY');
      const created=await createRealtimeThroughForm(live,'omni-'+index,row.fixture);
      let ready=await live.waitReady(created.client,created.uid,created.generation);
      requireSafe(ready.pods.length === 1 && podSpec(ready.pods[0]!).nodeName === row.fixture.realtime!.gpuNode &&
        ready.item?.spec?.local?.realtime?.profile === row.fixture.realtime!.profile && ready.item.spec.local.engine === 'VLLM' &&
        !Object.hasOwn(ready.item.spec.local,'freetoken') && !Object.hasOwn(ready.item.spec.local,'cpuOffloading'),'API');
      const page=await live.context.newPage();
      try {
        await page.goto(live.config.dashboardUrl+'/#/models');
        const card=modelCard(page,created.client.name);
        await card.getByRole('button',{name:'Edit '+created.client.name,exact:true}).click();
        await expect(page.getByLabel('Realtime profile')).toHaveValue(row.fixture.realtime!.profile);
        await expect(page.getByLabel('Compute node')).toHaveValue(row.fixture.realtime!.gpuNode);
        await expect(page.getByLabel('KV Cache')).toHaveCount(0);await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
        const context=row.fixture.contextWindow === 256 ? 512 : 256;
        await page.getByRole('dialog').getByLabel('Context Size',{exact:true}).fill(String(context));
        const current=ready.item!,body={expectedRevision:editRevision(current),local:{contextWindow:context}};
        const updated=await permittedUiAction<ModelActivation>(page,live.config.dashboardUrl,'/api/models/'+created.client.name,'PUT',body,live.guard,
          ()=>page.getByRole('button',{name:'Save changes',exact:true}).click());
        const receipt=modelContextUpdateReceipt(current,updated,context);
        await live.journal.modelGeneration(created.client.name,created.uid,created.generation,receipt.generation);created.generation=receipt.generation;
        ready=await live.waitReady(created.client,created.uid,created.generation);
        await page.reload();await modelCard(page,created.client.name).getByRole('button',{name:'Edit '+created.client.name,exact:true}).click();
        await expect(page.getByLabel('Context Size',{exact:true})).toHaveValue(String(context));
        await expect(page.getByRole('button',{name:'Save changes',exact:true})).toBeDisabled();
        await page.getByRole('button',{name:'Cancel',exact:true}).click();
      } finally {await page.close();}
      // One invalid device plan reaches the actual deployed admission API.
      // Keep an ambiguous accepted response journaled; never leave a broken
      // product-created intent behind merely because rejection was expected.
      const admin=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
      const invalidName=live.journal.prefix+'rt-invalid-'+index,base=created.client.payload(),
        payload={...base,name:invalidName,local:{...base.local,realtime:{...row.fixture.realtime!,gpuCount:0}}};
      requireSafe(!activation(await live.api.models(),invalidName),'OWNERSHIP');await live.journal.requested('model',invalidName);
      let refused=false;
      try {
        const accepted=await admin.write({method:'POST',path:'/api/models/local',body:payload},()=>admin.api.createLocalModel(payload)) as ModelActivation;
        requireSafe(accepted.metadata?.uid && accepted.metadata.generation,'API');
        await live.journal.owned('model',invalidName,accepted.metadata.uid,accepted.metadata.generation);
      }catch(error){if(error instanceof AdministrationRejected)refused=[400,409,422].includes(error.status);else throw error;}
      if(refused){requireSafe(!activation(await live.api.models(),invalidName) && !await live.cleaner.find(invalidName),'API');await live.journal.rejected('model',invalidName);}
      requireSafe(refused,'API');
      await realtimeSession(live.config.inferenceUrl,created.client.name,key.secret);
      await realtimeSession(live.config.inferenceUrl,created.client.name,undefined,true);
      const oldPods=new Set(ready.pods.map(pod=>pod.metadata.uid));
      const lifecycle=async(action:'start'|'stop'|'restart')=>{
        const current=activation(await created.client.models(),created.client.name)!;
        requireSafe(current?.metadata?.uid === created.uid && current.metadata.generation === created.generation,'OWNERSHIP');
        const page=await live.context.newPage();
        try {
          await page.goto(live.config.dashboardUrl+'/#/models');
          const result=await permittedUiAction<{activation?:ModelActivation}>(page,live.config.dashboardUrl,`/api/models/${created.client.name}/${action}`,'POST',
            {expectedRevision:editRevision(current)},live.guard,()=>page.getByRole('button',{name:`${action[0]!.toUpperCase()+action.slice(1)} ${created.client.name}`,exact:true}).click());
          requireSafe(result.activation?.metadata?.uid === created.uid && Number(result.activation.metadata.generation) > created.generation &&
            result.activation.spec?.enabled === (action !== 'stop'),'API');
          const generation=Number(result.activation.metadata.generation);
          await live.journal.modelGeneration(created.client.name,created.uid,created.generation,generation);created.generation=generation;
          return {generation};
        }finally{await page.close();}
      };
      const restarted=await lifecycle('restart');
      const replaced=await live.waitReady(created.client,created.uid,restarted.generation);requireSafe(replaced.pods.every(pod=>!oldPods.has(pod.metadata.uid)),'API');
      await realtimeSession(live.config.inferenceUrl,created.client.name,key.secret);
      await lifecycle('stop');
      const idle=await poll(()=>live.modelState(created.client,created.uid),value=>value.item?.spec?.enabled === false && value.pods.length === 0 &&
        !value.models.models?.some(model=>model.id === created.client.name),{timeoutMs:300_000,intervalMs:1000,stage:'model-stopped'});
      await inference.chat(ordinary.client.name,live.config.smokeModel!.url.split('://')[1]);
      requireSafe(idle.item?.metadata?.generation === created.generation,'API');const started=await lifecycle('start');
      await live.waitReady(created.client,created.uid,started.generation);await realtimeSession(live.config.inferenceUrl,created.client.name,key.secret);
      const removal=await live.context.newPage();
      try {
        await removal.goto(live.config.dashboardUrl+'/#/models');
        const guard=async()=>{await live.guard();const current=await live.cleaner.find(created.client.name);
          requireSafe(current?.metadata.uid === created.uid && current.metadata.generation === created.generation,'OWNERSHIP');};
        await modelCard(removal,created.client.name).getByRole('button',{name:'Remove',exact:true}).click();
        await permittedUiAction(removal,live.config.dashboardUrl,'/api/models/'+created.client.name,'DELETE',null,guard,
          ()=>removal.getByRole('dialog',{name:'Remove model',exact:true}).getByRole('button',{name:'Remove',exact:true}).click());
        await poll(()=>live.cleaner.find(created.client.name),value=>!value,{timeoutMs:300_000,intervalMs:1000,stage:'cleanup'});
        await live.cleanup(live.journal,{kind:'model',name:created.client.name});
      }finally{await removal.close();}
      requireSafe(!activation(await live.api.models(),created.client.name),'CLEANUP');
    }
    await live.cleanup(live.journal,{kind:'key',name:live.journal.prefix+'rt-key'});
    // A revoked key must fail at the ordinary public WebSocket boundary, even
    // when another model is Ready. Never use administrator browser cookies.
    await realtimeSession(live.config.inferenceUrl,ordinary.client.name,key.secret,true);
    return new Set(['RT-01','RT-02','RT-03','RT-04','RT-08']);
  } finally {
    for(const entry of live.journal.entries.filter(item=>item.kind === 'model' && item.state !== 'removed'))
      await live.cleanup(live.journal,{kind:'model',name:entry.name});
    await sharing.restore();await live.cleanup();
  }
}
