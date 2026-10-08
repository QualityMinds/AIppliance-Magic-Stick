import {test,expect,type Page} from '@playwright/test';
import type {GpuSharingRequest} from '@magicstick/dashboard-contracts';
import {GpuScenario,type GpuCreated} from '../core/gpu-scenario.ts';
import {ModelCreateRejected,activation} from '../core/owned-model.ts';
import {canonical,type Provider} from '../core/borrowed-sharing.ts';
import {requireSafe} from '../core/errors.ts';
import {poll} from '../core/poll.ts';
import {evidenceAnnotations,type TestLayer} from '../core/evidence.ts';
import {phase4Variants,type GpuVariant} from '../profiles/gpu-p0.ts';
import {requestValidationUi,completedValidation} from './validation-workflow.ts';
import {lifecycleUi} from './live-ui.ts';

function proof(keys:GpuVariant[],layers:TestLayer[]=['A','E','O']) {
  return evidenceAnnotations(...keys.flatMap(variant=>layers.filter(layer=>(phase4Variants[variant as keyof typeof phase4Variants].layers as readonly TestLayer[]).includes(layer))
    .map(layer=>({id:phase4Variants[variant as keyof typeof phase4Variants].id,variant,layer}))));
}
test.describe('Installed AMD DRA and NVIDIA time-slicing',()=>{
  let s:GpuScenario|undefined;let page:Page;
  test.beforeAll(async ({browser},info)=>{
    s=await GpuScenario.open(browser,info.workerIndex);page=await s.live.context.newPage();
    if(process.env.REGRESSION_GPU_CASE === 'remaining') {
      for(const provider of ['amd','nvidia'] as const)if(s.config.gpu!.devices[provider])await s.transition(provider,'shared',2);
    }
  });
  test.afterAll(async ()=>{if(s) await s.close();});
  async function module(provider:Provider) {return s!.live.observer.get('moduleactivations.appliance.magicstick.dev',s!.config.expected.applianceNamespace,provider === 'amd' ? 'amd-gpu' : 'gpu');}
  async function rejectedSharing(body:GpuSharingRequest) {
    const before=await module(body.provider);await s!.live.guard();
    const response=await s!.live.context.request.post(s!.config.dashboardUrl+'/api/hardware/gpu-sharing',{data:body,
      headers:{Origin:s!.config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'},maxRedirects:0,timeout:s!.config.requestTimeoutMs});
    requireSafe([400,409,422].includes(response.status()),'API');
    const after=await module(body.provider);
    requireSafe(after.metadata.uid === before.metadata.uid && after.metadata.generation === before.metadata.generation && canonical(after.spec) === canonical(before.spec),'CONFLICT');
  }
  function fixtures(provider:Provider) {
    const models=s!.config.gpu!.models,pair=provider === 'amd' ? [models.amdOllama,models.amdVllm] : [models.nvidiaOllama,models.nvidiaVllm];
    requireSafe(s!.config.gpu!.devices[provider] && pair[0] && pair[1],'PREREQUISITE');
    return pair as [NonNullable<typeof models.amdOllama>,NonNullable<typeof models.amdVllm>];
  }
  async function pair(provider:Provider,sameEngine=false) {
    const [ollama,vllm]=fixtures(provider),target=`${provider}-gpu` as const;
    await s!.transition(provider,'shared',2);
    const first=await s!.create(`${provider}-${sameEngine ? 'same' : 'pair'}-one`,ollama!,true);await s!.ready(first);
    const second=await s!.create(`${provider}-${sameEngine ? 'same' : 'pair'}-two`,sameEngine ? ollama! : vllm!,true);await s!.ready(second);
    await s!.slots(target,2,2);requireSafe((await s!.state(provider)).memoryIsolation === false,'API');
    await Promise.all([s!.inference.chat(first.client.name),s!.inference.chat(second.client.name)]);
    for (const model of [first,second]) await s!.remove(model);await s!.slots(target,0,2);
  }

  test('SHR-08 stale revision, node UID, invalid counts and missing confirmation cannot mutate intent',proof(['p4-invalid-intent']),async ()=>{
    const state=await s!.state('nvidia');
    const base:GpuSharingRequest={provider:'nvidia',mode:'shared',maxModels:2,nodeName:s!.config.gpu!.nodeName,nodeUid:s!.config.gpu!.nodeUid,
      expectedRevision:state.expectedRevision,acknowledgeSharing:true,acknowledgeRestart:true};
    for (const change of [{expectedRevision:'0'},{nodeUid:'regression-stale-node'},{maxModels:0},{maxModels:17},
      {acknowledgeSharing:false},{acknowledgeRestart:false}]) await rejectedSharing({...base,...change});
  });
  for (const provider of ['amd','nvidia'] as const) test(`SHR-02 SHR-${provider === 'amd' ? '04' : '03'} ${provider} transitions match actual backend and live form`,
    proof(['p4-dirty-confirmation',provider === 'amd' ? 'p4-amd-transition' : 'p4-nvidia-transition']),async ()=>{
      const scenario=s!,vendor=provider === 'amd' ? 'AMD' : 'NVIDIA';
      await scenario.transition(provider,'exclusive');await scenario.slots(`${provider}-gpu`,0,1);
      await page.goto(scenario.config.dashboardUrl+'/#/system/hardware');
      await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      const section=page.getByLabel(`${vendor} GPU sharing`);await section.locator('summary').click();
      const mode=section.getByLabel(`${vendor} allocation mode`),apply=section.getByRole('button',{name:`Apply ${vendor} sharing`});
      await expect(mode).toHaveValue('exclusive');await expect(apply).toBeDisabled();
      await mode.selectOption('shared');await expect(apply).toBeEnabled();
      await mode.selectOption('exclusive');await expect(apply).toBeDisabled();
      await mode.selectOption('shared');await apply.click();
      const dialog=page.getByRole('dialog');await expect(dialog).toContainText(/restart|interrupt/);
      const before=await module(provider);await dialog.getByRole('button',{name:'Cancel'}).click();
      const after=await module(provider);requireSafe(after.metadata.generation === before.metadata.generation && canonical(after.spec) === canonical(before.spec),'CONFLICT');
      await scenario.transition(provider,'shared',2);await scenario.slots(`${provider}-gpu`,0,2);
      await page.reload();await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      await page.getByLabel(`${vendor} GPU sharing`).locator('summary').click();
      await expect(page.getByLabel(`${vendor} allocation mode`)).toHaveValue('shared');
      await expect(page.getByLabel(`${vendor} maximum simultaneous models`)).toHaveValue('2');
    });
  for (const provider of ['amd','nvidia'] as const) {
    test(`SHR-05 SHR-06 ${provider} Ollama plus vLLM both infer with real admission`,proof([`p4-${provider}-pair` as GpuVariant,'p4-rbac-admission']),async ()=>pair(provider));
    test(`SHR-06 ${provider} two Ollama runtimes share the device without memory-isolation claims`,proof([`p4-${provider}-same-engine` as GpuVariant]),async ()=>pair(provider,true));
    // Keep each provider's real pair/full-slot cases together to avoid repeated
    // cold multi-GiB runtime pulls on a storage-constrained lab. No cache is
    // cleared and no runtime/binding/inference assertion is omitted.
    test(`SLOT-04 SLOT-05 SLOT-06 SLOT-07 ${provider} fill, refreshed draft, release and own-slot edit`,
    proof(['p4-full','p4-draft-refresh','p4-release','p4-edit-own-slot']),async ()=>{
      const scenario=s!,target=`${provider}-gpu` as const,[ollama,vllm]=fixtures(provider);
      await scenario.transition(provider,'shared',2);
      const first=await scenario.create(`${provider}-full-one`,ollama!,true);await scenario.ready(first);await scenario.slots(target,1,2);
      await scenario.openModels(page);await page.getByRole('button',{name:'Create',exact:true}).click();
      const dialog=page.getByRole('dialog',{name:'Create Model'});
      await dialog.getByLabel('Inference Engine').selectOption('VLLM');await dialog.getByLabel('Hardware').selectOption(target);
      await dialog.getByLabel('Model source').selectOption('direct');
      // The draft has no source yet, so no estimator or runtime mutation occurs.
      await dialog.getByLabel('Name').fill('regression-retained-draft');
      const second=await scenario.create(`${provider}-full-two`,vllm!,true);await scenario.ready(second);await scenario.slots(target,2,2);
      await expect(dialog.getByLabel('Hardware')).toHaveValue(target);
      await expect(dialog.getByLabel('Name')).toHaveValue('regression-retained-draft');
      await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeDisabled();
      await expect(dialog.getByText(/No free GPU model slots/)).toBeVisible({timeout:25_000});
      await dialog.getByRole('button',{name:'Cancel'}).click();
      const data=await scenario.live.api.models(),memory=data.computeMemory?.devices?.find(d=>d.computeTarget === target);
      requireSafe(memory?.slots?.free === 0,'CAPABILITY');
      const gauge=page.getByRole('article',{name:`${memory.name} memory`});
      expect(await gauge.locator('[data-slot="free"]').count()).toBe(0);
      let rejected=false;
      try {await scenario.create(`${provider}-full-reject`,ollama!,true);}
      catch(error) {requireSafe(error instanceof ModelCreateRejected && error.httpStatus === 409,'API');rejected=true;}
      requireSafe(rejected,'API');
      const secondBefore=activation(await second.client.models(),second.client.name)!;
      await scenario.lifecycle(first,'edit');await scenario.slots(target,2,2);
      const secondAfter=activation(await second.client.models(),second.client.name)!;
      requireSafe(secondAfter.metadata?.uid === second.uid && canonical(secondAfter.spec) === canonical(secondBefore.spec),'CONFLICT');
      await scenario.inference.chat(second.client.name);
      await lifecycleUi(scenario,page,first,'stop');await scenario.slots(target,1,2);
      await lifecycleUi(scenario,page,first,'start');await scenario.slots(target,2,2);
      for(const model of [first,second]) await scenario.remove(model);await scenario.slots(target,0,2);
    });
  }

  test('SLOT-03 an actual optional validation consumer occupies a slot and completion releases it',proof(['p4-other-consumers']),async ()=>{
    const scenario=s!,[fixture]=fixtures('nvidia');await scenario.transition('nvidia','shared',2);
    const model=await scenario.create('validation-anchor',fixture,true);await scenario.ready(model);
    const request=await requestValidationUi(scenario,page,'OLlama','nvidia',10);
    await scenario.slots('nvidia-gpu',2,2);await completedValidation(scenario,request);
    await scenario.slots('nvidia-gpu',1,2);await scenario.inference.chat(model.client.name);await scenario.remove(model);
  });

  test('SHR-07 provider transition restarts only its owned runtimes while other GPU and CPU inference survive',proof(['p4-provider-independence']),async ()=>{
    const scenario=s!,[amdFixture]=fixtures('amd'),[nvFixture]=fixtures('nvidia');
    requireSafe(scenario.config.smokeModel,'PREREQUISITE');
    for(const provider of ['amd','nvidia'] as const)await scenario.transition(provider,'shared',2);
    const cpu=await scenario.create('independent-cpu',scenario.config.smokeModel,true);
    const amd=await scenario.create('independent-amd',amdFixture,true);
    const nv=await scenario.create('independent-nvidia',nvFixture,true);
    for(const model of [cpu,amd,nv]) await scenario.ready(model);
    for (const [provider,affected,unaffected] of [['amd',amd,nv],['nvidia',nv,amd]] as const) {
      const baseline=await Promise.all([unaffected,cpu].map(m=>scenario.live.modelState(m.client,m.uid)));
      const unaffectedSettings=await module(provider === 'amd' ? 'nvidia' : 'amd');
      for(const mode of ['exclusive','shared'] as const) {
        await scenario.transition(provider,mode,2);await scenario.ready(affected);
        const otherSettings=await module(provider === 'amd' ? 'nvidia' : 'amd');
        requireSafe(otherSettings.metadata.generation === unaffectedSettings.metadata.generation && canonical(otherSettings.spec) === canonical(unaffectedSettings.spec),'CONFLICT');
        for(const [index,m] of [unaffected,cpu].entries()) {
          const state=await scenario.live.modelState(m.client,m.uid),before=baseline[index]!;
          requireSafe(state.item?.metadata?.generation === before.item?.metadata?.generation && canonical(state.item?.spec) === canonical(before.item?.spec) &&
            canonical(state.pods.map(p=>p.metadata.uid).sort()) === canonical(before.pods.map(p=>p.metadata.uid).sort()),'CONFLICT');
          await scenario.inference.chat(m.client.name);
        }
      }
    }
    for(const model of [cpu,amd,nv]) await scenario.remove(model);
  });

  for(const provider of ['nvidia','amd'] as const) test(`SLOT-09 ${provider} two independent API clients race for the final slot without overscheduling`,
    proof(['p4-last-slot-race']),async ()=>{
      const scenario=s!,target=`${provider}-gpu` as const,[ollama,vllm]=fixtures(provider);
      await scenario.transition(provider,'shared',2);
      const anchor=await scenario.create(`${provider}-race-anchor`,ollama!,true);await scenario.ready(anchor);
      const attempts=await Promise.allSettled([scenario.create(`${provider}-race-one`,vllm!,true),scenario.create(`${provider}-race-two`,vllm!,true)]);
      const accepted=attempts.filter((r):r is PromiseFulfilledResult<GpuCreated>=>r.status === 'fulfilled').map(r=>r.value);
      requireSafe(accepted.length >= 1,'API');
      for(const item of attempts.filter(r=>r.status === 'rejected')) requireSafe(item.status === 'rejected' && item.reason instanceof ModelCreateRejected && item.reason.httpStatus === 409,'API');
      const observed=await poll(async ()=>{
        const states=await Promise.all(accepted.map(m=>scenario.live.modelState(m.client,m.uid)));
        const active=[await scenario.live.modelState(anchor.client,anchor.uid),...states];
        requireSafe(active.filter(state=>state.item?.status?.phase === 'Ready').length <= 2 && active.flatMap(state=>state.pods)
          .filter(p=>p.status?.conditions?.some(c=>c.type === 'Ready' && c.status === 'True')).length <= 2,'CAPABILITY');
        return states;
      },states=>states.some(state=>state.item?.status?.phase === 'Ready'),{timeoutMs:900_000,intervalMs:1000,stage:'gpu-slots'});
      for(const [index,state] of observed.entries()) if(state.item?.status?.phase === 'Ready') await scenario.ready(accepted[index]!);
      // One admitted Ready runtime is not enough: later reconciliation must
      // not admit a third consumer. Observe the same enabled owned definitions
      // over a bounded steady window, without automatic inference retries.
      const until=Date.now()+30_000;
      await poll(async ()=>{
        await scenario.live.guard();
        const active=await Promise.all([anchor,...accepted].map(m=>scenario.live.modelState(m.client,m.uid)));
        requireSafe(active.filter(state=>state.item?.status?.phase === 'Ready').length <= 2 && active.flatMap(state=>state.pods)
          .filter(p=>p.status?.conditions?.some(c=>c.type === 'Ready' && c.status === 'True')).length <= 2,'CAPABILITY');
        const slots=(await scenario.live.api.models()).computeTargets.targets.find(t=>t.id === target)?.slots;
        requireSafe(slots?.total === 2 && slots.used <= 2 && slots.free >= 0,'CAPABILITY');
        return Date.now() >= until;
      },done=>done,{timeoutMs:60_000,intervalMs:1000,stage:'gpu-slots'});
      await scenario.inference.chat(anchor.client.name);
      for(const model of [anchor,...accepted]) await scenario.remove(model);await scenario.slots(target,0,2);
    });

  test('SHR-12 reload shows the persisted backend counts in Hardware and Models',proof(['p4-reload']),async ()=>{
    const scenario=s!;await page.goto(scenario.config.dashboardUrl+'/#/system/hardware');await page.reload();
    for(const provider of ['amd','nvidia'] as const) {
      if(!scenario.config.gpu!.devices[provider])continue;
      await scenario.transition(provider,'shared',2);
      await scenario.waitBackend(provider,'shared',2);const vendor=provider === 'amd' ? 'AMD' : 'NVIDIA';
      await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      const section=page.getByLabel(`${vendor} GPU sharing`);await section.locator('summary').click();
      await expect(section.getByLabel(`${vendor} allocation mode`)).toHaveValue('shared');
      await expect(section.getByLabel(`${vendor} maximum simultaneous models`)).toHaveValue('2');
    }
    await scenario.openModels(page);for(const provider of ['amd','nvidia'] as const)if(scenario.config.gpu!.devices[provider])await scenario.slots(`${provider}-gpu`,0,2);
  });
  test('HAR-08 restores exact borrowed settings, all run-owned resources and unaffected model definitions',proof(['p4-restoration']),async ()=>{
    await s!.close();s=undefined;
  });
});
