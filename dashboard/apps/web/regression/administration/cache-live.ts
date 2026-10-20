import {expect} from '@playwright/test';
import type {LiveFoundation} from '../core/live-foundation.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {canonical} from '../core/borrowed-sharing.ts';
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
