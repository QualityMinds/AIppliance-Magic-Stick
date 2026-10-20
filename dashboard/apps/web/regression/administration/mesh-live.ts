import {expect,type Browser} from '@playwright/test';
import {join} from 'node:path';
import type {MeshStatus,MeshShare} from '@magicstick/dashboard-contracts';
import type {LiveFoundation as Foundation} from '../core/live-foundation.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {loadLabConfig} from '../core/config.ts';
import {ResourceJournal,newRunId} from '../core/journal.ts';
import {AdministrationApi,AdministrationRejected} from '../core/administration-api.ts';
import {privateDirectory,readPrivate,writePrivate} from '../core/private-files.ts';
import {InferenceProbe} from '../core/inference.ts';
import {openInferenceSession} from '../core/auth.ts';
import {poll} from '../core/poll.ts';
import {requireProof as requireSafe} from '../core/errors.ts';
import {BorrowedSharing,canonical} from '../core/borrowed-sharing.ts';
import {sharingAdapter} from '../core/gpu-scenario.ts';
import {permittedUiAction} from './ui-actions.ts';

export const stableMesh=(status:MeshStatus)=>JSON.stringify({installed:status.installed,configured:status.configured,authority:status.authority,
  mesh:status.mesh,node:status.node,shares:status.shares,relay:status.relay});
/** Two independently pinned, locked appliances. A peer profile cannot point
 * back to the first appliance and membership is never borrowed or overwritten. */
export async function meshWorkflow(live:Foundation,browser:Browser) {
  const profile=JSON.parse(await readPrivate(process.env.REGRESSION_REMAINING_PROFILE!)),fixture=profile.mesh;
  requireSafe(fixture?.approveTwoAppliances === true && fixture.approveGpuTransitions === true && fixture.peerConfig && /^https:\/\//.test(fixture.enrollmentOrigin) && live.config.gpu && live.config.inferenceUrl,'PREREQUISITE');
  const peerConfig=await loadLabConfig(fixture.peerConfig);
  requireSafe(peerConfig.expected.applianceUid !== live.config.expected.applianceUid && peerConfig.dashboardUrl !== live.config.dashboardUrl && peerConfig.inferenceUrl &&
    peerConfig.caFile === live.config.caFile,'IDENTITY');
  const runId=newRunId(),directory=join(process.env.REGRESSION_RUN_DIR!,'peer');await privateDirectory(directory);
  const journal=await ResourceJournal.create(join(directory,'journal.json'),runId,peerConfig.expected.applianceUid);
  const peer=await LiveFoundation.open(browser,peerConfig,journal,{inferenceOrigin:peerConfig.inferenceUrl});
  const api=new AdministrationApi(live.context.request,live.config.dashboardUrl,live.config.requestTimeoutMs,live.guard),remote=new AdministrationApi(peer.context.request,peerConfig.dashboardUrl,peerConfig.requestTimeoutMs,peer.guard);
  const command=async(client:AdministrationApi,action:Parameters<typeof client.api.meshCommand>[0],body:object={})=>client.write({method:'POST',path:'/api/mesh/'+action,body},()=>client.api.meshCommand(action,body));
  const receipt=join(process.env.REGRESSION_RUN_DIR!,'mesh-membership.json'),nodeName=live.journal.prefix+'owner';let meshId:string|undefined,sharing:BorrowedSharing|undefined;
  try {
    const initial=await api.api.mesh(),peerInitial=await remote.api.mesh();requireSafe(initial.installed && peerInitial.installed && !initial.configured && !peerInitial.configured,'PREREQUISITE');
    await writePrivate(receipt,{version:1,ownerUid:live.config.expected.applianceUid,peerUid:peerConfig.expected.applianceUid,state:'requested'},true);
    await openInferenceSession(live.context,live.config.inferenceUrl,live.config.loginTimeoutMs);await openInferenceSession(peer.context,peerConfig.inferenceUrl!,peerConfig.loginTimeoutMs);
    sharing=await BorrowedSharing.create(join(process.env.REGRESSION_RUN_DIR!,'mesh-sharing.json'),{
      runId:live.journal.runId,targetUid:live.config.expected.applianceUid,nodeName:live.config.gpu.nodeName,nodeUid:live.config.gpu.nodeUid},sharingAdapter(live),live.guard);
    await sharing.borrow('nvidia');await sharing.change('nvidia','exclusive',2);
    await command(api,'create',{meshName:live.journal.prefix+'mesh',nodeName,origin:fixture.enrollmentOrigin,relay:{mode:'auto',url:''},shares:[]});
    const owner=await api.api.mesh();requireSafe(owner.configured && owner.authority === true && owner.mesh?.id && owner.node?.name === nodeName && !Object.values(owner.shares ?? {}).some(item=>item.enabled),'API');meshId=owner.mesh.id;
    await writePrivate(receipt,{version:1,meshId,ownerUid:live.config.expected.applianceUid,peerUid:peerConfig.expected.applianceUid,state:'owned'});
    const page=await live.context.newPage();
    try {
      await page.goto(live.config.dashboardUrl+'/#/mesh');await page.getByRole('button',{name:'Join Mesh',exact:true}).click();
      await expect(page.getByRole('dialog')).toContainText('Leave');await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();
      requireSafe((await api.api.mesh()).mesh?.id === meshId,'API');
    }finally{await page.close();}
    const revoked=await command(api,'invite',{type:'magic-stick',lifetime:60}) as {id:string;token:string};requireSafe(revoked.id && revoked.token,'API');
    await command(api,'revoke-invite',{id:revoked.id});
    let denied=false;try{await command(remote,'join',{token:revoked.token,nodeName:journal.prefix+'peer'});}catch(error){denied=error instanceof AdministrationRejected && [400,403,409].includes(error.status);}
    requireSafe(denied && !(await remote.api.mesh()).configured,'API');
    const invitePage=await live.context.newPage();let invited:{id:string;token:string};
    try {
      await invitePage.goto(live.config.dashboardUrl+'/#/mesh');await invitePage.getByRole('tab',{name:'Invitations',exact:true}).click();
      await invitePage.getByRole('combobox',{name:'Node type',exact:true}).selectOption('magic-stick');await invitePage.getByRole('combobox',{name:'Expires in',exact:true}).selectOption('900');
      invited=await permittedUiAction(invitePage,live.config.dashboardUrl,'/api/mesh/invite','POST',{type:'magic-stick',lifetime:900},live.guard,
        ()=>invitePage.getByRole('button',{name:'Create invite',exact:true}).click());
      requireSafe(invited.id && invited.token && !JSON.stringify(await api.api.mesh()).includes(invited.token),'API');
      await expect(invitePage.getByLabel('One-time invite token',{exact:true})).toHaveValue(invited.token);
      await invitePage.getByRole('button',{name:'Done',exact:true}).click();
      requireSafe(!await invitePage.getByLabel('One-time invite token',{exact:true}).count() &&
        !(await invitePage.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).includes(invited.token),'API');
      // Dirty/reverted network controls and one real, disposable relay update.
      await invitePage.getByRole('tab',{name:'Network',exact:true}).click();
      const relay=invitePage.getByRole('combobox',{name:'Relay mode',exact:true}),save=invitePage.getByRole('button',{name:'Save network',exact:true});
      await expect(save).toBeDisabled();await relay.selectOption('public');await expect(save).toBeEnabled();await relay.selectOption('auto');await expect(save).toBeDisabled();
      await relay.selectOption('public');await permittedUiAction(invitePage,live.config.dashboardUrl,'/api/mesh/relay','POST',{mode:'public',url:''},live.guard,()=>save.click());
      requireSafe((await api.api.mesh()).relay?.mode === 'public','API');
      await command(api,'relay',{mode:'auto',url:''});
    }finally{await invitePage.close();}
    const joinPage=await peer.context.newPage();
    try {
      await joinPage.goto(peerConfig.dashboardUrl+'/#/mesh');await joinPage.getByRole('button',{name:'Join Mesh',exact:true}).click();
      await joinPage.getByRole('dialog').getByLabel('Node name',{exact:true}).fill(journal.prefix+'peer');
      await joinPage.getByRole('dialog').getByLabel('Invite token',{exact:true}).fill(invited.token);
      await permittedUiAction(joinPage,peerConfig.dashboardUrl,'/api/mesh/join','POST',{token:invited.token,nodeName:journal.prefix+'peer'},peer.guard,
        ()=>joinPage.getByRole('dialog').getByRole('button',{name:'Join mesh',exact:true}).click());
      await expect(joinPage.getByRole('dialog')).toHaveCount(0);
      requireSafe(!(await joinPage.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}))).includes(invited.token),'API');
    }finally{await joinPage.close();}
    const joined=await poll(()=>remote.api.mesh(),value=>value.configured && value.membershipValid === true && value.mesh?.id === meshId,{timeoutMs:180_000,intervalMs:1000,stage:'host-readiness'});
    requireSafe(joined.node?.id && joined.node.type === 'magic-stick' && !joined.authority,'API');
    // Reuse is tested only after leaving the owned membership, so a
    // leave-before-join guard cannot be mistaken for token single-use proof.
    await command(remote,'leave');denied=false;
    try{await command(remote,'join',{token:invited.token,nodeName:journal.prefix+'peer'});}catch(error){denied=error instanceof AdministrationRejected && [400,403,409].includes(error.status);}
    requireSafe(denied && !(await remote.api.mesh()).configured,'API');
    const fresh=await command(api,'invite',{type:'magic-stick',lifetime:600}) as {token:string};await command(remote,'join',{token:fresh.token,nodeName:journal.prefix+'peer'});
    const key=await live.createKey('mesh-local'),remoteKey=await peer.createKey('mesh-remote');
    const localProbe=new InferenceProbe(live.context.request,live.config.inferenceUrl,key.secret),remoteProbe=new InferenceProbe(peer.context.request,peerConfig.inferenceUrl!,remoteKey.secret);
    const fixtures=[live.config.smokeModel!,live.config.gpu.models.nvidiaVllm];
    for(let index=0;index<fixtures.length;index++) {
      const model=await live.createModel('mesh-engine-'+index,live.journal,fixtures[index]!);await live.waitReady(model.client,model.uid,model.generation);
      await localProbe.chat(model.client.name,fixtures[index]!.url.split('://')[1]);
      const alias=`mesh/${nodeName}/${model.client.name}`,settings:MeshShare={enabled:true,maxConcurrent:1,rpm:10,tpm:64000,maxContext:256,maxOutput:16,priority:'low'};
      const podIds=(await live.modelState(model.client,model.uid)).pods.map(item=>item.metadata.uid).sort().join(',');
      await command(api,'share',{model:model.client.name,settings});await command(remote,'sync');
      await poll(()=>remoteProbe.advertised(alias),Boolean,{timeoutMs:180_000,intervalMs:1000,stage:'model-ready'});await remoteProbe.chat(alias,fixtures[index]!.url.split('://')[1]);
      requireSafe((await live.modelState(model.client,model.uid)).pods.map(item=>item.metadata.uid).sort().join(',') === podIds &&
        !(await peer.api.models()).activations.some(item=>item.metadata?.name === model.client.name),'API');
      const old=stableMesh(await api.api.mesh()),page=await live.context.newPage();
      try{
        await page.goto(live.config.dashboardUrl+'/#/mesh');await page.getByRole('tab',{name:'Models',exact:true}).click();
        const card=page.locator('details').filter({has:page.locator(':scope > summary strong').filter({hasText:new RegExp('^'+model.client.name+'$')})});
        await expect(card).toBeVisible();await card.locator(':scope > summary').click();requireSafe(stableMesh(await api.api.mesh()) === old,'API');
        const limit=card.getByLabel('Max concurrent requests',{exact:true}),save=card.getByRole('button',{name:'Save sharing',exact:true});
        await expect(save).toBeDisabled();await limit.fill('2');await expect(save).toBeEnabled();await limit.fill('1');await expect(save).toBeDisabled();
        const updated={...settings,maxConcurrent:2};await limit.fill('2');
        await permittedUiAction(page,live.config.dashboardUrl,'/api/mesh/share','POST',{model:model.client.name,settings:updated},live.guard,()=>save.click());
        await poll(()=>api.api.mesh(),value=>canonical(value.shares?.[model.client.name]) === canonical(updated),{timeoutMs:30_000,intervalMs:500,stage:'model-update'});
        await page.getByRole('tab',{name:'Overview',exact:true}).click();
        await permittedUiAction(page,live.config.dashboardUrl,'/api/mesh/sync','POST',{},live.guard,()=>page.getByRole('button',{name:'Sync now',exact:true}).click());
      }finally{await page.close();}
      let forbidden=false;try{await command(remote,'invite',{type:'client',lifetime:60});}catch(error){forbidden=error instanceof AdministrationRejected && error.status === 403;}requireSafe(forbidden,'API');
      await command(api,'unshare',{model:model.client.name});await command(remote,'sync');
      await poll(()=>remoteProbe.advertised(alias),value=>!value,{timeoutMs:180_000,intervalMs:1000,stage:'model-stopped'});await remoteProbe.refusesStopped(alias);await localProbe.chat(model.client.name,fixtures[index]!.url.split('://')[1]);
      await live.cleanup(live.journal,{kind:'model',name:model.client.name});
    }
    const current=await remote.api.mesh();requireSafe(current.node?.id && current.mesh?.id === meshId,'OWNERSHIP');await command(api,'revoke-node',{id:current.node.id});
    await poll(()=>remote.api.mesh(),value=>!value.membershipValid && !value.imports?.length,{timeoutMs:180_000,intervalMs:1000,stage:'cleanup'});
    return new Set(['MESH-03','MESH-04','MESH-05','MESH-06','MESH-07']);
  }finally {
    try {
      if(meshId) {
        const peerState=await remote.api.mesh();if(peerState.configured){requireSafe(peerState.mesh?.id === meshId,'CONFLICT');await command(remote,'leave');}
        const ownerState=await api.api.mesh();if(ownerState.configured){requireSafe(ownerState.mesh?.id === meshId && ownerState.node?.name === nodeName,'CONFLICT');await command(api,'leave');}
        requireSafe(!(await api.api.mesh()).configured && !(await remote.api.mesh()).configured,'CLEANUP');
        await writePrivate(receipt,{version:1,meshId,state:'removed',localModelsPreserved:true});
      }
    }finally{try{await peer.close();}finally{await live.cleanup();await sharing?.restore();}}
  }
}
