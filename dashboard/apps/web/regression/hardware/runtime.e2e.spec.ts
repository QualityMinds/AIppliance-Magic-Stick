import {canonical} from '../core/borrowed-sharing.ts';
import {test,expect,type Page,type TestInfo} from '@playwright/test';
import {GpuScenario,physicalDevice} from '../core/gpu-scenario.ts';
import {requireSafe} from '../core/errors.ts';
import {evidenceAnnotations,evidenceStep,type TestLayer} from '../core/evidence.ts';
import {phase3Variants,type GpuVariant} from '../profiles/gpu-p0.ts';
import {installedReadyUi,lifecycleUi,logsUi,modelCard} from './live-ui.ts';

function proof(keys:GpuVariant[],layers:TestLayer[]=['A','E']) {
  return evidenceAnnotations(...keys.flatMap(variant=>layers.filter(layer=>(phase3Variants[variant as keyof typeof phase3Variants].layers as readonly TestLayer[]).includes(layer))
    .map(layer=>({id:phase3Variants[variant as keyof typeof phase3Variants].id,variant,layer}))));
}
const step=<T>(info:TestInfo,keys:GpuVariant[],action:()=>Promise<T>)=>
  evidenceStep(info,proof(keys).annotation.map(item=>JSON.parse(item.description!)),action);
test.describe('Installed exclusive physical GPU runtimes',()=>{
  let scenario:GpuScenario|undefined; let page:Page;
  const nvidiaDiagnostic=process.env.REGRESSION_MODE === 'phase3-gpu' && process.env.REGRESSION_GPU_CASE === 'nvidia-lifecycle';
  test.beforeAll(async ({browser},info)=>{
    scenario=await GpuScenario.open(browser,info.workerIndex);
    // A replacement worker sees the restored original settings, not the
    // previous worker's exclusive backend. Establish its own observed backend.
    for(const provider of ['amd','nvidia'] as const)if((!nvidiaDiagnostic || provider === 'nvidia') &&
      scenario.config.gpu!.devices[provider])await scenario.transition(provider,'exclusive');
    page=await scenario.live.context.newPage();
  });
  test.afterAll(async ()=>{if (scenario) await scenario.close();});

  test('HW-01 HW-02 HW-08 MEM-04 MEM-08 MEM-09 SLOT-01 pinned physical inventory and non-additive memory',proof([
    'p3-inventory','p3-mixed-vendor','p3-memory-denominators','p3-unified-memory','p3-slot-ring']),async ()=>{
    const s=scenario!;
    requireSafe(s.config.gpu!.devices.amd && s.config.gpu!.devices.nvidia,'PREREQUISITE');
    const {devices}=await s.inventory(),models=await s.live.api.models();
    requireSafe(physicalDevice(devices,'amd').architecture === 'gfx1151' &&
      physicalDevice(devices,'nvidia').pciAddress !== physicalDevice(devices,'amd').pciAddress,'CAPABILITY');
    const memories=models.computeMemory?.devices ?? [];
    const amd=memories.find(d=>d.computeTarget === 'amd-gpu'),nv=memories.find(d=>d.computeTarget === 'nvidia-gpu');
    requireSafe(amd && nv && amd.memoryArchitecture === 'unified' && nv.memoryArchitecture !== 'unified' && amd.sharedPoolId &&
      amd.metricsAvailable && nv.metricsAvailable && Number(amd.freeMi) > 0 && Number(nv.freeMi) > 0,'CAPABILITY');
    const pool=models.computeMemory?.sharedPools?.find(p=>p.id === amd.sharedPoolId);
    requireSafe(pool && Number(pool.sharedFreeMi) <= Number(pool.freeMi) && Number(pool.sharedFreeMi) <= Number(amd.gpuCapacityMi) &&
      Number(pool.gpuAccessibleMi) <= Number(pool.physicalMemoryMi) && Number(pool.physicalMemoryMi) <= Number(pool.installedMemoryMi),'CAPABILITY');
    await s.openModels(page);
    for (const device of [amd,nv]) {
      const target=models.computeTargets.targets.find(t=>t.id === device.computeTarget);
      requireSafe(target?.slots && device.slots?.total === target.slots.total && device.slots.free === target.slots.free,'CAPABILITY');
      const gauge=page.getByRole('article',{name:`${device.name} memory`});
      await expect(gauge.getByText(`${target.slots.free} / ${target.slots.total} free`,{exact:true})).toBeVisible();
      expect(await gauge.locator('[data-slot="free"]').count()).toBe(target.slots.free);
    }
    await page.goto(s.config.dashboardUrl+'/#/system/hardware');
    const node=page.getByRole('article',{name:`GPU node ${s.config.gpu!.nodeName}`});
    await expect(node.getByText(`Node: ${s.config.gpu!.nodeName}`,{exact:true})).toBeVisible();
    for (const d of devices) {
      await node.getByText(`GPU Configuration ${d.vendor === 'amd' ? 'AMD' : 'NVIDIA'}`,{exact:true}).click();
      await expect(node.getByRole('region',{name:`GPU ${d.name} · ${d.pciAddress}`})).toBeVisible();
    }
  });

  test('HW-03 HW-08 MEM-08 rejects stale identity without changing Modules',proof(['p3-readiness','p3-identity','p3-memory-unknown'],['A']),async ()=>{
    const s=scenario!,before=await Promise.all(['amd-gpu','gpu'].map(name=>s.live.observer.get('moduleactivations.appliance.magicstick.dev',s.config.expected.applianceNamespace,name))),body={nodeName:s.config.gpu!.nodeName,nodeUid:'regression-stale-node',engine:'OLlama',
      deviceIds:[Object.values(s.config.gpu!.devices)[0]!.id],requestId:`dashboard-${s.live.journal.runId}-stale`,acknowledgeResourceUse:true};
    await s.live.guard();
    const response=await s.live.context.request.post(s.config.dashboardUrl+'/api/hardware/validation',{data:body,
      headers:{Origin:s.config.dashboardUrl,'X-MagicStick-CSRF':'dashboard'},maxRedirects:0,timeout:s.config.requestTimeoutMs});
    requireSafe([400,409].includes(response.status()),'API');
    for (const original of before) {
      const after=await s.live.observer.get('moduleactivations.appliance.magicstick.dev',s.config.expected.applianceNamespace,original.metadata.name!);
      requireSafe(after.metadata.uid === original.metadata.uid && after.metadata.generation === original.metadata.generation &&
        canonical(after.spec) === canonical(original.spec),'CONFLICT');
    }
    for(const provider of ['amd','nvidia'] as const)if(s.config.gpu!.devices[provider])await s.transition(provider,'exclusive');
    const {devices}=await s.inventory(); requireSafe(devices.every(d=>d.hostDriverReady === true && d.resourceRegistered && d.eligible),'CAPABILITY');
  });

  const combinations=[['amdOllama','amd-ollama'],['amdVllm','amd-vllm'],['nvidiaOllama','nvidia-ollama'],['nvidiaVllm','nvidia-vllm']] as const;
  // Repetitions are separate executions, not retries: a failed Stop remains
  // failed and the next cycle cannot erase it. NVIDIA diagnosis never changes
  // the AMD sharing backend or launches an AMD model.
  for (const [key,label] of combinations) for(let cycle=1;cycle<=(nvidiaDiagnostic ? 3 : 1);cycle++)
    test(`ENG-01 ENG-03 LOG-01 ROUTE-01 SLOT-02 LIFE-03 LIFE-04 ${label} actual device, cache, routed inference, logs and lifecycle${nvidiaDiagnostic ? ` cycle ${cycle}` : ''}`,
    proof([`p3-${label}` as GpuVariant,`p3-kv-${label}` as GpuVariant,'p3-gpu-logs','p3-route','p3-pending-slot',
      'p3-runtime-stop','p3-runtime-start']),async ({},info)=>{
      const s=scenario!,fixture=s.config.gpu!.models[key];
      requireSafe(fixture,'PREREQUISITE');
      const model=await s.create(nvidiaDiagnostic ? `${label}-cycle-${cycle}` : label,fixture,true);
      try {
      // Enabled intent reserves immediately and must not be counted again
      // once the actual allocation is observed. The deterministic before-Pod
      // timing is covered separately in U/C; live scheduling can be faster.
      await step(info,['p3-pending-slot'],async()=>{
        await s.slots(fixture.computeTarget,1,1);
        const pending=await s.live.modelState(model.client,model.uid);
        requireSafe(pending.item?.spec?.enabled === true && pending.item.spec.local?.kvCacheType === fixture.kvCacheType,'API');
      });
      await step(info,[`p3-${label}` as GpuVariant,`p3-kv-${label}` as GpuVariant,'p3-route'],async()=>{
      const ready=await s.ready(model);
      const status=ready.item?.status;
      requireSafe(status && status.requestedKvCacheType === fixture.kvCacheType &&
        typeof status.effectiveKvCacheType === 'string' && status.effectiveKvCacheType.length > 0,'API');
      await s.slots(fixture.computeTarget,1,1); await s.openModels(page);
      const card=modelCard(page,model.client.name);
      // ModelsPage polls every 15 seconds. A just-observed API Ready state can
      // legitimately follow an older browser query; wait for real UI convergence
      // rather than racing its next refresh with the default 5-second assertion.
      await installedReadyUi(page,model.client.name);
      await expect(card.getByText(`Engine: ${fixture.engine}`,{exact:true})).toBeVisible();
      await expect(card.getByText(`KV requested: ${fixture.kvCacheType}`,{exact:true})).toBeVisible();
      await expect(card.getByText(`KV active: ${status.effectiveKvCacheType}`,{exact:true})).toBeVisible({timeout:60_000});
      });
      await step(info,['p3-gpu-logs'],()=>logsUi(s,page,model));
      await step(info,['p3-runtime-stop'],async()=>{
        await lifecycleUi(s,page,model,'stop'); await s.slots(fixture.computeTarget,0,1);
      });
      await step(info,['p3-runtime-start'],async()=>{
        await lifecycleUi(s,page,model,'start'); await s.slots(fixture.computeTarget,1,1);
      });
      } finally {await s.remove(model);}
      await s.slots(fixture.computeTarget,0,1);
    });


  test('HAR-08 restore borrowed provider specs and clean only journal-owned definitions, Pods, routes and key',proof(['p3-restoration'],['A']),async ()=>{
    const s=scenario!;await s.close();scenario=undefined;
  });
});
