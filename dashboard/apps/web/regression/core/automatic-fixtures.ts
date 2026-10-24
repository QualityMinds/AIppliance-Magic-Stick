import type {ManagedHost,NetworkSettings,HostOperationRequest} from '@magicstick/dashboard-contracts';
import type {LabConfig,GpuLabProfile,GpuModelFixture,RuntimeModelFixture} from './config.ts';
import {catalogFixture,preparedProfile,type PreparationSnapshot,type PreparationOptions} from './input-preparation.ts';
import {labPolicy} from './lab-policy.ts';
import type {HostDrillRecipes} from './host-drill-recipes.ts';
import {requireSafe} from './errors.ts';
import {moduleResourceLinks} from '@magicstick/dashboard-core';
import {realtimeRegressionEnabled} from './engine-policy.ts';

/** Choose test fixtures from the deployed product catalog, including its small
 * CPU text fixtures for compatible GPU runtimes. No user-maintained model list. */
export function automaticGpuProfile(snapshot:PreparationSnapshot,_defaults:Record<string,any>):GpuLabProfile|undefined {
  const devices=Object.values(snapshot.status.hardwareOperators ?? {}).flatMap(item=>item.devices ?? []);
  const host=snapshot.hosts.filter(h=>h.available && snapshot.nodes.some(n=>n.metadata.uid === h.nodeUid))
    .sort((a,b)=>a.name.localeCompare(b.name)).find(h=>devices.some(d=>d.nodeUid === h.nodeUid && ['amd','nvidia'].includes(d.vendor)));
  if(!host)return;
  const profile:GpuLabProfile={selection:'available-providers',acknowledgeSharingTransitions:true,
    nodeName:host.name,nodeUid:host.nodeUid,bootId:host.bootId,sharedSlots:2,devices:{},models:{}};
  for(const provider of ['amd','nvidia'] as const) {
    const selected=devices.filter(d=>d.nodeUid === host.nodeUid && d.vendor === provider);
    // AMD currently requires one physical device; NVIDIA sharing is node-wide
    // and the MGPU workflow independently chooses every exact DRA card.
    if(!selected.length || provider === 'amd' && selected.length !== 1)continue;
    profile.devices[provider]={id:selected[0]!.id,pciAddress:selected[0]!.pciAddress};
    const target=`${provider}-gpu` as const,capability=snapshot.models.computeTargets.targets.find(t=>t.id === target);
    for(const engine of ['OLlama','VLLM'] as const) {
      if(!capability?.available || !capability.engines?.includes(engine) || capability.engineAvailability?.[engine]?.available === false)continue;
      const options=[catalogFixture(snapshot.models,engine,target),catalogFixture(snapshot.models,engine,'cpu')].filter(Boolean) as RuntimeModelFixture[];
      const chosen=options.sort((a,b)=>a.memoryRequiredMi-b.memoryRequiredMi)[0];if(!chosen)continue;
      const caches=(capability.kvCacheTypes?.[engine] ?? []).map(c=>c.value),preferred=engine === 'OLlama' ? 'q8_0' : 'fp8';
      const cache=caches.includes(preferred) ? preferred : caches.includes('auto') ? 'auto' : caches[0];if(!cache)continue;
      profile.models[`${provider}${engine === 'OLlama' ? 'Ollama' : 'Vllm'}` as keyof GpuLabProfile['models']]={...chosen,
        computeTarget:target,kvCacheType:cache,contextWindow:Math.min(1024,chosen.contextWindow),
        memoryRequiredMi:Math.ceil(chosen.memoryRequiredMi/100)*100,automaticSizing:true} as GpuModelFixture;
    }
  }
  return Object.keys(profile.devices).length ? profile : undefined;
}

export function automaticProfile(snapshot:PreparationSnapshot,previous:Record<string,any>,lab:LabConfig) {
  const options:PreparationOptions={phases:[...labPolicy.phases],approve:[...labPolicy.scopes] as PreparationOptions['approve'],independentRecovery:false};
  const profile=preparedProfile({},snapshot,options);
  profile.unmanagedKey={approveDisposableProbe:true,createDisposableFixture:true};
  // Instance-provider bases can be intentionally empty (Odysseus/Pi); group
  // "apps" alone does not promise a standalone service. Prefer a disabled
  // standalone module, otherwise borrow an actual routed service. The workflow
  // additionally refuses any module used by a saved application instance.
  const instanceModules=new Set(Object.values(snapshot.modules.catalogJson?.applications ?? {}).flatMap(item=>item.requiredModules ?? []));
  const optional=Object.entries(snapshot.modules.catalogJson?.modules ?? {}).filter(([id,item])=>item.activationMode === 'moduleactivation' && item.group==='apps' &&
    snapshot.modules.modules[id] && !/identity|dashboard|basis|kubeai|gpu|amd|nvidia|intel|litellm|private-mesh|model-catalog|magicstick-operator|regression/.test(id) &&
    (snapshot.modules.modules[id]?.enabled === true ? moduleResourceLinks(id,item,snapshot.status).length > 0 : !instanceModules.has(id)))
    .sort(([a],[b])=>Number(snapshot.modules.modules[a]?.enabled)-Number(snapshot.modules.modules[b]?.enabled) || a.localeCompare(b))[0];
  if(optional)profile.modules={approveOptionalModule:true,id:optional[0],parameters:snapshot.modules.modules[optional[0]]?.parameters ?? {}};
  const compatibility=snapshot.status.hardwareOperators?.['amd-gpu']?.compatibility;
  const currentProfile=compatibility?.selectedProfile ?? '',amdProfiles=compatibility?.profiles ?? [];
  // The UI's empty value is the real "Upstream operator rules only" choice,
  // not a missing fixture. Never borrow an unknown current override that the
  // advertised profile validator could not restore afterwards.
  const alternate=(!currentProfile || amdProfiles.some(p=>p.id===currentProfile)) ?
    amdProfiles.filter(p=>p.id!==currentProfile).sort((a,b)=>a.id.localeCompare(b.id))[0] ??
      (currentProfile ? {id:'',experimental:false} : undefined) : undefined;
  const amdPin=lab.gpu?.devices.amd;
  const eligibleAmd=amdPin && Object.values(snapshot.status.hardwareOperators ?? {}).flatMap(item=>item.devices ?? []).some(device=>
    device.vendor==='amd' && device.id===amdPin.id && device.pciAddress===amdPin.pciAddress && device.nodeUid===lab.gpu!.nodeUid &&
    device.node===lab.gpu!.nodeName && device.eligible===true);
  if(alternate && eligibleAmd)profile.moduleProfile={approveTemporaryProfile:true,profileId:alternate.id,allowExperimental:alternate.experimental === true};
  else delete profile.moduleProfile;
  // Repository-owned semantic adapter. It inspects actual app controls and
  // does not ask the operator to invent CSS selectors for every run.
  const suffix=new URL(lab.dashboardUrl).hostname;
  profile.applications={cleanerKubeconfig:'/inputs/app-cleaner.kubeconfig',fixtures:
    Object.keys(snapshot.modules.catalogJson?.applications ?? {}).filter(type=>['openclaw','hermes','paperclip','kubeopencode','odysseus'].includes(type))
      .map(type=>({type,originTemplate:`https://{name}.${type}.${suffix}/`,adapter:'semantic-chat-v1',responseMarker:'REGRESSION'}))};
  profile.kubernetes.plugin={filename:'/inputs/kubectl-oidc_login',sha256:previous.kubernetes?.plugin?.sha256 ?? ''};
  if(previous.federation?.upstream && previous.federation?.brokerCleaner)profile.federation={...previous.federation,approveDisposableProviders:true};
  if(previous.mesh?.peerConfig)profile.mesh={...previous.mesh,approveTwoAppliances:true,approveGpuTransitions:true};
  for(const key of ['securityCi','companion'])if(snapshot.ci?.[key])profile[key]={...snapshot.ci[key],...(previous[key]?.tokenFile ? {tokenFile:previous[key].tokenFile} : {})};
  const profiles=snapshot.models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {};
  const candidates=(snapshot.models.computeTargets.realtimeDevices ?? []).filter(d=>realtimeRegressionEnabled() && d.supported && d.node === lab.gpu?.nodeName &&
    profiles[d.profile]?.gpuCounts.includes(1) && ['nvidia-gpu','amd-gpu'].includes(d.computeTarget ?? '')).sort((a,b)=>
    Number(profiles[a.profile]?.defaultSystemMemoryMi)-Number(profiles[b.profile]?.defaultSystemMemoryMi));
  const device=candidates[0],capability=device && profiles[device.profile];
  if(device && capability && capability.defaultSystemMemoryMi <= Number(device.systemMemoryMi) && Number(device.gpuMemoryMi) > 0) {
    const context=Math.min(1024,capability.defaultContextWindow,capability.maxContextWindow ?? 1024);
    const fixture={engine:'VLLM',computeTarget:device.computeTarget,url:'hf://'+capability.model,memoryRequiredMi:capability.defaultSystemMemoryMi,
      contextWindow:context,maxNumSeqs:1,realtime:{profile:device.profile,gpuNode:device.node,gpuCount:1,
        gpuMemoryFraction:0.8,systemMemoryMi:capability.defaultSystemMemoryMi,thinkerCpuOffloadGiB:0}};
    profile.realtime={approveGpuTransitions:true,fixtures:['exclusive','shared'].map(mode=>({mode,maxModels:2,fixture:structuredClone(fixture)}))};
  }
  return profile;
}

/** Fresh typed host recipes. No prompts, shell commands or claimed physical
 * power controller. Forced outage/power-loss and unavailable alternate software
 * revisions remain real external prerequisites, not mock live passes. */
export function automaticHostRecipes(lab:LabConfig,host:ManagedHost):HostDrillRecipes {
  requireSafe(host.available && lab.expected.nodes.some(n=>n.uid === host.nodeUid && n.bootId === host.bootId),'HOST');
  const result:HostDrillRecipes={version:2,applianceUid:lab.expected.applianceUid,nodeName:host.name,nodeUid:host.nodeUid,
    approveDestructive:true,independentRecoveryAvailable:true,cases:{}};
  const add=(id:string,recipe:Partial<HostOperationRequest>,expected:Record<string,any>)=>{
    result.cases[id]={recipe:{allowExperimental:false,experimentMode:false,...recipe},expected:
      {kernel:host.kernel,terminal:'Succeeded',bootChanges:0,...expected} as HostDrillRecipes['cases'][string]['expected']};
  };
  add('BOOT-02',{action:'reboot'},{bootChanges:1});
  if(lab.gpu?.devices.amd && lab.gpu.devices.nvidia && lab.gpu.models.amdOllama && lab.gpu.models.nvidiaVllm)
    add('BOOT-03',{action:'reboot'},{bootChanges:1});
  if(host.plan?.state === 'ready' || host.plan?.state === 'available') {
    const plan=host.plan;for(const id of ['HOST-04','HOST-05'])add(id,{action:'prepare-gpu',allowExperimental:plan.experimental},
      {kernel:plan.targetKernel,bootChanges:plan.rebootRequired ? 1 : 0});
  }
  const memory=host.gpuMemory;
  if(memory?.supported && [memory.systemMemoryMi,memory.currentCarveoutMi,memory.currentCarveoutIndex,
      memory.currentDynamicLimitMi,memory.stepMi,memory.minDynamicLimitMi].every(Number.isSafeInteger) &&
      Number(memory.stepMi) > 0 && Number(memory.minDynamicLimitMi) > 0) {
    const current=memory.currentDynamicLimitMi!,step=memory.stepMi!,minimum=memory.minDynamicLimitMi!;
    const reserve=Math.max(16384,memory.systemReserveMi ?? 16384);
    const maximum=(sizeMi:number)=>Math.floor((memory.systemMemoryMi!+memory.currentCarveoutMi!-sizeMi-reserve)/step)*step;
    const fixed=memory.options?.find(option=>option.index === memory.currentCarveoutIndex && option.sizeMi === memory.currentCarveoutMi);
    if(fixed) {
      const dynamic=current-step >= minimum ? current-step : current+step <= maximum(fixed.sizeMi) ? current+step : undefined;
      if(dynamic !== undefined && dynamic <= maximum(fixed.sizeMi)) {
        const recipe={action:'configure-gpu-memory' as const,allowExperimental:true,
          gpuMemory:{carveoutIndex:fixed.index,dynamicLimitMi:dynamic}};
        const expected={bootChanges:1,dynamicLimitMi:dynamic,carveoutMi:fixed.sizeMi};
        add('GPUHOST-05',recipe,expected);
        if(lab.gpu?.devices.nvidia && lab.gpu.models.nvidiaVllm)add('GPUHOST-07',recipe,expected);
      }
      // Change only a nearby advertised firmware reservation while retaining
      // the active TTM limit. The owning worker then needs exactly one reboot.
      const alternate=memory.options?.filter(option=>option.index !== fixed.index && Number.isSafeInteger(option.sizeMi) &&
        current+step <= maximum(option.sizeMi)).sort((a,b)=>Math.abs(a.sizeMi-fixed.sizeMi)-Math.abs(b.sizeMi-fixed.sizeMi))[0];
      if(alternate)add('GPUHOST-06',{action:'configure-gpu-memory',allowExperimental:true,
        gpuMemory:{carveoutIndex:alternate.index,dynamicLimitMi:current}},
        {bootChanges:1,dynamicLimitMi:current,carveoutMi:alternate.sizeMi});
    }
  }
  if(host.modelCache?.supported && !host.modelCache.blocked) {
    const cacheIds=host.modelCache.caches.filter(c=>c.clearable && ['ollama','huggingface'].includes(c.id)).map(c=>c.id);
    if(cacheIds.length)for(const id of ['CACHE-04','CACHE-06'])add(id,{action:'clear-model-cache'}, {freeCacheIds:cacheIds});
  }
  const iface=host.network?.interfaces.find(i=>i.kind === 'ethernet' && i.editable && i.configuredMode && i.addresses.length &&
    (i.configuredMode === 'dhcp' || i.configuredAddress));
  if(host.network?.supported && iface) {
    const network:NetworkSettings={interface:iface.name,mode:iface.configuredMode!,metric:Math.min(65535,(iface.metric ?? 100)+1),dns:iface.dns ?? [],
      ...(iface.configuredMode === 'static' ? {address:iface.configuredAddress,gateway:iface.configuredGateway} : {})};
    add('NET-05',{action:'configure-network',network},{ipv4:iface.addresses.filter(a=>/^\d+\./.test(a))});
    add('NET-06',{action:'configure-network',network},{terminal:'RolledBack',ipv4:iface.addresses.filter(a=>/^\d+\./.test(a))});
  }
  if(host.updates?.supported && !host.updates.busy && Number(host.updates.securityCount) > 0 && !host.updates.rebootRequired)
    add('UPD-05',{action:'install-updates',updateScope:'security'},{});
  return result;
}
