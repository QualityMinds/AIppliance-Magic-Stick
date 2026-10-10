import {useEffect, useState} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  initialLocalModelDraft, localModelChanges, localModelConfigurationPolicy, localModelCreatePayload,
  modelEditRevision, normalizeHuggingFaceReference, realtimeDefaultRam, formatMi,
} from '@magicstick/dashboard-core';
import type {LocalModelDraft, LocalModelSource, MemoryEstimate, ModelActivation, ModelsPayload, RealtimeConfiguration, RealtimeDevice} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {Button, ErrorNotice, Field, Panel} from './components';
import {useCpuSettings} from './CpuSettings';
import {useVllmDeploymentSettings} from './VllmDeploymentSettings';
import {AdvancedModelSettings} from './AdvancedModelSettings';
import {ModelSourceSettings, useModelDiscovery} from './ModelSourceSettings';
import {EstimatePanel, EstimateBreakdown, GpuDeploymentSelect, MultiGpuSettings, roundMemory} from './ModelMemorySettings';
import {sharedSlotPools, slotsFull, targetSlots} from './GpuSlots';
import {NvidiaGpuGroupSelect, matchingNvidiaCards, nvidiaCardKey} from './NvidiaGpuSelect';
import {nvidiaPhysicalCapacityMi} from './NvidiaGpuSelection';
import {MemoryInfo, unreservedCalculation} from './MemoryInfo';

type StandardDraft = Extract<LocalModelDraft, {kind: 'standard'}>;
const fallbackKvCacheOptions = (engine: string) => engine === 'OLlama'
  ? [{value: 'f16', label: 'Standard - F16', description: 'Highest cache precision.'}]
  : [{value: 'auto', label: 'Standard - model precision', description: 'Uses the model precision selected by vLLM.'}];

export const LocalModelConfigurationForm = ({models, activation, onClose, onSaved}: {
  models: ModelsPayload; activation?: ModelActivation; onClose: () => void; onSaved: () => Promise<void>;
}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const hasRealtime = Object.keys(models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {}).length > 0;
  const displayName = (engine: string) => engine === 'VLLM-Omni' ? 'vLLM-Omni' : models.computeTargets.engineCatalog?.[engine]?.displayName ?? engine;
  const engineOptions = [...new Set([
    ...Object.keys(models.computeTargets.engineCatalog ?? {}),
    ...availableTargets.flatMap((target) => target.declaredEngines ?? target.engines ?? []),
  ])].flatMap((engine) => engine === 'VLLM' && hasRealtime ? [engine, 'VLLM-Omni'] : [engine])
    .sort((a, b) => Number(a === 'VLLM-Omni') - Number(b === 'VLLM-Omni') || displayName(a).localeCompare(displayName(b), 'en', {sensitivity: 'base'}));
  const [selectedEngine, setEngine] = useState(models.computeTargets.defaultEngine && engineOptions.includes(models.computeTargets.defaultEngine) ? models.computeTargets.defaultEngine : engineOptions[0] ?? 'VLLM');
  const [name, setName] = useState('');
  const [source, setSource] = useState<LocalModelSource>('search');
  const engine = activation ? activation.spec?.local?.realtime ? 'VLLM-Omni' : String(activation.spec?.local?.engine ?? activation.status?.engine ?? 'VLLM')
    : engineOptions.includes(selectedEngine) ? selectedEngine : engineOptions[0] ?? 'VLLM';
  return <>
    {!activation && <Field label="Inference Engine"><select value={engine} onChange={(event) => setEngine(event.target.value)}>
      {engineOptions.map((item) => <option key={item} value={item}>{item === 'VLLM-Omni' ? '(Experimental) ' : ''}{displayName(item)}</option>)}
    </select></Field>}
    <LocalModelConfigurationEditor key={activation?.metadata?.uid ?? activation?.metadata?.name ?? engine}
      models={models} activation={activation} engine={engine} name={name} source={source} onSource={setSource} onName={setName} onClose={onClose} onSaved={onSaved} />
  </>;
};

/** One draft, one submit path and one form for all local engines and both modes. */
const LocalModelConfigurationEditor = ({models, activation, engine, name, source, onSource, onName, onClose, onSaved}: {
  models: ModelsPayload; activation?: ModelActivation; engine: string; name: string; onName: (name: string) => void;
  source: LocalModelSource; onSource: (source: LocalModelSource) => void;
  onClose: () => void; onSaved: () => Promise<void>;
}) => {
  const [initialActivation] = useState(activation);
  const editing = Boolean(initialActivation);
  const local = initialActivation?.spec?.local;
  const [initial] = useState(() => {
    const value = initialLocalModelDraft(models, engine, initialActivation, name);
    const policy = localModelConfigurationPolicy(models, value.engine, value.kind === 'omni' ? value.realtime.profile : undefined);
    return {...value, source: policy.sources.includes(source) ? source : policy.sources[0] ?? 'direct'};
  });
  const [draft, setDraft] = useState<LocalModelDraft>(initial);
  const update = (patch: Partial<Pick<LocalModelDraft, 'name' | 'url' | 'computeTarget' | 'modelType' | 'contextWindow' | 'maxNumSeqs' | 'maxOutputTokens'>>) => setDraft((current) => ({...current, ...patch}));
  const updateStandard = (patch: Partial<StandardDraft>) => setDraft((current) => current.kind === 'standard' ? {...current, ...patch} : current);
  const updateRealtime = (patch: Partial<RealtimeConfiguration>) => setDraft((current) => current.kind === 'omni' ? {...current, realtime: {...current.realtime, ...patch}} : current);
  const omni = draft.kind === 'omni';
  const standard = draft.kind === 'standard' ? draft : undefined;
  const initialStandard = initial.kind === 'standard' ? initial : undefined;
  const config = draft.kind === 'omni' ? draft.realtime : undefined;
  const initialConfig = initial.kind === 'omni' ? initial.realtime : undefined;
  const profiles = models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {};
  const profileId = config?.profile ?? '';
  const profile = profiles[profileId];
  const devices = (models.computeTargets.realtimeDevices ?? []).filter((item) => item.profile === profileId
    && (!editing || !item.computeTarget || item.computeTarget === initial.computeTarget));
  const device = devices.find((item) => item.node === config?.gpuNode);
  const computeTarget = omni && !editing ? device?.computeTarget ?? profile?.computeTargets?.[0] ?? draft.computeTarget : draft.computeTarget;
  const policy = localModelConfigurationPolicy(models, draft.engine, profileId || undefined);
  const availableTargets = models.computeTargets.targets.filter((target) => target.available || editing && target.id === computeTarget);
  const targetSupportsEngine = (target: typeof availableTargets[number], candidate: string) => (target.engines ?? []).includes(candidate)
    || (target.declaredEngines ?? []).includes(candidate) || Boolean(target.engineAvailability?.[candidate]);
  const targetEngineAvailable = (target: typeof availableTargets[number] | undefined) => Boolean(target)
    && (target?.engineAvailability?.[draft.engine]?.available ?? target?.engines?.includes(draft.engine) ?? false);
  const targets = availableTargets.filter((target) => targetSupportsEngine(target, draft.engine));
  const selectedTarget = availableTargets.find((target) => target.id === computeTarget);
  const cpuSettings = useCpuSettings(local?.cpuResources, models, draft.engine, computeTarget);
  const deploymentSettings = useVllmDeploymentSettings(local?.vllm, models, omni ? '' : draft.engine, computeTarget);
  const discovery = useModelDiscovery(models, draft, setDraft, policy, computeTarget, editing, onName);

  const cards = (models.computeMemory?.devices ?? []).filter((item) => computeTarget === 'nvidia-gpu' && item.gpuDevice && item.slots?.scope === 'device');
  const gpuKeys = standard?.gpuDevices.map(nvidiaCardKey) ?? [];
  const ownKeys = initialStandard?.gpuDevices.map(nvidiaCardKey) ?? [];
  const ownActive = editing && initialActivation?.spec?.enabled !== false;
  const selectedCards = gpuKeys.flatMap((key) => cards.filter((item) => nvidiaCardKey(item.gpuDevice!) === key));
  const card = selectedCards[0];
  const gpuCount = Math.max(1, selectedCards.length);
  const replicated = standard?.gpuDeployment === 'replicated';
  const multiGpu = models.computeTargets.engineCatalog?.[draft.engine]?.multiGpu;
  const gpuPayload = selectedCards.length > 1 ? {gpuDevices: selectedCards.map((item) => item.gpuDevice!), gpuDeployment: standard?.gpuDeployment}
    : card ? {gpuDevice: card.gpuDevice, gpuDeployment: standard?.gpuDeployment} : {};
  const cardRequired = !omni && computeTarget === 'nvidia-gpu' && (cards.length > 0 || gpuKeys.length > 0);
  const noCardSlot = cardRequired && (!card || selectedCards.length !== gpuKeys.length || selectedCards.some((item) =>
    (item.slots?.free ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(item.gpuDevice!)) ? 1 : 0) <= 0 || item !== card && !matchingNvidiaCards(card, item)));
  const noSlots = !omni && (noCardSlot || !editing && slotsFull(selectedTarget, draft.engine));
  const engineUnavailable = !omni && !editing && !targetEngineAvailable(selectedTarget);
  const automaticGpuPool = !omni && computeTarget === 'nvidia-gpu' && sharedSlotPools(models.computeMemory?.devices ?? []).some((pool) =>
    pool.deviceIds.some((id) => models.computeMemory?.devices?.some((item) => item.id === id && item.computeTarget === computeTarget)));
  const advertisedKvCache = selectedTarget?.kvCacheTypes?.[draft.engine] ?? fallbackKvCacheOptions(draft.engine);
  const kvCacheOptions = editing && initialStandard && !advertisedKvCache.some((item) => item.value === initialStandard.kvCacheType)
    ? [{value: initialStandard.kvCacheType, label: `Current - ${initialStandard.kvCacheType}`, description: 'Currently stored value.'}, ...advertisedKvCache] : advertisedKvCache;
  const kvValues = kvCacheOptions.map((item) => item.value).join(',');
  useEffect(() => {
    if (!editing && standard && !kvValues.split(',').includes(standard.kvCacheType)) updateStandard({kvCacheType: kvValues.split(',')[0] || (draft.engine === 'OLlama' ? 'f16' : 'auto')});
  }, [computeTarget, editing, kvValues, standard?.kvCacheType]);
  useEffect(() => {
    if (editing || omni) return;
    updateStandard({cpuOffloading: false});
  }, [computeTarget, editing, omni]);

  const [taskDetection, setTaskDetection] = useState<{url: string; value?: 'chat' | 'embedding' | null}>({url: ''});
  const [manualTask, setManualTask] = useState({url: '', value: ''});
  const detectedTask = discovery.presetTask || (taskDetection.url === draft.url ? taskDetection.value : '') || '';
  const modelType = omni ? 'chat' : editing ? draft.modelType : detectedTask || (manualTask.url === draft.url ? manualTask.value : '');
  const requestedModelType = editing ? draft.modelType : discovery.presetTask || (detectedTask ? 'auto' : manualTask.url === draft.url && manualTask.value || 'auto');
  const [createEstimate, setCreateEstimate] = useState<MemoryEstimate>();
  const [offloadEstimate, setOffloadEstimate] = useState<MemoryEstimate>();
  const [estimateError, setEstimateError] = useState<unknown>(null);
  const [offloadError, setOffloadError] = useState<unknown>(null);
  const [hostMemoryEdited, setHostMemoryEdited] = useState(false);
  const selectedMi = standard?.selectedMi ?? 100, hostMemoryMi = standard?.hostMemoryMi ?? 16400;
  const cpuOffloading = standard?.cpuOffloading ?? false;
  const supportsOffloading = !omni && computeTarget === 'nvidia-gpu';
  const gpuKey = gpuKeys.join(','), parallelism = standard?.parallelism ?? 'auto', gpuDeployment = standard?.gpuDeployment ?? 'single';
  const estimateQuery = useQuery({
    queryKey: ['model-edit-estimate', initial.name, modelType, draft.contextWindow, draft.maxOutputTokens, draft.maxNumSeqs, standard?.kvCacheType, selectedMi, cpuOffloading, gpuKey, parallelism, gpuDeployment],
    queryFn: () => api.estimateModelUpdate(initial.name, {
      modelType, contextWindow: draft.contextWindow, maxOutputTokens: draft.maxOutputTokens ? Number(draft.maxOutputTokens) : null,
      maxNumSeqs: draft.maxNumSeqs, kvCacheType: standard?.kvCacheType, cpuOffloading,
      ...(computeTarget === 'cpu' ? {memoryRequiredMi: selectedMi} : {vramMi: selectedMi}),
      ...(card ? {gpuDevice: null, gpuDevices: null, ...gpuPayload} : gpuKey !== ownKeys.join(',') ? {gpuDevice: null, gpuDevices: null, gpuDeployment: null} : {}),
      ...(draft.engine === 'VLLM' && (gpuCount > 1 || ownKeys.length > 1) ? {vllm: gpuCount > 1 && !replicated ? {parallelism} : null} : {}),
    }), enabled: editing && !omni && Boolean(initial.name), retry: false, placeholderData: (previous) => previous,
  });
  const estimate = editing ? estimateQuery.data : createEstimate;
  const targetDevices = card ? selectedCards : models.computeMemory?.devices?.filter((item) => item.computeTarget === computeTarget || item.id === computeTarget) ?? [];
  const capacities = [...targetDevices.map((item) => gpuCount > 1 && typeof item.unreservedMi === 'number'
    ? Math.min(item.unreservedMi, nvidiaPhysicalCapacityMi(item) ?? 0) : item.unreservedMi), ...(cardRequired ? [] : [estimate?.maximumMi])]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const fallbackAvailable = card ? Math.min(...targetDevices.map((item) => Number(item.unreservedMi ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(item.gpuDevice!)) ? initialStandard!.selectedMi : 0)))
    : targetDevices.reduce((maximum, item) => Math.max(maximum, Number(item.unreservedMi ?? 0)), 0) + (initialStandard?.selectedMi ?? 0);
  const capacityKnown = editing ? typeof estimate?.maximumMi === 'number' || fallbackAvailable > (initialStandard?.selectedMi ?? 0)
    : capacities.length > 0 && (!cardRequired || capacities.length === selectedCards.length);
  const availableMi = editing ? typeof estimate?.maximumMi === 'number' ? estimate.maximumMi : fallbackAvailable
    : capacityKnown ? cardRequired ? Math.min(...capacities) : Math.max(...capacities) : 0;

  useEffect(() => {
    if (editing || omni) return;
    setEstimateError(null);
    if (!draft.url) {setCreateEstimate(undefined); return;}
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine: draft.engine, computeTarget, url: draft.url, contextWindow: draft.contextWindow,
          maxNumSeqs: draft.maxNumSeqs, modelType: requestedModelType, kvCacheType: standard?.kvCacheType, ...gpuPayload,
          ...(gpuCount > 1 && !replicated && draft.engine === 'VLLM' ? {vllm: {parallelism}} : {})});
        if (!cancelled) {
          setCreateEstimate(result); setTaskDetection({url: draft.url, value: result.detectedModelType});
          const maximum = capacityKnown ? Math.max(100, Math.floor(availableMi / 100) * 100) : roundMemory(result.recommendedMi);
          setDraft((current) => current.kind === 'standard' ? {...current, selectedMi: Math.min(maximum, cpuOffloading ? current.selectedMi : roundMemory(result.recommendedMi))} : current);
        }
      } catch (reason) {if (!cancelled) setEstimateError(reason);}
    }, 350);
    return () => {cancelled = true; window.clearTimeout(timer);};
  }, [editing, omni, computeTarget, draft.contextWindow, draft.engine, standard?.kvCacheType, draft.maxNumSeqs, requestedModelType, draft.url, cpuOffloading, gpuKey, parallelism, gpuDeployment]);
  useEffect(() => {setHostMemoryEdited(false);}, [computeTarget, draft.url]);
  useEffect(() => {
    if (editing || omni) return;
    setOffloadEstimate(undefined); setOffloadError(null);
    if (!cpuOffloading || !supportsOffloading || !draft.url) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine: draft.engine, computeTarget, url: draft.url, contextWindow: draft.contextWindow,
          maxNumSeqs: draft.maxNumSeqs, modelType: requestedModelType, kvCacheType: standard?.kvCacheType, cpuOffloading: true, vramMi: selectedMi,
          ...gpuPayload, ...(gpuCount > 1 && !replicated && draft.engine === 'VLLM' ? {vllm: {parallelism}} : {})});
        if (!cancelled) {setOffloadEstimate(result); setTaskDetection({url: draft.url, value: result.detectedModelType});}
      } catch (reason) {if (!cancelled) setOffloadError(reason);}
    }, 350);
    return () => {cancelled = true; window.clearTimeout(timer);};
  }, [editing, omni, cpuOffloading, supportsOffloading, draft.engine, computeTarget, draft.url, draft.contextWindow, draft.maxNumSeqs, requestedModelType, standard?.kvCacheType, selectedMi, gpuKey, parallelism, gpuDeployment]);
  const activeEstimate = cpuOffloading ? editing ? estimate : offloadEstimate : estimate;
  const offload = cpuOffloading ? activeEstimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor((offload?.ramMaximumMi ?? 0) / 100) * 100);
  useEffect(() => {if (!editing && !hostMemoryEdited && offload) updateStandard({hostMemoryMi: roundMemory(offload.ramRecommendedMi)});}, [editing, offload, hostMemoryEdited]);
  const memoryRisks = activeEstimate ? [
    ...(activeEstimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(selectedMi < roundMemory(activeEstimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ] : [];
  const hasMemoryRisk = !omni && memoryRisks.length > 0;
  const invalidBudget = !omni && ((!editing && !selectedTarget) || noSlots || engineUnavailable || (cardRequired && gpuDeployment !== 'single' && gpuCount < 2)
    || !Number.isInteger(selectedMi) || selectedMi < 100 || ((editing ? selectedMi !== initialStandard?.selectedMi : true) && selectedMi % 100 !== 0)
    || ((cpuOffloading || gpuCount > 1) && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < (gpuCount > 1 ? 1100 : 100)
      || ((editing ? hostMemoryMi !== initialStandard?.hostMemoryMi : true) && hostMemoryMi % 100 !== 0)))
    || (gpuCount > 1 && (selectedCards.some((item) => selectedMi > Number(nvidiaPhysicalCapacityMi(item) ?? 0))
      || (typeof activeEstimate?.systemMemoryMaximumMi === 'number' && hostMemoryMi > activeEstimate.systemMemoryMaximumMi))));

  const free = (item: RealtimeDevice) => item.computeTarget === 'cpu' ? 1 : Math.min(item.slotCount ?? item.gpuCount, item.freeGpuCount
    + (ownActive && initialConfig?.gpuNode === item.node ? initialConfig.gpuCount : 0));
  const shared = device?.allocationMode === 'time-slicing' || device?.allocationMode === 'dra-shared';
  const maxGpuCount = device ? Math.min(free(device), device.maxGpuCount ?? device.gpuCount) : 0;
  const cpu = computeTarget === 'cpu';
  const canonicalUrl = omni ? normalizeHuggingFaceReference(draft.url) : draft.url;
  const imageMissing = omni && !config?.runtimeImage && profile?.image === '';
  const integer = (value: number, minimum: number, maximum = 2147483647) => Number.isInteger(value) && value >= minimum && value <= maximum;
  const invalidRealtime = omni && (!profile || !device?.supported || !config || !integer(config.gpuCount, 1, maxGpuCount)
    || !profile.gpuCounts.includes(config.gpuCount) || !integer(config.thinkerCpuOffloadGiB, 0)
    || !integer(config.systemMemoryMi, 1, device?.systemMemoryMi ?? 0) || !Number.isFinite(config.gpuMemoryFraction)
    || config.gpuMemoryFraction <= 0 || config.gpuMemoryFraction > 1);
  const recommendedRam = config ? Math.max((config.thinkerCpuOffloadGiB + 4) * 1024,
    device?.gpuAllocationMode === 'shared-gtt' ? Math.floor(device.gpuMemoryMi * config.gpuMemoryFraction) * config.gpuCount + (profile?.hostRuntimeHeadroomMi ?? 8192) : 0) : 0;
  const modelError = omni && !canonicalUrl ? new Error('Enter hf://organization/model, organization/model, or a Hugging Face repository URL.') : null;
  const invalid = invalidBudget || invalidRealtime || imageMissing || cpuSettings.invalid || deploymentSettings.invalid || !canonicalUrl || !modelType
    || !integer(draft.contextWindow, 1) || !integer(draft.maxNumSeqs, 1)
    || (!omni && draft.maxOutputTokens !== '' && !integer(Number(draft.maxOutputTokens), 1))
    || (editing && !modelEditRevision(initialActivation!)) || !draft.name.trim();
  const serializationOptions = {cpuResources: cpuSettings.payload, cpuChanged: cpuSettings.changed, vllm: deploymentSettings.payload,
    deploymentChanged: deploymentSettings.changed, allowMemoryRisk: hasMemoryRisk, initialAllowMemoryRisk: local?.allowMemoryRisk === true};
  const effectiveDraft = {...draft, computeTarget};
  const changes = editing ? localModelChanges(initial, effectiveDraft, serializationOptions) : {};
  const changed = !editing || Object.keys(changes).length > 0;
  const busy = editing && !omni && (estimateQuery.isFetching || estimateQuery.isError);
  const mutation = useMutation({
    mutationFn: () => {
      if (invalid || !changed || busy) throw new Error('Check the model configuration and available resources before saving.');
      return editing ? api.updateModel(initial.name, {expectedRevision: modelEditRevision(initialActivation!), local: changes})
        : api.createLocalModel(localModelCreatePayload({...effectiveDraft, modelType: detectedTask && !omni ? 'auto' : modelType}, serializationOptions));
    }, onSuccess: async () => {await onSaved(); onClose();},
  });
  const selectProfile = (id: string) => {
    const nextProfile = profiles[id], nextDevice = models.computeTargets.realtimeDevices?.find((item) => item.profile === id && item.supported && item.freeGpuCount > 0);
    setDraft((current) => current.kind === 'omni' ? {...current, contextWindow: nextProfile?.defaultContextWindow ?? 8192, maxNumSeqs: 1,
      url: current.url === `hf://${profile?.model}` ? `hf://${nextProfile?.model ?? ''}` : current.url,
      realtime: {profile: id, gpuNode: nextDevice?.node ?? '', gpuCount: 1, systemMemoryMi: realtimeDefaultRam(nextProfile, nextDevice), gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0}} : current);
  };
  const selectGpuKeys = (keys: string[]) => updateStandard({gpuDevices: keys.flatMap((key) => cards.filter((item) => nvidiaCardKey(item.gpuDevice!) === key).map((item) => item.gpuDevice!)),
    gpuDeployment: keys.length > 1 && gpuDeployment === 'single' ? 'split' : keys.length === 1 && gpuDeployment === 'split' ? 'single' : gpuDeployment});
  const selectHardware = (target: string) => {
    const first = models.computeMemory?.devices?.find((item) => target === 'nvidia-gpu' && item.gpuDevice && item.slots?.scope === 'device' && (item.slots.free ?? 0) > 0);
    updateStandard({computeTarget: target, gpuDevices: first?.gpuDevice ? [first.gpuDevice] : [], gpuDeployment: 'single', parallelism: 'auto'});
  };

  return <form className="stack" aria-label="Local model configuration" onSubmit={(event) => {event.preventDefault(); if (!invalid && changed && !busy && !mutation.isPending) mutation.mutate();}}>
    {editing && <div className="tag-list"><span className="tag">Model: {initial.name}</span><span className="tag">Engine: {omni ? 'vLLM-Omni' : draft.engine}</span><span className="tag">Compute: {computeTarget}</span><span className="tag">Source unchanged</span></div>}
    <div className="form-grid">
      <Field label="Name"><input value={draft.name} disabled={editing} required onChange={(event) => {update({name: event.target.value}); onName(event.target.value);}} /></Field>
      {omni && <Field label="Realtime profile"><select value={profileId} disabled={editing} onChange={(event) => selectProfile(event.target.value)}>{Object.entries(profiles).map(([id, item]) => <option key={id} value={id}>{item.displayName}</option>)}</select></Field>}
    </div>
    {omni && <div className="tag-list"><span className="tag">Engine: vLLM-Omni</span><span className="tag">WebSocket /v1/realtime</span><span className="tag" title={profile?.description} tabIndex={0}>Experimental runtime ⓘ</span></div>}
    <ModelSourceSettings draft={draft} setDraft={setDraft} policy={policy} discovery={discovery} editing={editing} onSource={onSource} onName={onName} defaultUrl={omni ? `hf://${profile?.model ?? ''}` : undefined} />
    <ErrorNotice error={modelError} />
    {!omni && !editing && <Field label="Hardware"><select value={computeTarget} aria-describedby={noSlots ? 'model-slots-full' : undefined} onChange={(event) => selectHardware(event.target.value)}>
      {!computeTarget && <option value="" disabled>No hardware with free slots</option>}
      {targets.map((target) => {const slots = targetSlots(target, draft.engine), available = targetEngineAvailable(target); return <option key={target.id} value={target.id} disabled={!available || slotsFull(target, draft.engine)}>{target.displayName ?? target.id}{!available ? ` · unavailable: ${target.engineAvailability?.[draft.engine]?.message ?? 'engine is not eligible'}` : slots ? slots.free === 0 ? ` · no free slots (${slots.used}/${slots.total} occupied)` : ` · ${slots.free}/${slots.total} slots free` : ''}</option>;})}
    </select></Field>}
    {cardRequired && <>
      {multiGpu?.computeTargets.includes(computeTarget) && <GpuDeploymentSelect mode={gpuDeployment} count={gpuCount} replication={multiGpu.deploymentModes?.includes('replicated') ?? false} onChange={(mode) => {updateStandard({gpuDeployment: mode, ...(mode === 'single' ? {gpuDevices: standard!.gpuDevices.slice(0, 1)} : {})});}} />}
      <NvidiaGpuGroupSelect cards={cards} values={gpuKeys} onChange={selectGpuKeys} ownKeys={ownKeys} ownActive={ownActive} allowAutomatic={editing && selectedTarget?.available === true && !cards.length}
        maximum={multiGpu?.computeTargets.includes(computeTarget) ? multiGpu.maxDevices : 1} replicated={replicated} />
    </>}
    {noSlots && <p id="model-slots-full" className="notice notice-warn" role="status">{editing ? 'No free slot on the selected NVIDIA card.' : 'No free GPU model slots. Remove a model or change GPU sharing in System > Hardware.'}</p>}
    {automaticGpuPool && <p className="notice" role="status">Automatic GPU assignment: this hardware choice selects a node scheduling pool, not an individual card. Enable NVIDIA DRA card selection in System &gt; Hardware to choose a specific card.</p>}
    {engineUnavailable && <p className="notice notice-warn" role="status">{selectedTarget?.engineAvailability?.[draft.engine]?.message ?? `${draft.engine} is not available on the selected hardware.`}</p>}
    {omni && config && <section className="stack compact" aria-label="Hardware configuration"><div className="form-grid">
      <Field label="Compute node"><select value={config.gpuNode} onChange={(event) => updateRealtime({gpuNode: event.target.value, gpuCount: 1})}>
        {!config.gpuNode && <option value="" disabled>Select a compute node</option>}
        {devices.map((item, index) => <option key={item.node || `unavailable-${index}`} value={item.node} disabled={!item.supported || free(item) < 1}>{item.node} · {item.name} · {item.supported ? item.computeTarget === 'cpu' ? 'CPU' : `${free(item)} free GPU slot${free(item) === 1 ? '' : 's'}${item.allocationMode && item.allocationMode !== 'exclusive' ? ` · ${item.allocationMode === 'dra-shared' ? 'DRA' : 'Time-slicing'}` : ''}` : item.reason}</option>)}
      </select></Field>
      {!cpu && <Field label="GPUs"><select value={config.gpuCount} onChange={(event) => updateRealtime({gpuCount: Number(event.target.value)})}>{(profile?.gpuCounts ?? [1]).map((count) => <option key={count} value={count} disabled={count > maxGpuCount}>{count} GPU{count === 1 ? `${shared ? ' · shared slot' : ''} · all stages` : 's · thinker / audio stages'}</option>)}</select></Field>}
    </div>
      {device && <div className="tag-list">{!cpu && <span className="tag">{device.gpuAllocationMode === 'shared-gtt' ? 'Shared GPU capacity' : 'VRAM per GPU'}: {device.gpuMemoryMi ? formatMi(device.gpuMemoryMi) : 'unknown'}</span>}<span className="tag">Allocatable RAM: {formatMi(device.systemMemoryMi)}</span></div>}
      {shared && <span className="tag" tabIndex={0} title="GPU memory and compute are shared with other models, without isolated VRAM limits. Leave room for other workloads; concurrent models can run out of memory or slow down.">Shared GPU · no VRAM isolation ⓘ</span>}
      {!devices.some((item) => item.supported && free(item) > 0) && <p className="notice notice-warn" role="status">No available compute slot. Check the device reason and GPU sharing in System → Hardware.</p>}
    </section>}
    {!omni && !editing && draft.url && <section className="stack compact" aria-label="Model task detection">
      {detectedTask ? <p role="status">Model task: <strong>{detectedTask === 'chat' ? 'Chat' : 'Embedding'}</strong> · detected automatically</p>
        : taskDetection.url === draft.url || estimateError ? <><Field label="Model task"><select value={manualTask.url === draft.url ? manualTask.value : ''} required onChange={(event) => setManualTask({url: draft.url, value: event.target.value})}>
          <option value="">Select the model task</option><option value="chat">Chat</option><option value="embedding">Embedding</option>
        </select></Field><p className="muted">The model metadata does not identify its task. Choose Chat for text generation or Embedding for document search.</p></>
        : <p role="status">Detecting model task…</p>}
    </section>}
    <section className="form-grid" aria-label="Runtime configuration">
      {!omni && editing && <Field label="Type"><select value={draft.modelType} onChange={(event) => update({modelType: event.target.value})}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field>}
      <Field label="Context Size"><input type="number" min="1" max="2147483647" value={draft.contextWindow} onChange={(event) => update({contextWindow: Number(event.target.value)})} /></Field>
      <Field label={omni ? 'Concurrent sessions' : 'Max Num Seqs'}><input type="number" min="1" max="2147483647" value={draft.maxNumSeqs} onChange={(event) => update({maxNumSeqs: Number(event.target.value)})} /></Field>
      {!omni && policy.maxOutputTokens && <Field label="Max Output Tokens"><input type="number" min="1" value={draft.maxOutputTokens} placeholder="Runtime default" onChange={(event) => update({maxOutputTokens: event.target.value})} /></Field>}
      {!omni && <Field label="KV Cache"><select value={standard?.kvCacheType} onChange={(event) => updateStandard({kvCacheType: event.target.value})}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field>}
    </section>
    {standard && <section className="stack compact" aria-label="Memory configuration">
      <p className="muted">{kvCacheOptions.find((option) => option.value === standard.kvCacheType)?.description} Attention-cache values are recalculated immediately; recurrent state and runtime reserve remain separate.</p>
      {editing && estimateQuery.isPending && <p role="status">Recalculating memory…</p>}
      {gpuCount > 1 && <p role="status">VRAM per GPU: {formatMi(selectedMi)} · {gpuCount} GPUs · {formatMi(selectedMi * gpuCount)} planned total. The smallest selected card limits this control.</p>}
      <EstimatePanel estimate={activeEstimate ?? estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={(value) => updateStandard({selectedMi: value})}
        hideBreakdown={cpuOffloading} preserveSelectedMi={editing ? initialStandard?.selectedMi : undefined} budgetDevices={replicated ? 1 : gpuCount} />
      {supportsOffloading && <Panel title="CPU offloading" className="nested-panel">
        <label className="check-field"><input type="checkbox" checked={cpuOffloading} onChange={(event) => updateStandard({cpuOffloading: event.target.checked})} />Use additional system RAM</label>
        <p className="muted">Stores part of the model in this GPU node's RAM. This can run larger models, but may substantially reduce response speed. No disk swap or RAM from another node is used.</p>
        {cpuOffloading && <>
          {!offload && !offloadError && <p role="status">Calculating the RAM / VRAM allocation…</p>}
          {offload && <section className="estimate stack compact">
            <header><strong>Host RAM reservation</strong><p className="muted">Includes offloading and runtime</p></header>
            <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Host RAM minimum" value={formatMi(offload.ramMinimumMi)} calculation={activeEstimate?.calculations?.ramMinimumMi} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Host RAM recommended" value={formatMi(offload.ramRecommendedMi)} calculation={activeEstimate?.calculations?.ramRecommendedMi} /></strong></div><div><span>100% unreserved on an eligible GPU node</span><strong><MemoryInfo label="Unreserved host RAM" value={offload.ramMaximumMi === null ? 'Unknown' : formatMi(hostMaximum)} calculation={unreservedCalculation(offload.ramMaximumMi)} /></strong></div></div>
            <input aria-label="Host RAM reservation" type="range" min="100" step="100" max={Math.max(100, hostMaximum)} value={Math.min(Math.max(100, hostMaximum), hostMemoryMi)} disabled={!hostMaximum} onChange={(event) => {setHostMemoryEdited(true); updateStandard({hostMemoryMi: Number(event.target.value)});}} />
            <Field label="Host RAM budget (MiB)"><input type="number" min="100" step={editing && hostMemoryMi === initialStandard?.hostMemoryMi ? 1 : 100} value={hostMemoryMi} onChange={(event) => {setHostMemoryEdited(true); updateStandard({hostMemoryMi: Number(event.target.value)});}} /></Field>
            <Button type="button" onClick={() => {setHostMemoryEdited(false); updateStandard({hostMemoryMi: roundMemory(offload.ramRecommendedMi)});}}>Use recommended RAM allocation</Button>
            <p className="muted">The GPU budget above is preserved. Kubernetes reserves this host RAM on the same node as the GPU; the estimate uses the largest eligible node, not a cluster-wide sum.</p>
            {draft.engine === 'OLlama' && <p className="muted">Ollama always uses GPU-first auto-fit and places as many layers in actual free VRAM as possible. The selected values remain planning and Kubernetes host-memory budgets; the loaded model's effective split is shown separately.</p>}
          </section>}
          {activeEstimate && <EstimateBreakdown estimate={activeEstimate} budgetDevices={replicated ? 1 : gpuCount} />}
        </>}
        <ErrorNotice error={offloadError} />
      </Panel>}
    </section>}
    {omni && config && <section className="stack compact" aria-label="Memory configuration">
      <Field label="System RAM (MiB)"><input type="number" min="1" max={device?.systemMemoryMi} step="1" value={config.systemMemoryMi} onChange={(event) => updateRealtime({systemMemoryMi: Number(event.target.value)})} /></Field>
      {!cpu && <><Field label="GPU memory budget"><input type="range" min=".01" max="1" step=".01" value={config.gpuMemoryFraction} onChange={(event) => updateRealtime({gpuMemoryFraction: Number(event.target.value)})} /></Field>
        <span title="Split between thinker, talker and codec stages; a planning budget, not an isolated VRAM limit or a guarantee that the model fits." tabIndex={0}>{Math.round(config.gpuMemoryFraction * 100)}% per GPU ⓘ</span></>}
      {!invalidRealtime && config.systemMemoryMi < recommendedRam && <span className="tag" tabIndex={0} title={`Estimated RAM including offloading and shared GPU memory: ${formatMi(recommendedRam)}. This estimate does not block experimental deployment; insufficient RAM can cause OOM.`}>RAM below planning estimate ⓘ</span>}
    </section>}
    <AdvancedModelSettings cpuSettings={cpuSettings} deploymentSettings={omni ? undefined : deploymentSettings}>
      {standard && <MultiGpuSettings count={gpuCount} engine={draft.engine} strategy={parallelism} onStrategy={(value) => updateStandard({parallelism: value})} ramMi={hostMemoryMi} onRam={(value) => updateStandard({hostMemoryMi: value})}
        offloading={cpuOffloading} ramMaximumMi={activeEstimate?.systemMemoryMaximumMi} replicated={replicated} />}
      {omni && config && <>
        <Field label="Runtime image (optional)"><input value={config.runtimeImage ?? ''} placeholder={profile?.image || 'registry/image:tag'} onChange={(event) => updateRealtime({runtimeImage: event.target.value.trim() || undefined})} /></Field>
        {!cpu && <Field label="Thinker CPU offload (GiB)"><input type="number" min="0" max="2147483647" value={config.thinkerCpuOffloadGiB} onChange={(event) => updateRealtime({thinkerCpuOffloadGiB: Number(event.target.value)})} /></Field>}
      </>}
    </AdvancedModelSettings>
    {imageMissing && <p className="notice notice-warn" role="status">Choose a backend-compatible runtime image in Advanced.</p>}
    {invalidRealtime && config?.gpuNode && <p className="notice notice-warn" role="alert">Check available slots, positive numeric settings and the node's RAM capacity.</p>}
    {hasMemoryRisk && <div id="model-memory-risk" className="notice notice-warn" role="note"><strong>{editing ? 'Memory warning — this change can still be applied.' : 'Memory warning — you can still try to start this model.'}</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul>{!editing && <p>Adding it accepts this risk. The pod may remain Pending, fail with out-of-memory errors or restart. Requests and limits stay at your selected budgets; a successful start is not guaranteed.</p>}</div>}
    {editing && <p className="muted">Saving reconciles the model runtime. The Pod may restart while the new parameters are applied.</p>}
    <ErrorNotice error={estimateError ?? (editing && !omni ? estimateQuery.error : null) ?? mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} aria-describedby={[noSlots ? 'model-slots-full' : '', hasMemoryRisk ? 'model-memory-risk' : ''].filter(Boolean).join(' ') || undefined}
        disabled={mutation.isPending || invalid || !changed || busy}>{hasMemoryRisk && <span aria-hidden="true">⚠ </span>}{mutation.isPending ? 'Saving…' : editing ? 'Save changes' : omni ? 'Add Realtime Model' : 'Add Local Model'}</Button>
    </div>
  </form>;
};
