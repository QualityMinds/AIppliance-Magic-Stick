import {expect} from '@playwright/test';
import {join} from 'node:path';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {readPrivate} from '../core/private-files.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {BorrowedSharing} from '../core/borrowed-sharing.ts';
import {sharingAdapter,podSpec} from '../core/gpu-scenario.ts';
import {canonical} from '../core/borrowed-sharing.ts';
import {poll} from '../core/poll.ts';
import {randomBytes} from 'node:crypto';

export async function cacheProtection(live:LiveFoundation) {
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
  const model=await live.createModel('cache-protection');await live.waitReady(model.client,model.uid,model.generation);
  try {
    const host=(await api.api.hostManagement()).nodes.find(item=>item.available && item.modelCache?.supported);
    requireSafe(host?.modelCache?.id,'PREREQUISITE');requireSafe(host.modelCache.blocked,'API');
    const request={action:'clear-model-cache' as const,nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,
      planId:host.modelCache.id,requestId:randomBytes(16).toString('hex'),confirmation:host.name,acknowledgeDisruption:true,
      allowExperimental:false,experimentMode:false};
    const before=canonical((await live.modelState(model.client,model.uid)).observed?.spec);
    let rejected=false;try{await api.write({method:'POST',path:'/api/host-management/operations',body:request},()=>api.api.requestHostOperation(request));}
    catch(error){rejected=error instanceof AdministrationRejected && [400,409,422].includes(error.status);}
    requireSafe(rejected && canonical((await live.modelState(model.client,model.uid)).observed?.spec) === before,'API');
    const page=await live.context.newPage();try{await page.goto(live.config.dashboardUrl+'/#/system/model-cache');
      await expect(page.getByRole('button',{name:'Clear model cache',exact:true}).first()).toBeDisabled();}
    finally{await page.close();}
  }finally{await live.cleanup(live.journal,{kind:'model',name:model.client.name});}
}
export async function freeTokenCache(live:LiveFoundation) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!));
  requireSafe(profile.cache?.approveFreeToken === true && live.config.gpu,'PREREQUISITE');
  const sharing=await BorrowedSharing.create(join(process.env.REGRESSION_RUN_DIR!,'cache-sharing.json'),{
    runId:live.journal.runId,targetUid:live.config.expected.applianceUid,nodeName:live.config.gpu.nodeName,nodeUid:live.config.gpu.nodeUid},sharingAdapter(live),live.guard);
  await sharing.borrow('nvidia');
  let name:string|undefined;
  try {
    await sharing.change('nvidia','exclusive',2);
    const created=await live.createModel('cache-freetoken',live.journal,live.config.gpu.models.freetoken);name=created.client.name;
    const ready=await live.waitReady(created.client,created.uid,created.generation);
    requireSafe(ready.pods.length === 1,'API');
    const volumes=ready.pods[0]!.spec?.volumes as Array<{name:string;emptyDir?:unknown;hostPath?:unknown}>;
    requireSafe(volumes.some(volume=>volume.name === 'runtime-cache' && Object.hasOwn(volume,'emptyDir')) &&
      !volumes.some(volume=>volume.name === 'runtime-cache' && volume.hostPath),'API');
    const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard);
    const host=(await api.api.hostManagement()).nodes.find(item=>item.nodeUid === live.config.gpu!.nodeUid);
    requireSafe(host?.modelCache?.blocked && podSpec(ready.pods[0]!).nodeName === host.name,'API');
    const stopped=await created.client.stop(ready.item!);await live.journal.modelGeneration(name,created.uid,created.generation,stopped.generation);
    await poll(()=>live.modelState(created.client,created.uid),value=>value.pods.length === 0 && value.item?.spec?.enabled === false,
      {timeoutMs:300_000,intervalMs:1000,stage:'model-stopped'});
    const inventory=(await api.api.hostManagement()).nodes.find(item=>item.nodeUid === host.nodeUid)?.modelCache;
    requireSafe(inventory && !inventory.caches.some(cache=>String(cache.id).includes(name!)),'API');
  }finally{if(name)await live.cleanup(live.journal,{kind:'model',name});await sharing.restore();}
}
