import {test,expect,type Page,type Request} from '@playwright/test';
import type {ModelsPayload,GpuSharingState,HardwareGpuDevice} from '@magicstick/dashboard-contracts';
import {fixturePage,origin} from '../fixtures/dashboard.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {installedReadyUi} from './live-ui.ts';
import {fourNvidiaCards,fourNvidiaCardsWithMixedTelemetry,heterogeneousNvidiaCards,nvidiaSelection} from '../fixtures/nvidia-cards.ts';

const phase = process.env.REGRESSION_MODE === 'phase4-fixtures' ? 4 : 3;
if (phase === 3) for (const viewport of ['desktop', 'mobile'] as const)
test(`ENG-01 ${viewport} offers supported engines and retains cleanup for a retired model`, evidenceAnnotations(
  {id: 'ENG-01', variant: 'p3-engine-selection', layer: 'B'}), async ({page}, info) => {
  await page.setViewportSize(viewport === 'mobile' ? {width:390,height:844} : {width:1440,height:1000});
  const data = fourNvidiaCards();
  data.activations = [{metadata:{name:'retired-model',uid:'retired-model-uid',generation:1,resourceVersion:'1'},
    spec:{type:'local',enabled:false,local:{engine:'FreeToken',computeTarget:'nvidia-gpu'}},status:{phase:'Disabled'}}];
  await fixturePage(page, {'/api/models':data, '/api/model-discovery/popular':{results:[]}});
  await page.goto(origin+'/#/models');
  await expect(page.getByText('This engine is no longer supported.', {exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start retired-model'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Edit retired-model'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Restart retired-model'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Remove',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Create',exact:true}).click();
  const engine = page.getByLabel('Inference Engine');
  await expect(engine.locator('option')).toHaveText(['OLlama','VLLM']);
  for (const value of ['OLlama','VLLM']) {
    await engine.selectOption(value);
    await expect(page.getByLabel('KV Cache')).toBeVisible();
  }
  await engine.focus();
  await page.screenshot({path:info.outputPath(`engine-selection-${viewport}.png`),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

for (const viewport of ['desktop','mobile'] as const) for (const engine of ['VLLM','OLlama'] as const) for (const different of [false,true])
test(`MGPU-02 ${engine} ${different?'different':'identical'} cards ${viewport} browser creates copies then edits mode and reads individual logs`, evidenceAnnotations(
  {id:'MGPU-02',variant:`p${phase}-replicated-config`,layer:'B'}), async ({page}, info) => {
  await page.setViewportSize(viewport === 'mobile' ? {width:390,height:844} : {width:1440,height:1000});
  const data=different?heterogeneousNvidiaCards():fourNvidiaCardsWithMixedTelemetry(),writes:Array<{local:Record<string,unknown>}> = [],logQueries:string[]=[];
  const estimate={detectedModelType:'chat',minimumMi:2000,recommendedMi:6000,maximumMi:different?12288:40960,systemMemoryMaximumMi:32000,confidence:'high'};
  await fixturePage(page,{'/api/models':()=>data, '/api/models/local':(request:Request)=>{
    const payload=request.postDataJSON();writes.push(payload);
    data.activations=[{metadata:{name:payload.name,uid:'parent-fixture',generation:1,resourceVersion:'1'},spec:{...payload,type:'local',local:{...payload.local,modelType:'chat'}},
      status:{phase:'Degraded',replication:{desired:2,ready:1,instances:[{name:'copy-a',uuid:nvidiaSelection(0).uuid,nodeName:'fixture-node',phase:'Ready'},
        {name:'copy-b',uuid:nvidiaSelection(3).uuid,nodeName:'fixture-node',phase:'Degraded',message:'Copy failed; inspect Logs.'}]}}}];return {};},
    '/api/model-discovery/popular':{results:[]},
    '/api/models/estimate-memory':estimate,
    '/api/models/replica-fixture/estimate-memory':estimate,
    '/api/models/replica-fixture/logs':(request:Request)=>{logQueries.push(request.url());return {model:'replica-fixture',namespace:'ai',generatedAt:'2026-10-09T00:00:00Z',tailLines:300,
      replicas:[{name:'copy-a',uuid:nvidiaSelection(0).uuid},{name:'copy-b',uuid:nvidiaSelection(3).uuid}],pods:[]};},
  });
  await page.goto(origin+'/#/models');await page.getByRole('button',{name:'Create',exact:true}).click();
  let dialog=page.getByRole('dialog');await dialog.getByLabel('Inference Engine').selectOption(engine);
  await dialog.getByRole('combobox',{name:'Hardware',exact:true}).selectOption('nvidia-gpu');await dialog.getByLabel('Model source').selectOption('direct');
  await dialog.getByLabel(engine==='VLLM'?'Hugging Face URL':'Ollama model reference').fill(engine==='VLLM'?'hf://fixture/small':'ollama://fixture:small');
  await dialog.getByLabel('Name',{exact:true}).fill('replica-fixture');
  await dialog.getByLabel('GPU deployment').selectOption('replicated');
  await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeDisabled();
  await dialog.getByRole('checkbox',{name:/0000:04:00.0/}).check();
  await dialog.getByText('Advanced',{exact:true}).click();
  await expect(dialog.getByLabel('System RAM per copy (MiB)')).toHaveValue('16400');
  await expect(dialog.getByLabel('GPU parallelism')).toHaveCount(0);
  await expect(dialog.getByRole('slider',{name:'Memory reservation'})).toHaveValue('6000');
  await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeEnabled();
  await dialog.getByLabel('GPU deployment').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath(`replicated-${engine}-${viewport}.png`)});
  await dialog.getByLabel('System RAM per copy (MiB)').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath(`replicated-ram-${engine}-${viewport}.png`)});
  await dialog.getByRole('button',{name:'Add Local Model'}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes[0]!.local).toMatchObject({gpuDeployment:'replicated',gpuDevices:[0,3].map(i=>nvidiaSelection(i)),memoryRequiredMi:16400,vram:'6000Mi'});
  expect(writes[0]!.local).not.toHaveProperty('vllm');
  await expect(page.getByText('2 model copies · one API name · 1/2 ready')).toBeVisible();
  await page.getByText('Model copies',{exact:true}).click();await expect(page.getByText('Copy failed; inspect Logs.')).toBeVisible();
  await page.getByRole('button',{name:'Edit replica-fixture'}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('GPU deployment')).toHaveValue('replicated');
  await expect(dialog.getByRole('button',{name:'Save changes'})).toBeDisabled();
  await dialog.getByLabel('GPU deployment').selectOption('split');await expect(dialog.getByRole('button',{name:'Save changes'})).toBeEnabled();
  await expect(dialog.getByLabel('Total VRAM budget (MiB)')).toHaveValue('12000');
  await dialog.getByLabel('GPU deployment').selectOption('replicated');await expect(dialog.getByRole('button',{name:'Save changes'})).toBeDisabled();
  await expect(dialog.getByLabel('VRAM budget (MiB)',{exact:true})).toHaveValue('6000');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'View logs for replica-fixture'}).click();
  await page.getByRole('combobox',{name:'Model copy',exact:true}).selectOption('copy-b');
  await expect.poll(()=>logQueries.some(q=>new URL(q).searchParams.get('replica')==='copy-b')).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
for (const viewport of ['desktop','mobile'] as const) for (const engine of ['VLLM','OLlama'] as const) for (const count of [2,4]) for (const different of [false,true])
test(`MGPU-01 ${engine} ${count} ${different?'different':'identical'} GPUs ${viewport} browser creates and edits total budgets with per-card persistence`, evidenceAnnotations(
  {id:'MGPU-01',variant:`p${phase}-multigpu-config`,layer:'B'}), async ({page}, info) => {
  await page.setViewportSize(viewport === 'mobile' ? {width:390,height:844} : {width:1440,height:1000});
  const data=different?heterogeneousNvidiaCards():fourNvidiaCardsWithMixedTelemetry(),writes: Array<{local:Record<string,unknown>}> = [],updates:Array<{local:Record<string,unknown>}> = [];
  const perCardMaximum=different?(count===4?12200:20400):(count===4?40900:49100);
  const savedPerCard=different?10000:40000,editedPerCard=different?8000:38000;
  const oversizedPerCard=different?(count===4?16400:24600):49200;
  const estimate={detectedModelType:'chat',minimumMi:2000,recommendedMi:6000,maximumMi:different?(count===4?12288:20480):(count===4?40960:49152),systemMemoryMaximumMi:32000,confidence:'high'};
  await fixturePage(page,{'/api/models':()=>data, '/api/models/local':(request:Request)=>{
    const payload=request.postDataJSON();writes.push(payload);
    data.activations=[{metadata:{name:'split-fixture',uid:'split-fixture-uid',generation:1,resourceVersion:'1'},
      spec:{...payload,type:'local',local:{...payload.local,modelType:'chat'}},status:{phase:'Disabled'}}];return {};},
    '/api/models/split-fixture':(request:Request)=>{updates.push(request.postDataJSON());return {};},
    '/api/models/split-fixture/estimate-memory':estimate,
    '/api/model-discovery/popular':{results:[]}, '/api/models/estimate-memory':estimate});
  await page.goto(origin+'/#/models'); await page.getByRole('button',{name:'Create',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Create Model'}); await dialog.getByLabel('Inference Engine').selectOption(engine);
  await dialog.getByRole('combobox',{name:'Hardware',exact:true}).selectOption('nvidia-gpu'); await dialog.getByLabel('Model source').selectOption('direct');
  await dialog.getByLabel(engine === 'VLLM' ? 'Hugging Face URL' : 'Ollama model reference').fill(engine === 'VLLM' ? 'hf://fixture/small' : 'ollama://fixture:small');
  await dialog.getByLabel('Name',{exact:true}).fill('split-fixture');
  await expect(dialog.getByRole('checkbox',{name:/0000:04:00.0/})).toBeEnabled();
  const settledEstimate=page.waitForResponse(response=>{
    if(new URL(response.url()).pathname!=='/api/models/estimate-memory')return false;
    const payload=response.request().postDataJSON();
    return payload.gpuDevices?.length===count && (engine!=='VLLM'||payload.vllm?.parallelism==='pipeline');
  });
  await dialog.getByLabel('Automatic GPU count').fill(String(count)); await dialog.getByRole('button',{name:'Select GPUs'}).click();
  await expect(dialog.getByText(`${count} GPUs selected.`,{exact:false})).toBeVisible();
  await dialog.getByText('Advanced',{exact:true}).click();
  if(engine === 'VLLM') await dialog.getByLabel('GPU parallelism').selectOption('pipeline');
  else await expect(dialog.getByText('Ollama spreads the model', {exact:false})).toBeVisible();
  expect((await settledEstimate).status()).toBe(200);
  await expect(dialog.getByLabel('Multi-GPU system RAM (MiB)')).toHaveValue('16400');
  const slider=dialog.getByRole('slider',{name:'Memory reservation'}),budget=dialog.getByLabel('Total VRAM budget (MiB)');
  await expect(slider).toHaveAttribute('max',String(perCardMaximum*count));
  await expect(slider).toHaveAttribute('step',String(100*count));
  await expect(budget).toHaveValue(String(6000*count));
  await dialog.getByRole('button',{name:'100%',exact:true}).click();await expect(budget).toHaveValue(String(perCardMaximum*count));
  await dialog.getByRole('button',{name:'Explain 100% unreserved',exact:true}).focus();await page.keyboard.press('Enter');
  const calculation=page.getByRole('dialog',{name:'100% unreserved calculation'});
  await expect(calculation).toContainText(`${count} × floor(`);
  await expect(calculation).toContainText('divided equally across the selected GPUs');await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await budget.fill(String(oversizedPerCard*count));await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeDisabled();
  await budget.fill(String(savedPerCard*count));await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeEnabled();
  await budget.scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath(`multi-gpu-${engine}-${count}-${viewport}.png`),fullPage:true});
  await dialog.getByRole('button',{name:'Add Local Model'}).click();
  await expect.poll(()=>writes.length).toBe(1);
  expect(writes).toHaveLength(1); expect(writes[0]!.local.gpuDevices).toEqual(Array.from({length:count},(_,i)=>nvidiaSelection(i)));
  expect(writes[0]!.local.vram).toBe(`${savedPerCard}Mi`);
  expect(writes[0]!.local.memoryRequiredMi).toBe(16400); expect(writes[0]!.local).not.toHaveProperty('gpuDevice');
  if(engine === 'VLLM') expect(writes[0]!.local.vllm).toEqual({parallelism:'pipeline'});
  else expect(writes[0]!.local).not.toHaveProperty('vllm');
  await page.getByRole('button',{name:'Edit split-fixture'}).click();dialog=page.getByRole('dialog',{name:'Edit Model · split-fixture'});
  const savedBudget=dialog.getByLabel('Total VRAM budget (MiB)'),save=dialog.getByRole('button',{name:'Save changes'});
  await expect(savedBudget).toHaveValue(String(savedPerCard*count));await expect(save).toBeDisabled();
  await savedBudget.fill(String(editedPerCard*count));await expect(save).toBeEnabled();
  await savedBudget.fill(String(savedPerCard*count));await expect(save).toBeDisabled();
  await savedBudget.fill(String(editedPerCard*count));await expect(save).toBeEnabled();
  await savedBudget.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(`multi-gpu-edit-${engine}-${count}-${viewport}.png`)});
  await save.click();await expect.poll(()=>updates.length).toBe(1);expect(updates[0]!.local).toEqual({vramMi:editedPerCard});
  expect(updates[0]!.local).not.toHaveProperty('gpuDevices');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
const host = {name:'fixture-node',nodeUid:'fixture-node-uid',bootId:'fixture-boot',kernel:'7.0-fixture',available:true,message:'Fixture host available.'};
const providers = ():GpuSharingState[] => ['amd','nvidia'].map(provider => ({provider:provider as 'amd'|'nvidia',
  backend:provider === 'amd' ? 'dra' : 'time-slicing',mode:'exclusive',managed:true,experimental:provider === 'amd',
  maxModels:2,nodeName:host.name,nodeUid:host.nodeUid,namespace:'ai',expectedRevision:'fixture-revision',available:true,
  reason:'',phase:'Ready',message:'',claimName:'',activeModels:0,admittedModels:[],memoryIsolation:false}));
const devices:HardwareGpuDevice[] = ['amd','nvidia'].map((vendor,index) => ({vendor,id:`fixture-node-uid/0000:0${index+1}:00.0`,node:host.name,
  nodeUid:host.nodeUid,bootId:host.bootId,name:vendor === 'amd' ? 'AMD Fixture GPU' : 'NVIDIA Fixture GPU',
  pciAddress:`0000:0${index+1}:00.0`,pciId:vendor === 'amd' ? '1002:1586' : '10de:fixture',architecture:vendor === 'amd' ? 'gfx1151' : 'CUDA 8.6',
  hostDriverReady:null,resourceRegistered:false,validationAvailable:false,validationReason:'Waiting for fresh physical GPU inventory from the host.'}));
async function hardware(page:Page,states=providers(),gpuDevices=devices) {
  const writes:unknown[] = [];
  await fixturePage(page,{'/api/host-management':{nodes:[host]},'/api/hardware/gpu-sharing':(request:Request) => {
    if (request.method() !== 'GET') writes.push(request.postDataJSON()); return {providers:states};
  },'/api/status':{hardwareOperators:{'amd-gpu':{devices:gpuDevices.filter(d=>d.vendor === 'amd')},gpu:{devices:gpuDevices.filter(d=>d.vendor === 'nvidia')}}}});
  await page.goto(origin+'/#/system/hardware');
  await expect(page.getByText('Node: fixture-node',{exact:true})).toBeVisible(); return writes;
}
function models(free=2):ModelsPayload {
  const slots = {total:2,used:2-free,free,scope:'node' as const};
  return {activations:[],models:[],presets:{},computeTargets:{default:'cpu',targets:[
    {id:'cpu',kind:'cpu',displayName:'CPU',engines:['OLlama','VLLM'],available:true},
    {id:'amd-gpu',kind:'gpu',displayName:'AMD GPU',engines:['OLlama','VLLM'],available:true,slots},
  ]},computeMemory:{devices:[{id:'amd-fixture',name:'AMD Fixture GPU',kind:'gpu',computeTarget:'amd-gpu',memoryArchitecture:'unified',
    sharedPoolId:'shared-fixture',gpuAllocationMode:'shared-gtt',totalMi:108*1024,gpuCapacityMi:108*1024,
    reservedMi:95*1024,unreservedMi:13*1024,freeMi:30003,metricsAvailable:true,slots}],sharedPools:[
    {id:'shared-fixture',node:host.name,installedMemoryMi:128*1024,firmwareReservedMi:512,physicalMemoryMi:128*1024,
      gpuAccessibleMi:108*1024,gpuCapacityMi:108*1024,gpuAllocationMode:'shared-gtt',totalMi:128*1024,freeMi:39116,
      sharedFreeMi:30003,unreservedMi:20*1024,gpuUnreservedMi:13*1024},
  ]}};
}

if (phase === 3) {
  test('SLOT-01 browser shows one legacy NVIDIA pool and independent slot rings for four DRA cards',evidenceAnnotations(
    {id:'SLOT-01',variant:'p3-nvidia-multicard-slots',layer:'B'}),async({page})=>{
    await page.clock.install();let dra=false;
    await fixturePage(page,{'/api/models':()=>fourNvidiaCards(undefined,dra)});await page.goto(origin+'/#/models');
    const pool=page.getByRole('article',{name:'NVIDIA GPU pool · fixture-node'});
    await expect(pool.getByText('15 / 16 free',{exact:true})).toBeVisible();
    await expect(page.locator('[data-slot="used"]')).toHaveCount(1);
    await expect(page.locator('.memory-gauge [data-ring="slots"]')).toHaveCount(0);
    dra=true;await page.clock.fastForward(16_000);
    await expect(pool).toHaveCount(0);
    for(let index=0;index<4;index++) {
      const card=page.getByRole('article',{name:`NVIDIA RTX A6000 · 0000:0${index+1}:00.0 memory`});
      await expect(card.locator('[data-slot="used"]')).toHaveCount(index === 2 ? 1 : 0);
      await expect(card.locator('[data-reading="free"]')).toContainText('47 GiB');
    }
  });

  test('HAR-10 browser runtime wait follows polling and disambiguates duplicate Ready labels',async({page})=>{
    await page.clock.install();let ready=false;
    await fixturePage(page,{'/api/models':()=>{
      const data=models();data.activations=[{metadata:{name:'fixture-runtime',uid:'fixture-runtime-uid',generation:1},
        spec:{type:'local',enabled:true,targetNamespace:'ai',local:{engine:'OLlama',computeTarget:'amd-gpu',
          url:'ollama://fixture:small',contextWindow:1024,maxNumSeqs:1,memoryRequiredMi:8200}},
        status:{phase:ready ? 'Ready' : 'Starting',observedGeneration:1}}];return data;
    }});
    await page.goto(origin+'/#/models');
    await expect(page.getByRole('progressbar',{name:'Starting model runtime'})).toBeVisible();
    const waiting=installedReadyUi(page,'fixture-runtime');ready=true;await page.clock.fastForward(16_000);await waiting;
    expect(await page.getByText('Ready',{exact:true}).count()).toBe(2);
  });
  test('HW-03 HW-08 browser distinguishes unknown driver/resource facts and refuses stale physical verification',evidenceAnnotations(
    {id:'HW-03',variant:'p3-readiness',layer:'B'},{id:'HW-08',variant:'p3-identity',layer:'B'}),async ({page}) => {
    const writes = await hardware(page);
    await page.getByText('GPU Configuration NVIDIA',{exact:true}).click();
    const gpu = page.getByRole('region',{name:'GPU NVIDIA Fixture GPU · 0000:02:00.0'});
    await expect(gpu.getByText('Not verified',{exact:true})).toBeVisible();
    await expect(gpu.getByText('Not ready',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Verify Ollama'})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Verify vLLM'})).toBeDisabled(); expect(writes).toEqual([]);
  });
  test('MEM-04 browser gives slots and non-additive memory pools separate denominators',evidenceAnnotations(
    {id:'MEM-04',variant:'p3-memory-denominators',layer:'B'}),async ({page}) => {
    await fixturePage(page,{'/api/models':models(1)}); await page.goto(origin+'/#/models');
    const gauge = page.getByRole('article',{name:'AMD Fixture GPU memory'});
    await expect(gauge.getByText('1 / 2 free',{exact:true})).toBeVisible();
    expect(await gauge.locator('[data-slot="free"]').count()).toBe(1);
    await expect(gauge.locator('[data-reading="shared-free"]')).toContainText('29 GiB');
    await expect(gauge.locator('[data-reading="shared-unreserved"]')).toContainText('13 GiB');
    const progress = Number((await gauge.locator('[data-ring="shared-free"] .gauge-progress').getAttribute('stroke-dasharray'))!.split(' ')[0]);
    expect(progress).toBeCloseTo(30003/(108*1024)*100,3);
    await expect(gauge.locator('[data-reading="dedicated-free"]')).toContainText('—');
  });
  test('MEM-08 browser never replaces unavailable telemetry with another node or full capacity',evidenceAnnotations(
    {id:'MEM-08',variant:'p3-memory-unknown',layer:'B'}),async ({page}) => {
    const data = models(); data.computeMemory!.devices![0]!.metricsAvailable = false;
    data.computeMemory!.devices![0]!.freeMi = null; data.computeMemory!.sharedPools = [];
    await fixturePage(page,{'/api/models':data}); await page.goto(origin+'/#/models');
    const gauge = page.getByRole('article',{name:'AMD Fixture GPU memory'});
    await expect(gauge.locator('[data-ring="shared-free"]')).toHaveAttribute('data-known','false');
    await expect(gauge.locator('[data-reading="shared-free"]')).toContainText('—');
    await expect(gauge.locator('[data-ring="shared-free"] .gauge-progress')).toHaveCount(0);
  });
} else {
  test('SHR-03 browser opts into NVIDIA card selection through one confirmed provider backend change',evidenceAnnotations(
    {id:'SHR-03',variant:'p4-nvidia-dra-handoff',layer:'B'}),async({page})=>{
    const states=providers();states[1]!.draAvailable=true;
    const writes=await hardware(page,states,devices.map(d=>({...d,hostDriverReady:true,resourceRegistered:true})));
    await page.getByText('GPU Configuration NVIDIA',{exact:true}).click();
    const section=page.getByLabel('NVIDIA GPU sharing');await section.locator('summary').click();
    const apply=section.getByRole('button',{name:'Apply NVIDIA sharing'});await expect(apply).toBeDisabled();
    await section.getByLabel('NVIDIA GPU allocation backend').selectOption('dra');await expect(apply).toBeEnabled();
    await apply.click();expect(writes).toEqual([]);
    await page.getByRole('dialog').getByRole('button',{name:'Apply and restart NVIDIA models'}).click();
    expect(writes).toEqual([expect.objectContaining({provider:'nvidia',allocationBackend:'dra',nodeUid:host.nodeUid,expectedRevision:'fixture-revision',acknowledgeRestart:true})]);
  });
  for(const viewport of ['desktop','mobile'] as const)test(`SLOT-05 SLOT-06 ${viewport} browser binds one of four NVIDIA cards, retains a full-card draft and releases exactly its slot`,evidenceAnnotations(
    {id:'SLOT-05',variant:'p4-nvidia-card-choice',layer:'B'},
    {id:'SLOT-06',variant:'p4-nvidia-card-release',layer:'B'}),async({page})=>{
    if(viewport === 'mobile')await page.setViewportSize({width:390,height:844});
    await page.clock.install();let free=1;const writes:unknown[]=[];
    await fixturePage(page,{'/api/models':()=>fourNvidiaCards([4,0,free,4]),
      '/api/model-discovery/popular':{provider:'huggingface',results:[],total:0},
      '/api/models/estimate-memory':{detectedModelType:'chat',minimumMi:1024,recommendedMi:2000,maximumMi:49152,confidence:'high'},
      '/api/models/local':(request:Request)=>{writes.push(request.postDataJSON());return {};}});
    await page.goto(origin+'/#/models');await page.getByRole('button',{name:'Create',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Create Model'});
    await dialog.getByLabel('Inference Engine').selectOption('VLLM');await dialog.getByLabel('Hardware').selectOption('nvidia-gpu');
    const cards=dialog.getByLabel('NVIDIA card');await expect(cards.locator('option')).toHaveCount(4);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(cards.getByRole('option',{name:/0000:02:00.0.*no free slots/})).toHaveAttribute('disabled','');
    const selectedKey=(await cards.getByRole('option',{name:/0000:03:00.0/}).getAttribute('value'))!;
    await cards.selectOption(selectedKey);
    await dialog.getByLabel('Model source').selectOption('direct');await dialog.getByLabel('Hugging Face URL').fill('hf://fixture/model');
    const add=dialog.getByRole('button',{name:'Add Local Model'});await expect(add).toBeEnabled();
    free=0;await page.clock.fastForward(16_000);await expect(add).toBeDisabled();
    await expect(cards).toHaveValue(selectedKey);
    await expect(dialog.getByLabel('Hugging Face URL')).toHaveValue('hf://fixture/model');expect(writes).toEqual([]);
    free=1;await page.clock.fastForward(16_000);await expect(add).toBeEnabled();await add.click();
    await expect(dialog).not.toBeVisible();
    expect(writes).toEqual([expect.objectContaining({local:expect.objectContaining({gpuDevice:nvidiaSelection(2)})})]);
  });
  test('SLOT-07 browser edits a full NVIDIA card using only its own allocation and keeps sibling cards disabled',evidenceAnnotations(
    {id:'SLOT-07',variant:'p4-nvidia-card-edit',layer:'B'}),async({page})=>{
    const data=fourNvidiaCards([0,0,0,0]);const writes:unknown[]=[];
    data.activations=[{metadata:{name:'fixture-model',resourceVersion:'9'},spec:{type:'local',enabled:true,targetNamespace:'ai',
      local:{engine:'VLLM',computeTarget:'nvidia-gpu',url:'hf://fixture/model',gpuDevice:nvidiaSelection(2),
        vramMi:8192,contextWindow:4096,maxNumSeqs:1,kvCacheType:'auto'}},status:{phase:'Ready'}}];
    await fixturePage(page,{'/api/models':data,
      '/api/models/fixture-model/estimate-memory':{minimumMi:1024,recommendedMi:2000,maximumMi:49152,confidence:'high'},
      '/api/models/fixture-model':(request:Request)=>{writes.push(request.postDataJSON());return {};}});
    await page.goto(origin+'/#/models');await page.getByRole('button',{name:'Edit fixture-model'}).click();
    const dialog=page.getByRole('dialog',{name:'Edit Model · fixture-model'}),cards=dialog.getByLabel('NVIDIA card');
    await expect(cards.getByRole('option',{name:/0000:03:00.0.*1\/4 slots free/})).not.toHaveAttribute('disabled');
    await expect(cards.getByRole('option',{name:/0000:04:00.0.*no free slots/})).toHaveAttribute('disabled','');
    await dialog.getByLabel('Context Size').fill('8192');await dialog.getByRole('button',{name:'Save changes'}).click();
    await expect(dialog).not.toBeVisible();expect(writes).toEqual([{expectedRevision:'9',local:{contextWindow:8192}}]);
  });
  test('SHR-01 SHR-02 browser reads exclusive defaults and enables only a valid dirty change behind confirmation',evidenceAnnotations(
    {id:'SHR-01',variant:'p4-defaults',layer:'B'},{id:'SHR-02',variant:'p4-dirty-confirmation',layer:'B'}),async ({page}) => {
    const writes = await hardware(page,providers(),devices.map(d=>({...d,hostDriverReady:true,resourceRegistered:true})));
    for (const vendor of ['AMD','NVIDIA']) {
      await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      const section = page.getByLabel(`${vendor} GPU sharing`); await section.locator('summary').click();
      const mode = section.getByLabel(`${vendor} allocation mode`),apply = section.getByRole('button',{name:`Apply ${vendor} sharing`});
      await expect(mode).toHaveValue('exclusive'); await expect(apply).toBeDisabled();
      await mode.selectOption('shared'); await expect(apply).toBeEnabled();
      await mode.selectOption('exclusive'); await expect(apply).toBeDisabled();
      await mode.selectOption('shared'); await apply.click();
      const dialog = page.getByRole('dialog'); await expect(dialog).toContainText(/restart|interrupt/);
      expect(writes).toEqual([]); await dialog.getByRole('button',{name:'Cancel'}).click();
    }
    expect(writes).toEqual([]);
  });
  test('SHR-08 browser invalid sharing count is disabled without a request',evidenceAnnotations(
    {id:'SHR-08',variant:'p4-invalid-intent',layer:'B'}),async ({page})=>{
    const writes=await hardware(page,providers(),devices.map(d=>({...d,hostDriverReady:true,resourceRegistered:true})));
    for(const vendor of ['AMD','NVIDIA']) {
      await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      const section=page.getByLabel(`${vendor} GPU sharing`);await section.locator('summary').click();
      await section.getByLabel(`${vendor} allocation mode`).selectOption('shared');
      await section.getByLabel(`${vendor} maximum simultaneous models`).fill('17');
      await expect(section.getByRole('button',{name:`Apply ${vendor} sharing`})).toBeDisabled();
    }
    expect(writes).toEqual([]);
  });
  test('SHR-08 SHR-09 SHR-11 browser blocks invalid counts and unavailable/custom sharing rather than adopting them',evidenceAnnotations(
    {id:'SHR-08',variant:'p4-invalid-intent',layer:'B'},{id:'SHR-09',variant:'p4-custom-config',layer:'B'},
    {id:'SHR-11',variant:'p4-dra-unavailable',layer:'B'}),async ({page}) => {
    const states = providers(); states[0]!.available = false; states[0]!.phase = 'Blocked'; states[0]!.reason = 'DRA identity is missing.';
    states[1]!.available = false; states[1]!.managed = false; states[1]!.reason = 'Custom plugin profile cannot be adopted.';
    const writes = await hardware(page,states);
    for (const vendor of ['AMD','NVIDIA']) {
      await page.getByText(`GPU Configuration ${vendor}`,{exact:true}).click();
      const section = page.getByLabel(`${vendor} GPU sharing`); await section.locator('summary').click();
      // Playwright's enabled predicate does not model native <option disabled>.
      // Assert the browser's native selection constraint, not button semantics.
      await expect(section.getByRole('option',{name:'Shared · multiple models'})).toHaveAttribute('disabled','');
      await expect(section.getByRole('button',{name:`Apply ${vendor} sharing`})).toBeDisabled();
    }
    expect(writes).toEqual([]);
  });
  test('SLOT-05 browser refresh preserves the selected GPU and draft while blocking exhausted slots',evidenceAnnotations(
    {id:'SLOT-05',variant:'p4-draft-refresh',layer:'B'}),async ({page}) => {
    await page.clock.install(); let free = 1; const writes:unknown[] = [];
    await fixturePage(page,{'/api/models':() => models(free),'/api/model-discovery/popular':{provider:'huggingface',results:[],total:0},
      '/api/models/estimate-memory':{detectedModelType:'chat',minimumMi:1024,recommendedMi:2000,maximumMi:110000,confidence:'high'},
      '/api/models/local':(request:Request) => {writes.push(request.postDataJSON()); return {};}});
    await page.goto(origin+'/#/models'); await page.getByRole('button',{name:'Create',exact:true}).click();
    const dialog = page.getByRole('dialog',{name:'Create Model'});
    await dialog.getByLabel('Inference Engine').selectOption('VLLM'); await dialog.getByLabel('Hardware').selectOption('amd-gpu');
    await dialog.getByLabel('Model source').selectOption('direct'); await dialog.getByLabel('Hugging Face URL').fill('hf://fixture/model');
    await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeEnabled();
    free = 0; await page.clock.fastForward(16_000);
    await expect(dialog.getByLabel('Hardware')).toHaveValue('amd-gpu');
    await expect(dialog.getByLabel('Hugging Face URL')).toHaveValue('hf://fixture/model');
    await expect(dialog.getByRole('button',{name:'Add Local Model'})).toBeDisabled();
    await expect(dialog.getByText(/No free GPU model slots/)).toBeVisible(); expect(writes).toEqual([]);
  });
}
