// The local model configuration form, for adding and editing a local model: one draft,
// one submit path and one form for all local engines and both modes, exactly like
// apps/web/src/LocalModelConfigurationForm.tsx with ModelSourceSettings, CpuSettings,
// VllmDeploymentSettings, NvidiaGpuSelect and ModelMemorySettings. React effects become
// keyed reactions that run when the dialog is rebuilt.
import {
  formatBytes, formatMi, initialLocalModelDraft, localModelChanges, localModelConfigurationPolicy, localModelCreatePayload,
  matchingVariants, modelEditRevision, modelNameError, normalizeHuggingFaceReference, realtimeDefaultRam, safeModelName, selectedArtifact,
} from '@magicstick/dashboard-core';
import type {
  ComputeMemoryDevice, ComputeTarget, CpuResources, DiscoveryItem, GpuDeployment, KvCacheOption, LocalModelDraft, LocalModelSource,
  MemoryEstimate, ModelActivation, ModelArtifact, ModelsPayload, ModelVariant, NvidiaGpuSelection, RealtimeConfiguration, RealtimeDevice,
  VllmConfiguration,
} from '@magicstick/dashboard-contracts';
import type {TuiContext} from './tui-context';
import type {DialogItem, DialogSpec, InlineButton} from './tui-dialogs';
import {
  breakdownItems, estimatePanelItems, quantizationText, roundMemory, sharedSlotPools, slotsFull, systemMemoryItems, targetSlots, unreservedCalculation, showCalculations,
} from './tui-model-memory';

type StandardDraft = Extract<LocalModelDraft, {kind: 'standard'}>;
type Parallelism = NonNullable<VllmConfiguration['parallelism']>;
type VisionAttention = NonNullable<VllmConfiguration['visionAttention']>;

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const integer = (value: number, minimum: number, maximum = 2147483647) => Number.isInteger(value) && value >= minimum && value <= maximum;

// ---------------------------------------------------------------- NVIDIA card selection (NvidiaGpuSelection.ts)

/** Includes the installation identity: a replacement node must require a new choice. */
export const nvidiaCardKey = (selection: NvidiaGpuSelection) => `${selection.nodeUid}/${selection.uuid}`;
export const nvidiaPhysicalCapacityMi = (card: Pick<ComputeMemoryDevice, 'gpuCapacityMi' | 'gpuCapacitySource' | 'totalMi'>) =>
  card.gpuCapacitySource === 'nvidia-dra-inventory' ? card.gpuCapacityMi : card.totalMi;
/** UI eligibility only; the API/controller repeat the current inventory check. */
export const nvidiaCardMismatch = (a: ComputeMemoryDevice, b: ComputeMemoryDevice): string | undefined => {
  if (!a.gpuDevice?.nodeUid || !b.gpuDevice?.nodeUid || !a.gpuDevice.nodeName || !b.gpuDevice.nodeName) return 'GPU node identity could not be verified';
  if (a.gpuDevice.nodeUid !== b.gpuDevice.nodeUid || a.gpuDevice.nodeName !== b.gpuDevice.nodeName) return 'Requires GPUs on the same node';
  const aInventory = a.gpuCapacitySource === 'nvidia-dra-inventory', bInventory = b.gpuCapacitySource === 'nvidia-dra-inventory';
  if (aInventory !== bInventory) return 'GPU inventory capacity could not be verified';
  const aCapacity = nvidiaPhysicalCapacityMi(a), bCapacity = nvidiaPhysicalCapacityMi(b);
  if (typeof aCapacity !== 'number' || !Number.isFinite(aCapacity) || aCapacity <= 0
    || typeof bCapacity !== 'number' || !Number.isFinite(bCapacity) || bCapacity <= 0) return 'Physical GPU capacity could not be verified';
  return undefined;
};

const fallbackKvCacheOptions = (engine: string): KvCacheOption[] => engine === 'OLlama'
  ? [{value: 'f16', label: 'Standard - F16', description: 'Highest cache precision.'}]
  : [{value: 'auto', label: 'Standard - model precision', description: 'Uses the model precision selected by vLLM.'}];

const engineDisplayName = (models: ModelsPayload, engine: string) => engine === 'VLLM-Omni' ? 'vLLM-Omni' : models.computeTargets.engineCatalog?.[engine]?.displayName ?? engine;

/** The engines the create form offers, in the browser's order (vLLM-Omni last, as an experimental option). */
export const engineOptions = (models: ModelsPayload) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const hasRealtime = Object.keys(models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {}).length > 0;
  return [...new Set([
    ...Object.keys(models.computeTargets.engineCatalog ?? {}),
    ...availableTargets.flatMap((target) => target.declaredEngines ?? target.engines ?? []),
  ])].flatMap((engine) => engine === 'VLLM' && hasRealtime ? [engine, 'VLLM-Omni'] : [engine])
    .sort((a, b) => Number(a === 'VLLM-Omni') - Number(b === 'VLLM-Omni') || engineDisplayName(models, a).localeCompare(engineDisplayName(models, b), 'en', {sensitivity: 'base'}));
};

const cpuDraft = (value: unknown) => {
  const policy = value as Partial<CpuResources> | undefined;
  return {
    request: typeof policy?.requestMillicores === 'number' ? String(policy.requestMillicores / 1000) : '',
    limit: typeof policy?.limitMillicores === 'number' ? String(policy.limitMillicores / 1000) : '',
  };
};
const validCpu = (value: string, minimum: number) => value === '' || (Number.isFinite(Number(value))
  && Number(value) >= minimum && Math.abs(Number(value) * 1000 - Math.round(Number(value) * 1000)) < 1e-8);

interface DiscoveryState {
  search: string;
  popular: DiscoveryItem[];
  results: DiscoveryItem[];
  artifacts: DiscoveryItem[];
  repo: string;
  artifactId: string;
  baseModel?: DiscoveryItem;
  cursor: string | null;
  artifactCursor: string | null;
  searching: boolean;
  loadingArtifacts: boolean;
  searched: boolean;
  error?: string;
  epoch: number;
  searchRequest: number;
  artifactRequest: number;
  lastSearch: string;
}

const freshDiscovery = (repository: boolean, search?: string): DiscoveryState => ({
  search: search ?? (repository ? 'Qwen3-Omni' : 'Qwen'), popular: [], results: [], artifacts: [], repo: '', artifactId: '',
  cursor: null, artifactCursor: null, searching: false, loadingArtifacts: false, searched: false, epoch: 0, searchRequest: 0, artifactRequest: 0, lastSearch: '',
});

export interface LocalModelForm {
  items: () => DialogItem[];
  submit: NonNullable<DialogSpec['submit']>;
}

const MODEL_FAMILIES = ['Qwen', 'DeepSeek', 'GLM', 'Llama', 'Gemma', 'Mistral'];

/** Splits inline buttons into rows that fit the dialog. */
export const buttonRows = (buttons: InlineButton[], width = 90): DialogItem[] => {
  const rows: InlineButton[][] = [];
  let row: InlineButton[] = [];
  let used = 0;
  for (const entry of buttons) {
    const size = Array.from(entry.label).length + 5;
    if (row.length && used + size > width) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(entry);
    used += size;
  }
  if (row.length) rows.push(row);
  return rows.map((items) => ({kind: 'buttons', items}));
};

/**
 * The add/edit form for a local model. `isOpen` tells asynchronous estimates and searches
 * whether the dialog still exists, so late responses never act on a closed form.
 */
export const localModelForm = (ctx: TuiContext, isOpen: () => boolean, activation?: ModelActivation): LocalModelForm => {
  const editing = Boolean(activation);
  const local = record(activation?.spec?.local);
  const models = () => ctx.snapshot().models;
  const options = engineOptions(models());
  const defaultEngine = models().computeTargets.defaultEngine;
  const form = {
    selectedEngine: defaultEngine && options.includes(defaultEngine) ? defaultEngine : options[0] ?? 'VLLM',
    name: '',
    source: 'search' as LocalModelSource,
  };
  const engineValue = () => activation ? (local.realtime ? 'VLLM-Omni' : String(local.engine ?? activation.status?.engine ?? 'VLLM'))
    : engineOptions(models()).includes(form.selectedEngine) ? form.selectedEngine : engineOptions(models())[0] ?? 'VLLM';

  // Everything below belongs to one engine; choosing another engine starts a fresh editor, as the browser remounts it.
  let initial!: LocalModelDraft;
  let draft!: LocalModelDraft;
  let cpu!: {initial: {request: string; limit: string}; draft: {request: string; limit: string}};
  let vision!: {initial: string; value: string};
  let discovery!: DiscoveryState;
  let reactions: Record<string, string> = {};
  let timers: Record<string, ReturnType<typeof setTimeout> | undefined> = {};
  const ui = {advanced: false, breakdown: false, ramBreakdown: false, offloadBreakdown: false};
  const estimates = {
    create: undefined as MemoryEstimate | undefined, offload: undefined as MemoryEstimate | undefined,
    edit: undefined as MemoryEstimate | undefined, editFetching: false, editError: undefined as string | undefined,
    error: undefined as string | undefined, offloadError: undefined as string | undefined, version: 0,
  };
  let taskDetection: {url: string; value?: 'chat' | 'embedding' | null} = {url: ''};
  let manualTask = {url: '', value: ''};
  let hostMemoryEdited = false;

  const redraw = () => { if (isOpen()) ctx.draw(); };
  const update = (patch: Partial<Pick<LocalModelDraft, 'name' | 'url' | 'computeTarget' | 'modelType' | 'contextWindow' | 'maxNumSeqs' | 'maxOutputTokens' | 'source' | 'presetId' | 'artifactId'>>) => {
    draft = {...draft, ...patch} as LocalModelDraft;
  };
  const updateStandard = (patch: Partial<StandardDraft>) => { if (draft.kind === 'standard') draft = {...draft, ...patch}; };
  const updateRealtime = (patch: Partial<RealtimeConfiguration>) => { if (draft.kind === 'omni') draft = {...draft, realtime: {...draft.realtime, ...patch}}; };
  const onName = (name: string) => { form.name = name; };

  const startEditor = () => {
    for (const timer of Object.values(timers)) if (timer) clearTimeout(timer);
    timers = {};
    reactions = {};
    const engine = engineValue();
    const value = initialLocalModelDraft(models(), engine, activation, form.name);
    const policy = localModelConfigurationPolicy(models(), value.engine, value.kind === 'omni' ? value.realtime.profile : undefined);
    initial = {...value, source: policy.sources.includes(form.source) ? form.source : policy.sources[0] ?? 'direct'};
    draft = structuredClone(initial);
    const cpuInitial = cpuDraft(local.cpuResources);
    cpu = {initial: cpuInitial, draft: {...cpuInitial}};
    const visionEngine = value.kind === 'omni' ? '' : value.engine;
    const definition = models().computeTargets.engineCatalog?.[visionEngine]?.deploymentSettings?.visionAttention;
    const savedVision = record(local.vllm).visionAttention as string | undefined;
    vision = {initial: savedVision ?? definition?.default ?? 'auto', value: savedVision ?? definition?.default ?? 'auto'};
    // A new engine starts a new discovery, as the browser remounts the editor with its own search state.
    discovery = {...freshDiscovery(policy.discovery === 'repository'), epoch: (discovery?.epoch ?? 0) + 1,
      searchRequest: (discovery?.searchRequest ?? 0) + 1, artifactRequest: (discovery?.artifactRequest ?? 0) + 1};
    Object.assign(estimates, {create: undefined, offload: undefined, edit: undefined, editFetching: false, editError: undefined, error: undefined, offloadError: undefined});
    taskDetection = {url: ''};
    manualTask = {url: '', value: ''};
    hostMemoryEdited = false;
  };
  startEditor();

  /** Everything the browser computes on each render. */
  const derive = () => {
    const payload = models();
    const omni = draft.kind === 'omni';
    const standard = draft.kind === 'standard' ? draft : undefined;
    const initialStandard = initial.kind === 'standard' ? initial : undefined;
    const config = draft.kind === 'omni' ? draft.realtime : undefined;
    const initialConfig = initial.kind === 'omni' ? initial.realtime : undefined;
    const profiles = payload.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {};
    const profileId = config?.profile ?? '';
    const profile = profiles[profileId];
    const devices = (payload.computeTargets.realtimeDevices ?? []).filter((item) => item.profile === profileId
      && (!editing || !item.computeTarget || item.computeTarget === initial.computeTarget));
    const device = devices.find((item) => item.node === config?.gpuNode && item.computeTarget === draft.computeTarget)
      ?? devices.find((item) => item.node === config?.gpuNode);
    const deviceChoice = (item: RealtimeDevice) => devices.filter((other) => other.node === item.node).length > 1 ? `${item.node}:${item.computeTarget}` : item.node;
    const computeTarget = omni && !editing ? device?.computeTarget ?? profile?.computeTargets?.[0] ?? draft.computeTarget : draft.computeTarget;
    const policy = localModelConfigurationPolicy(payload, draft.engine, profileId || undefined);
    const availableTargets = payload.computeTargets.targets.filter((target) => target.available || editing && target.id === computeTarget);
    const targetSupportsEngine = (target: ComputeTarget, candidate: string) => (target.engines ?? []).includes(candidate)
      || (target.declaredEngines ?? []).includes(candidate) || Boolean(target.engineAvailability?.[candidate]);
    const targetEngineAvailable = (target: ComputeTarget | undefined) => Boolean(target)
      && (target?.engineAvailability?.[draft.engine]?.available ?? target?.engines?.includes(draft.engine) ?? false);
    const targets = availableTargets.filter((target) => targetSupportsEngine(target, draft.engine));
    const selectedTarget = availableTargets.find((target) => target.id === computeTarget);

    // CpuSettings
    const cpuEngine = draft.engine;
    const cpuDefaults = payload.computeTargets.engineCatalog?.[cpuEngine]?.cpuDefaults?.[computeTarget === 'cpu' ? 'cpu' : 'gpu'];
    const cpuRequest = cpu.draft.request === '' ? cpuDefaults?.requestMillicores : Math.round(Number(cpu.draft.request) * 1000);
    const cpuLimit = cpu.draft.limit === '' ? cpuDefaults?.limitMillicores : Math.round(Number(cpu.draft.limit) * 1000);
    const cpuSettings = {
      defaults: cpuDefaults,
      changed: cpu.draft.request !== cpu.initial.request || cpu.draft.limit !== cpu.initial.limit,
      invalid: !validCpu(cpu.draft.request, 0.001) || !validCpu(cpu.draft.limit, 0)
        || (cpuRequest !== undefined && cpuLimit !== undefined && cpuLimit > 0 && cpuLimit < cpuRequest),
      payload: cpu.draft.request === '' && cpu.draft.limit === '' ? null : {
        ...(cpu.draft.request !== '' ? {requestMillicores: Math.round(Number(cpu.draft.request) * 1000)} : {}),
        ...(cpu.draft.limit !== '' ? {limitMillicores: Math.round(Number(cpu.draft.limit) * 1000)} : {}),
      },
    };
    // VllmDeploymentSettings
    const visionEngine = omni ? '' : draft.engine;
    const visionDefinition = payload.computeTargets.engineCatalog?.[visionEngine]?.deploymentSettings?.visionAttention;
    const visionAvailable = Boolean(visionDefinition?.computeTargets.includes(computeTarget));
    const deploymentSettings = {
      available: visionAvailable, definition: visionDefinition, automatic: visionDefinition?.default ?? 'auto', selection: `${visionEngine}|${computeTarget}`,
      changed: visionAvailable && vision.value !== vision.initial,
      invalid: visionAvailable && !visionDefinition?.options.some((option) => option.value === vision.value),
      payload: visionAvailable ? {visionAttention: vision.value as VisionAttention} : undefined,
    };

    // Model discovery
    const repository = policy.discovery === 'repository';
    const provider = payload.computeTargets.engineCatalog?.[draft.engine]?.urlScheme === 'ollama://' || draft.engine === 'OLlama' ? 'ollama' : 'huggingface';
    const presets = Object.entries(payload.presets ?? {}).flatMap(([id, preset]) => matchingVariants(preset.variants, draft.engine, computeTarget)
      .map((variant) => ({id, label: preset.displayName ?? id, variant, modelType: String(variant.modelType ?? preset.type ?? '')})));
    const preset = presets.find((item) => item.id === draft.presetId);
    const presetTask = draft.source === 'preset' && ['chat', 'embedding'].includes(preset?.modelType ?? '') ? preset!.modelType : '';

    // GPUs
    const allDevices = payload.computeMemory?.devices ?? [];
    const cards = allDevices.filter((item) => computeTarget === 'nvidia-gpu' && item.gpuDevice && item.slots?.scope === 'device');
    const gpuKeys = standard?.gpuDevices.map(nvidiaCardKey) ?? [];
    const ownKeys = initialStandard?.gpuDevices.map(nvidiaCardKey) ?? [];
    const ownActive = editing && activation?.spec?.enabled !== false;
    const selectedCards = gpuKeys.flatMap((key) => cards.filter((item) => nvidiaCardKey(item.gpuDevice!) === key));
    const card = selectedCards[0];
    const gpuCount = Math.max(1, selectedCards.length);
    const replicated = standard?.gpuDeployment === 'replicated';
    const multiGpu = payload.computeTargets.engineCatalog?.[draft.engine]?.multiGpu;
    const gpuPayload = selectedCards.length > 1 ? {gpuDevices: selectedCards.map((item) => item.gpuDevice!), gpuDeployment: standard?.gpuDeployment}
      : card ? {gpuDevice: card.gpuDevice, gpuDeployment: standard?.gpuDeployment} : {};
    const cardRequired = !omni && computeTarget === 'nvidia-gpu' && (cards.length > 0 || gpuKeys.length > 0);
    const noCardSlot = cardRequired && (!card || selectedCards.length !== gpuKeys.length || selectedCards.some((item) =>
      (item.slots?.free ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(item.gpuDevice!)) ? 1 : 0) <= 0 || item !== card && Boolean(nvidiaCardMismatch(card, item))));
    const noSlots = !omni && (noCardSlot || !editing && slotsFull(selectedTarget, draft.engine));
    const engineUnavailable = !omni && !editing && !targetEngineAvailable(selectedTarget);
    const automaticGpuPool = !omni && computeTarget === 'nvidia-gpu' && sharedSlotPools(allDevices).some((pool) =>
      pool.deviceIds.some((id) => allDevices.some((item) => item.id === id && item.computeTarget === computeTarget)));
    const advertisedKvCache = selectedTarget?.kvCacheTypes?.[draft.engine] ?? fallbackKvCacheOptions(draft.engine);
    const kvCacheOptions: KvCacheOption[] = editing && initialStandard && !advertisedKvCache.some((item) => item.value === initialStandard.kvCacheType)
      ? [{value: initialStandard.kvCacheType, label: `Current - ${initialStandard.kvCacheType}`, description: 'Currently stored value.'}, ...advertisedKvCache] : advertisedKvCache;

    const detectedTask = presetTask || (taskDetection.url === draft.url ? taskDetection.value ?? '' : '') || '';
    const modelType = omni ? 'chat' : editing ? draft.modelType : detectedTask || (manualTask.url === draft.url ? manualTask.value : '');
    const requestedModelType = editing ? draft.modelType : presetTask || (detectedTask ? 'auto' : manualTask.url === draft.url && manualTask.value || 'auto');
    const selectedMi = standard?.selectedMi ?? 100;
    const hostMemoryMi = standard?.hostMemoryMi ?? 16400;
    const cpuOffloading = standard?.cpuOffloading ?? false;
    const supportsOffloading = !omni && computeTarget === 'nvidia-gpu';
    const gpuKey = gpuKeys.join(',');
    const parallelism = standard?.parallelism ?? 'auto';
    const gpuDeployment = standard?.gpuDeployment ?? 'single';

    const estimate = editing ? estimates.edit : estimates.create;
    const targetDevices = card ? selectedCards : allDevices.filter((item) => item.computeTarget === computeTarget || item.id === computeTarget);
    const capacities = [...targetDevices.map((item) => gpuCount > 1 && typeof item.unreservedMi === 'number'
      ? Math.min(item.unreservedMi, nvidiaPhysicalCapacityMi(item) ?? 0) : item.unreservedMi), ...(cardRequired ? [] : [estimate?.maximumMi])]
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    const fallbackAvailable = card ? Math.min(...targetDevices.map((item) => Number(item.unreservedMi ?? 0) + (ownActive && ownKeys.includes(nvidiaCardKey(item.gpuDevice!)) ? initialStandard!.selectedMi : 0)))
      : targetDevices.reduce((maximum, item) => Math.max(maximum, Number(item.unreservedMi ?? 0)), 0) + (initialStandard?.selectedMi ?? 0);
    const rawCapacityKnown = editing ? typeof estimate?.maximumMi === 'number' || fallbackAvailable > (initialStandard?.selectedMi ?? 0)
      : capacities.length > 0 && (!cardRequired || capacities.length === selectedCards.length);
    const rawAvailableMi = editing ? typeof estimate?.maximumMi === 'number' ? estimate.maximumMi : fallbackAvailable
      : rawCapacityKnown ? cardRequired ? Math.min(...capacities) : Math.max(...capacities) : 0;
    const singleNvidia = !omni && computeTarget === 'nvidia-gpu' && gpuCount === 1;
    const physicalCapacities = targetDevices.map(nvidiaPhysicalCapacityMi);
    // Older APIs returned aggregate VRAM as maximumMi. Never let that enlarge a single-card control.
    const devicePhysicalMaximum = physicalCapacities.length && physicalCapacities.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
      ? Math.min(...physicalCapacities as number[]) : null;
    const estimatePhysicalMaximum = estimate?.physicalMaximumMi;
    const physicalMaximumMi = estimate && Object.hasOwn(estimate, 'physicalMaximumMi')
      ? typeof estimatePhysicalMaximum === 'number' && Number.isFinite(estimatePhysicalMaximum) && estimatePhysicalMaximum > 0
        ? Math.min(estimatePhysicalMaximum, devicePhysicalMaximum ?? estimatePhysicalMaximum) : null
      : devicePhysicalMaximum;
    const unreservedCapacities = targetDevices.map((item) => item.unreservedMi);
    const legacySingleMaximum = unreservedCapacities.length && unreservedCapacities.every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0)
      ? Math.max(...unreservedCapacities as number[]) : null;
    const singleMaximumMi = physicalMaximumMi ?? (estimate && Object.hasOwn(estimate, 'physicalMaximumMi') ? null : legacySingleMaximum);
    const capacityKnown = rawCapacityKnown && (!singleNvidia || typeof singleMaximumMi === 'number');
    const availableMi = capacityKnown ? singleNvidia ? Math.min(rawAvailableMi, singleMaximumMi!) : rawAvailableMi : 0;
    const exceedsPhysicalMemory = singleNvidia && typeof physicalMaximumMi === 'number' && selectedMi > physicalMaximumMi;

    const activeEstimate = cpuOffloading ? editing ? estimate : estimates.offload : estimate;
    const offload = cpuOffloading ? activeEstimate?.offloading : undefined;
    const systemMemory = activeEstimate?.systemMemory;
    const hasHostBudget = cpuOffloading || gpuCount > 1;
    const hostMaximum = Math.max(0, Math.floor((offload?.ramMaximumMi ?? 0) / 100) * 100);
    const memoryRisks = activeEstimate ? [
      ...(activeEstimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
      ...(selectedMi < roundMemory(activeEstimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
      ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
      ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
      ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
      ...(offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
      ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
      ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
      ...(hasHostBudget && typeof systemMemory?.minimumMi === 'number' && hostMemoryMi < systemMemory.minimumMi ? ['Host RAM is below the estimated startup minimum.'] : []),
    ] : [];
    const hasMemoryRisk = !omni && memoryRisks.length > 0;
    const budgetProblems = omni ? [] : [
      ...(!editing && !selectedTarget ? ['Choose available hardware for this engine.'] : []),
      ...(noSlots ? [editing ? 'No free slot on the selected NVIDIA card.' : 'No free GPU model slots. Remove a model or change GPU sharing in System > Hardware.'] : []),
      ...(engineUnavailable ? [selectedTarget?.engineAvailability?.[draft.engine]?.message ?? `${draft.engine} is not available on the selected hardware.`] : []),
      ...(exceedsPhysicalMemory ? ['The selected VRAM budget exceeds physical memory for a single GPU.'] : []),
      ...(cardRequired && gpuDeployment !== 'single' && gpuCount < 2 ? ['Select at least two GPUs on the same node for this deployment mode.'] : []),
      ...(!Number.isInteger(selectedMi) || selectedMi < 100 || ((editing ? selectedMi !== initialStandard?.selectedMi : true) && selectedMi % 100 !== 0)
        ? ['The memory budget must be a whole number of at least 100 MiB, in steps of 100 MiB.'] : []),
      ...((cpuOffloading || gpuCount > 1) && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < (gpuCount > 1 ? 1100 : 100)
        || ((editing ? hostMemoryMi !== initialStandard?.hostMemoryMi : true) && hostMemoryMi % 100 !== 0))
        ? [`The host RAM budget must be a whole number of at least ${gpuCount > 1 ? 1100 : 100} MiB, in steps of 100 MiB.`] : []),
      ...(gpuCount > 1 && selectedCards.some((item) => selectedMi > Number(nvidiaPhysicalCapacityMi(item) ?? 0)) ? ['The VRAM budget per GPU exceeds the physical memory of a selected card.'] : []),
      ...(gpuCount > 1 && typeof activeEstimate?.systemMemoryMaximumMi === 'number' && hostMemoryMi > activeEstimate.systemMemoryMaximumMi ? ['The host RAM budget exceeds the unreserved system RAM of the selected node.'] : []),
    ];

    // Realtime (vLLM-Omni)
    const free = (item: RealtimeDevice) => item.computeTarget === 'cpu' ? 1 : Math.min(item.slotCount ?? item.gpuCount, item.freeGpuCount
      + (ownActive && initialConfig?.gpuNode === item.node ? initialConfig.gpuCount : 0));
    const shared = device?.allocationMode === 'time-slicing' || device?.allocationMode === 'dra-shared';
    const isCpu = computeTarget === 'cpu';
    const maxGpuCount = device ? isCpu ? 1 : Math.min(free(device), device.maxGpuCount ?? device.gpuCount) : 0;
    const canonicalUrl = omni ? normalizeHuggingFaceReference(draft.url) : draft.url;
    const imageMissing = omni && !config?.runtimeImage && profile?.image === '';
    const invalidRealtime = omni && (!profile || !device?.supported || !config || !integer(config.gpuCount, 1, maxGpuCount)
      || !profile.gpuCounts.includes(config.gpuCount) || !integer(config.thinkerCpuOffloadGiB, 0)
      || !integer(config.systemMemoryMi, 1, device?.systemMemoryMi ?? 0) || !Number.isFinite(config.gpuMemoryFraction)
      || config.gpuMemoryFraction <= 0 || config.gpuMemoryFraction > 1);
    const recommendedRam = config ? Math.max((config.thinkerCpuOffloadGiB + 4) * 1024,
      device?.gpuAllocationMode === 'shared-gtt' ? Math.floor(device.gpuMemoryMi * config.gpuMemoryFraction) * config.gpuCount + (profile?.hostRuntimeHeadroomMi ?? 8192) : 0) : 0;
    const modelError = omni && !canonicalUrl ? 'Enter hf://organization/model, organization/model, or a Hugging Face repository URL.' : undefined;
    const nameError = !editing ? modelNameError(draft.name, payload.activations.map((item) => item.metadata?.name ?? '')) : undefined;
    const problems = [
      ...budgetProblems,
      ...(invalidRealtime ? ["Check available slots, positive numeric settings and the node's RAM capacity."] : []),
      ...(imageMissing ? ['Choose a backend-compatible runtime image in Advanced.'] : []),
      ...(cpuSettings.invalid ? ['Enter a positive CPU reservation. The limit must be at least the reservation, or 0 for unlimited.'] : []),
      ...(deploymentSettings.invalid ? ['This vision backend is no longer offered by the runtime catalog. Select an available option.'] : []),
      ...(!canonicalUrl ? [modelError ?? 'Choose a model reference.'] : []),
      ...(!modelType ? ['Select the model task.'] : []),
      ...(nameError ? [nameError] : []),
      ...(!integer(draft.contextWindow, 1) ? ['The context size must be a positive whole number.'] : []),
      ...(!integer(draft.maxNumSeqs, 1) ? [`${omni ? 'Concurrent sessions' : 'Max Num Seqs'} must be a positive whole number.`] : []),
      ...(!omni && draft.maxOutputTokens !== '' && !integer(Number(draft.maxOutputTokens), 1) ? ['Max output tokens must be a positive whole number or empty.'] : []),
      ...(editing && !modelEditRevision(activation!) ? ['The model has no saved revision yet. Reload and try again.'] : []),
      ...(!draft.name.trim() ? ['Enter a model name.'] : []),
    ];
    const serializationOptions = {cpuResources: cpuSettings.payload, cpuChanged: cpuSettings.changed, vllm: deploymentSettings.payload,
      deploymentChanged: deploymentSettings.changed, allowMemoryRisk: hasMemoryRisk, initialAllowMemoryRisk: local.allowMemoryRisk === true};
    const effectiveDraft = {...draft, computeTarget} as LocalModelDraft;
    let changes: Record<string, unknown> = {};
    let changesError: string | undefined;
    if (editing) {
      try { changes = localModelChanges(initial, effectiveDraft, serializationOptions); } catch (error) { changesError = errorText(error); }
    }
    const changed = !editing || Object.keys(changes).length > 0;
    const busy = editing && !omni && (estimates.editFetching || Boolean(estimates.editError));
    return {
      payload, omni, standard, initialStandard, config, initialConfig, profiles, profileId, profile, devices, device, deviceChoice, computeTarget, policy,
      targets, selectedTarget, targetEngineAvailable, cpuSettings, deploymentSettings, repository, provider, presets, preset, presetTask,
      cards, gpuKeys, ownKeys, ownActive, selectedCards, card, gpuCount, replicated, multiGpu, gpuPayload, cardRequired, noSlots, engineUnavailable,
      automaticGpuPool, kvCacheOptions, detectedTask, modelType, requestedModelType, selectedMi, hostMemoryMi, cpuOffloading, supportsOffloading,
      gpuKey, parallelism, gpuDeployment, estimate, capacityKnown, availableMi, physicalMaximumMi, exceedsPhysicalMemory, activeEstimate, offload,
      systemMemory, hasHostBudget, hostMaximum, memoryRisks, hasMemoryRisk, free, shared, isCpu, maxGpuCount, canonicalUrl, imageMissing,
      invalidRealtime, recommendedRam, modelError, nameError, problems, serializationOptions, effectiveDraft, changes, changesError, changed, busy,
    };
  };
  type Derived = ReturnType<typeof derive>;

  // ------------------------------------------------------------ discovery (useModelDiscovery)
  const discoveryParams = (d: Derived, query: string, nextCursor?: string | null) => new URLSearchParams({
    provider: d.provider, engine: draft.engine, computeTarget: d.computeTarget, modelType: d.repository ? 'chat' : '',
    ...(d.profileId ? {realtimeProfile: d.profileId} : {}), q: query, limit: '20', ...(nextCursor ? {cursor: nextCursor} : {}),
  });
  const applyModel = (url: string, artifact?: ModelArtifact, variant?: ModelVariant, base?: DiscoveryItem) => {
    const context = [artifact?.modelMaxContext, variant?.contextWindow, base?.modelMaxContext].map((value) => Number(value ?? 0))
      .find((value) => Number.isFinite(value) && value > 0);
    const name = draft.name || safeModelName(url);
    update({url, name, ...(context ? {contextWindow: context} : {}), ...(variant?.maxNumSeqs ? {maxNumSeqs: Number(variant.maxNumSeqs)} : {})});
    if (!form.name) onName(name);
  };
  const loadArtifacts = async (nextRepo: string, append = false, base?: DiscoveryItem) => {
    const d = derive();
    const request = ++discovery.artifactRequest, epoch = discovery.epoch, state = discovery;
    state.repo = nextRepo; state.error = undefined; state.loadingArtifacts = true;
    redraw();
    try {
      const query = discoveryParams(d, '');
      query.delete('q'); query.set('repo', nextRepo);
      if (append && state.artifactCursor) query.set('cursor', state.artifactCursor);
      const response = await ctx.api.modelArtifacts(query);
      if (state !== discovery || request !== state.artifactRequest || epoch !== state.epoch || !isOpen()) return;
      state.artifacts = append ? [...state.artifacts, ...response.artifacts] : response.artifacts;
      state.artifactCursor = response.nextCursor ?? null;
      if (!append) {
        state.baseModel = response.baseModel ?? base;
        const first = response.artifacts.find((item) => item.compatibility !== 'incompatible') ?? response.artifacts[0];
        state.artifactId = first?.id ?? '';
        if (first?.url) applyModel(first.url, first, undefined, response.baseModel ?? base);
      }
    } catch (error) {
      if (state === discovery && request === state.artifactRequest && epoch === state.epoch) state.error = errorText(error);
    } finally {
      if (state === discovery && request === state.artifactRequest && epoch === state.epoch) state.loadingArtifacts = false;
      redraw();
    }
  };
  const runSearch = async (query = discovery.search, append = false) => {
    const d = derive();
    const state = discovery;
    const request = ++state.searchRequest, epoch = state.epoch;
    state.artifactRequest += 1;
    const submitted = append ? state.lastSearch : query.trim();
    state.searching = true; state.error = undefined;
    if (!append) { state.lastSearch = submitted; state.artifacts = []; state.artifactId = ''; }
    redraw();
    try {
      const response = await ctx.api.searchModels(discoveryParams(d, submitted, append ? state.cursor : null));
      if (state !== discovery || request !== state.searchRequest || epoch !== state.epoch || !isOpen()) return;
      state.results = append ? [...state.results, ...response.results.filter((item) => !state.results.some((entry) => entry.repo === item.repo))] : response.results;
      state.cursor = response.nextCursor ?? null;
      state.searched = true;
      if (!append && !d.repository) {
        const first = state.results[0];
        state.repo = first?.repo ?? '';
        if (first) void loadArtifacts(first.repo, false, first);
      }
    } catch (error) {
      if (state === discovery && request === state.searchRequest && epoch === state.epoch) state.error = errorText(error);
    } finally {
      if (state === discovery && request === state.searchRequest && epoch === state.epoch) state.searching = false;
      redraw();
    }
  };
  const selectPreset = (d: Derived, id: string, selectedId = '') => {
    const next = d.presets.find((item) => item.id === id), artifact = selectedArtifact(next?.variant, selectedId);
    update({presetId: id, artifactId: selectedId});
    if (next) applyModel(artifact?.url ?? next.variant.url ?? '', artifact, next.variant);
  };

  // ------------------------------------------------------------ reactions (the browser's effects)
  /** Runs `action` when `key` differs from the last run of the same reaction. */
  const react = (name: string, key: string, action: (first: boolean) => void) => {
    if (reactions[name] === key) return;
    const first = !(name in reactions);
    reactions[name] = key;
    action(first);
  };
  const schedule = (name: string, delay: number, run: () => Promise<void>) => {
    if (timers[name]) clearTimeout(timers[name]);
    timers[name] = setTimeout(() => {
      timers[name] = undefined;
      if (isOpen()) void run();
    }, delay);
  };
  const cancel = (name: string) => {
    if (timers[name]) clearTimeout(timers[name]);
    timers[name] = undefined;
  };

  const sync = () => {
    let d = derive();
    react('vision', d.deploymentSettings.selection, (first) => {
      // Never carry an override into another engine or compute target.
      if (!d.deploymentSettings.available || !first) vision.value = d.deploymentSettings.automatic;
    });
    if (!d.deploymentSettings.available && vision.value !== d.deploymentSettings.automatic) vision.value = d.deploymentSettings.automatic;
    react('discovery', `${draft.engine}|${d.computeTarget}|${d.profileId}`, (first) => {
      if (first) return;
      const search = discovery.search;
      discovery = {...freshDiscovery(d.repository, search), popular: discovery.popular, epoch: discovery.epoch + 1, searchRequest: discovery.searchRequest + 1, artifactRequest: discovery.artifactRequest + 1};
    });
    react('popular', `${d.provider}|${draft.engine}|${d.computeTarget}|${d.repository}`, () => {
      if (editing || d.repository) return;
      const state = discovery;
      void ctx.api.popularModels(new URLSearchParams({provider: d.provider, engine: draft.engine, computeTarget: d.computeTarget, modelType: '', limit: '8'}))
        .then((response) => { if (state === discovery) state.popular = response.results; }, () => { if (state === discovery) state.popular = []; })
        .finally(redraw);
    });
    const kvValues = d.kvCacheOptions.map((item) => item.value);
    if (!editing && d.standard && !kvValues.includes(d.standard.kvCacheType)) {
      updateStandard({kvCacheType: kvValues[0] || (draft.engine === 'OLlama' ? 'f16' : 'auto')});
      d = derive();
    }
    react('offloading', `${d.computeTarget}|${d.omni}`, () => {
      if (editing || d.omni) return;
      if (d.cpuOffloading) { updateStandard({cpuOffloading: false}); d = derive(); }
    });
    react('host-edited', `${d.computeTarget}|${draft.url}`, () => { hostMemoryEdited = false; });

    const vllm = d.gpuCount > 1 && !d.replicated && draft.engine === 'VLLM' ? {vllm: {parallelism: d.parallelism}} : {};
    const kvCacheType = d.standard?.kvCacheType;
    react('create-estimate', JSON.stringify([editing, d.omni, d.computeTarget, draft.contextWindow, draft.engine, kvCacheType, draft.maxNumSeqs, d.requestedModelType, draft.url, d.cpuOffloading, d.gpuKey, d.parallelism, d.gpuDeployment]), () => {
      if (editing || d.omni) return;
      estimates.error = undefined;
      if (!draft.url) { estimates.create = undefined; cancel('create-estimate'); return; }
      const capacityKnown = d.capacityKnown, availableMi = d.availableMi, cpuOffloading = d.cpuOffloading;
      const body = {engine: draft.engine, computeTarget: d.computeTarget, url: draft.url, contextWindow: draft.contextWindow,
        maxNumSeqs: draft.maxNumSeqs, modelType: d.requestedModelType, kvCacheType, ...d.gpuPayload, ...vllm};
      const url = draft.url;
      const key = reactions['create-estimate'];
      schedule('create-estimate', 350, async () => {
        try {
          const result = await ctx.api.estimateMemory(body);
          if (reactions['create-estimate'] !== key || !isOpen()) return;
          estimates.create = result;
          estimates.version += 1;
          taskDetection = {url, value: result.detectedModelType};
          const maximum = capacityKnown ? Math.max(100, Math.floor(availableMi / 100) * 100) : roundMemory(result.recommendedMi);
          if (draft.kind === 'standard') updateStandard({selectedMi: Math.min(maximum, cpuOffloading ? draft.selectedMi : roundMemory(result.recommendedMi))});
        } catch (error) {
          if (reactions['create-estimate'] === key) estimates.error = errorText(error);
        }
        redraw();
      });
    });
    react('offload-estimate', JSON.stringify([editing, d.omni, d.cpuOffloading, d.supportsOffloading, draft.engine, d.computeTarget, draft.url, draft.contextWindow, draft.maxNumSeqs, d.requestedModelType, kvCacheType, d.selectedMi, d.gpuKey, d.parallelism, d.gpuDeployment]), () => {
      if (editing || d.omni) return;
      estimates.offload = undefined;
      estimates.offloadError = undefined;
      cancel('offload-estimate');
      if (!d.cpuOffloading || !d.supportsOffloading || !draft.url) return;
      const url = draft.url;
      const key = reactions['offload-estimate'];
      const body = {engine: draft.engine, computeTarget: d.computeTarget, url, contextWindow: draft.contextWindow, maxNumSeqs: draft.maxNumSeqs,
        modelType: d.requestedModelType, kvCacheType, cpuOffloading: true, vramMi: d.selectedMi, ...d.gpuPayload, ...vllm};
      schedule('offload-estimate', 350, async () => {
        try {
          const result = await ctx.api.estimateMemory(body);
          if (reactions['offload-estimate'] !== key || !isOpen()) return;
          estimates.offload = result;
          estimates.version += 1;
          taskDetection = {url, value: result.detectedModelType};
        } catch (error) {
          if (reactions['offload-estimate'] === key) estimates.offloadError = errorText(error);
        }
        redraw();
      });
    });
    react('edit-estimate', JSON.stringify([initial.name, d.modelType, draft.contextWindow, draft.maxOutputTokens, draft.maxNumSeqs, kvCacheType, d.selectedMi, d.cpuOffloading, d.gpuKey, d.parallelism, d.gpuDeployment]), () => {
      if (!editing || d.omni || !initial.name) return;
      estimates.editFetching = true;
      const key = reactions['edit-estimate'];
      const ownKeys = d.ownKeys.join(',');
      const body = {
        modelType: d.modelType, contextWindow: draft.contextWindow, maxOutputTokens: draft.maxOutputTokens ? Number(draft.maxOutputTokens) : null,
        maxNumSeqs: draft.maxNumSeqs, kvCacheType, cpuOffloading: d.cpuOffloading,
        ...(d.computeTarget === 'cpu' ? {memoryRequiredMi: d.selectedMi} : {vramMi: d.selectedMi}),
        ...(d.card ? {gpuDevice: null, gpuDevices: null, ...d.gpuPayload} : d.gpuKey !== ownKeys ? {gpuDevice: null, gpuDevices: null, gpuDeployment: null} : {}),
        ...(draft.engine === 'VLLM' && (d.gpuCount > 1 || d.ownKeys.length > 1) ? {vllm: d.gpuCount > 1 && !d.replicated ? {parallelism: d.parallelism} : null} : {}),
      };
      schedule('edit-estimate', 250, async () => {
        try {
          const result = await ctx.api.estimateModelUpdate(initial.name, body);
          if (reactions['edit-estimate'] !== key || !isOpen()) return;
          estimates.edit = result;
          estimates.version += 1;
          estimates.editError = undefined;
        } catch (error) {
          if (reactions['edit-estimate'] === key) estimates.editError = errorText(error);
        } finally {
          if (reactions['edit-estimate'] === key) estimates.editFetching = false;
        }
        redraw();
      });
    });
    d = derive();
    react('host-recommendation', JSON.stringify([editing, estimates.version, d.hasHostBudget, hostMemoryEdited, Boolean(d.offload), Boolean(d.systemMemory)]), () => {
      const recommendation = d.systemMemory?.recommendedMi ?? d.offload?.ramRecommendedMi;
      if (!editing && !hostMemoryEdited && d.hasHostBudget && typeof recommendation === 'number') {
        const limit = d.systemMemory?.maximumMi;
        const safeLimit = typeof limit === 'number' ? Math.floor(limit / 100) * 100 : null;
        updateStandard({hostMemoryMi: roundMemory(safeLimit !== null && safeLimit >= 100 ? Math.min(safeLimit, recommendation) : recommendation)});
      }
    });
    return derive();
  };

  // ------------------------------------------------------------ actions
  const selectProfile = (d: Derived, id: string) => {
    const nextProfile = d.profiles[id];
    const nextDevice = d.payload.computeTargets.realtimeDevices?.find((item) => item.profile === id && item.supported && d.free(item) > 0);
    if (draft.kind !== 'omni') return;
    draft = {...draft, computeTarget: nextDevice?.computeTarget ?? draft.computeTarget, contextWindow: nextProfile?.defaultContextWindow ?? 8192, maxNumSeqs: 1,
      url: draft.url === `hf://${d.profile?.model}` ? `hf://${nextProfile?.model ?? ''}` : draft.url,
      realtime: {profile: id, gpuNode: nextDevice?.node ?? '', gpuCount: 1, systemMemoryMi: realtimeDefaultRam(nextProfile, nextDevice), gpuMemoryFraction: 0.9, thinkerCpuOffloadGiB: 0}};
  };
  const selectGpuKeys = (d: Derived, keys: string[]) => updateStandard({
    gpuDevices: keys.flatMap((key) => {
      const selection = d.cards.find((item) => nvidiaCardKey(item.gpuDevice!) === key)?.gpuDevice ?? d.standard?.gpuDevices.find((item) => nvidiaCardKey(item) === key);
      return selection ? [selection] : [];
    }),
    gpuDeployment: keys.length > 1 && d.gpuDeployment === 'single' ? 'split' : keys.length === 1 && d.gpuDeployment === 'split' ? 'single' : d.gpuDeployment,
  });
  const selectHardware = (d: Derived, target: string) => {
    const first = d.payload.computeMemory?.devices?.find((item) => target === 'nvidia-gpu' && item.gpuDevice && item.slots?.scope === 'device' && (item.slots.free ?? 0) > 0);
    updateStandard({computeTarget: target, gpuDevices: first?.gpuDevice ? [first.gpuDevice] : [], gpuDeployment: 'single', parallelism: 'auto'});
  };

  // ------------------------------------------------------------ items
  const sourceItems = (d: Derived): DialogItem[] => {
    const canonical = d.omni ? normalizeHuggingFaceReference(draft.url) : draft.url;
    const defaultUrl = d.omni ? `hf://${d.profile?.model ?? ''}` : undefined;
    const ollama = d.provider === 'ollama';
    const state = discovery;
    const items: DialogItem[] = [];
    if (!editing) {
      items.push({kind: 'choice', id: 'source', label: 'Model source', value: draft.source, choices: [
        ...(d.policy.sources.includes('search') ? [{value: 'search', label: ollama ? 'Ollama Library' : 'Hugging Face search'}] : []),
        ...(d.policy.sources.includes('preset') ? [{value: 'preset', label: 'Tested preset'}] : []),
        ...(d.policy.sources.includes('direct') ? [{value: 'direct', label: 'Direct reference'}] : []),
      ], onChange: (value) => { const source = value as LocalModelSource; update({source}); form.source = source; }});
      if (draft.source === 'search') {
        items.push({kind: 'heading', text: ollama ? 'Ollama Library' : 'Hugging Face'});
        items.push({kind: 'text', id: 'search', label: ollama ? 'Search Ollama Library' : 'Search Hugging Face', value: state.search, hint: d.repository ? 'Qwen3-Omni…' : 'Qwen, GLM, DeepSeek…',
          onChange: (value) => { state.search = value; }});
        items.push(...buttonRows([
          {id: 'search-run', label: state.searching ? 'Searching…' : 'Search', tone: 'primary',
            disabled: state.searching ? 'A search is running.' : state.search.trim().length < 2 ? 'Enter at least two characters.' : undefined, onPress: () => void runSearch()},
          ...(!d.repository ? MODEL_FAMILIES.map((family) => ({id: `family:${family}`, label: family, onPress: () => { state.search = family; void runSearch(family); }})) : []),
        ]));
        if (state.popular.length) {
          items.push({kind: 'note', text: ollama ? 'Popular on Ollama' : 'Trending on Hugging Face'});
          items.push(...buttonRows(state.popular.slice(0, 8).map((item) => ({id: `popular:${item.repo}`, label: item.name ?? item.repo,
            onPress: () => { state.search = item.repo; void runSearch(item.repo); }}))));
        }
        if (state.error) items.push({kind: 'note', tone: 'bad', text: state.error});
        if (state.results.length) {
          items.push({kind: 'choice', id: 'search-result', label: 'Matching model',
            value: d.repository ? state.results.some((item) => item.url === canonical) ? canonical : '' : state.repo,
            choices: [
              ...(d.repository ? [{value: '', label: 'Select a model', disabled: 'Choose one of the matching models.'}] : []),
              ...state.results.map((item) => ({value: d.repository ? String(item.url ?? '') : item.repo, label: `${item.repo}${item.pulls ? ` · ${item.pulls.toLocaleString('en-US')} pulls` : ''}`})),
            ],
            onChange: (value) => {
              if (d.repository) update({url: value});
              else void loadArtifacts(value, false, state.results.find((item) => item.repo === value));
            }});
        }
        if (state.cursor) items.push({kind: 'buttons', items: [{id: 'search-more', label: 'Load more models', disabled: state.searching ? 'A search is running.' : undefined, onPress: () => void runSearch(state.search, true)}]});
        if (!d.repository && state.results.length) {
          items.push({kind: 'choice', id: 'artifact', label: ollama ? 'Tag / quantization' : 'Quantization / artifact', value: state.artifactId,
            disabled: state.loadingArtifacts ? 'Loading the available artifacts…' : undefined,
            choices: state.artifacts.length ? state.artifacts.map((item) => ({value: item.id, label: `${item.label ?? item.repo}${item.sizeLabel ? ` · ${item.sizeLabel}` : item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : ''}`}))
              : [{value: '', label: state.loadingArtifacts ? 'Loading…' : 'No compatible artifact found', disabled: 'No artifact is available.'}],
            onChange: (value) => {
              state.artifactId = value;
              const item = state.artifacts.find((artifact) => artifact.id === value);
              if (item?.url) applyModel(item.url, item, undefined, state.baseModel);
            }});
          if (state.artifactCursor) items.push({kind: 'buttons', items: [{id: 'artifact-more', label: `Load more ${ollama ? 'tags' : 'quantizations'}`,
            disabled: state.loadingArtifacts ? 'Artifacts are loading.' : undefined, onPress: () => void loadArtifacts(state.repo, true)}]});
          const selected = state.artifacts.find((item) => item.id === state.artifactId);
          if (selected) items.push({kind: 'note', text: [
            `Publisher: ${selected.author ?? selected.repo.split('/')[0]}`,
            ...(selected.format ? [`Format: ${selected.format}`] : []),
            ...(quantizationText(selected.quantization) ? [`Quantization: ${quantizationText(selected.quantization)}`] : []),
            ...(selected.trustStatus ? [`Trust: ${selected.trustStatus}`] : []),
            ...(selected.sizeLabel || selected.downloadBytes ? [`Download: ${selected.sizeLabel ?? formatBytes(selected.downloadBytes)}`] : []),
            ...(selected.revision ? [`Revision: ${selected.revision}`] : []),
            ...(selected.modelMaxContext ? [`Model context: ${selected.modelMaxContext.toLocaleString('en-US')}${selected.modelContextSource === 'base-model' ? ' · base model' : ''}`] : []),
          ].map((tag) => `[${tag}]`).join(' ')});
        }
        if (state.searching) items.push({kind: 'note', text: 'Searching…'});
        else if (state.loadingArtifacts) items.push({kind: 'note', text: 'Loading artifacts…'});
        else if (!state.results.length) items.push({kind: 'note', text: state.searched ? 'No matching public models found.' : 'Enter at least two characters or choose a model family or popular model.'});
      }
      if (draft.source === 'preset') {
        items.push({kind: 'choice', id: 'preset', label: 'Preset', value: draft.presetId, choices: [
          {value: '', label: 'Select a tested preset'},
          ...d.presets.map((item) => ({value: item.id, label: item.label})),
        ], onChange: (value) => selectPreset(d, value)});
        items.push({kind: 'choice', id: 'preset-artifact', label: 'Precision / Quantization', value: draft.artifactId, disabled: d.preset ? undefined : 'Select a tested preset first.',
          choices: [{value: '', label: 'Default artifact'}, ...(d.preset?.variant.artifacts ?? []).map((item) => ({value: String(item.id ?? ''), label: String(item.title ?? item.id ?? '')}))],
          onChange: (value) => selectPreset(d, draft.presetId, value)});
      }
      if (draft.source === 'direct') {
        items.push({kind: 'text', id: 'direct-url', label: ollama ? 'Ollama model reference' : 'Hugging Face URL', value: draft.url, required: true,
          hint: defaultUrl ?? (ollama ? 'ollama://qwen3.5:9b' : 'hf://Qwen/Qwen3.6-27B'),
          onChange: (url) => {
            update({url, name: draft.name || (url ? safeModelName(url) : '')});
            if (!form.name && url) onName(safeModelName(url));
          }});
      }
      if (defaultUrl && canonical !== defaultUrl) items.push({kind: 'buttons', items: [{id: 'profile-default', label: 'Use profile default', onPress: () => update({url: defaultUrl})}]});
    }
    items.push({kind: 'facts', rows: [['Selected URL', canonical || draft.url || '—']]});
    return items;
  };

  const nvidiaItems = (d: Derived): DialogItem[] => {
    const maximum = d.multiGpu?.computeTargets.includes(d.computeTarget) ? d.multiGpu.maxDevices : 1;
    const primary = d.gpuKeys.flatMap((key) => d.cards.filter((card) => nvidiaCardKey(card.gpuDevice!) === key))[0];
    const free = (card: ComputeMemoryDevice) => Math.min(card.slots?.total ?? 0,
      (card.slots?.free ?? 0) + (d.ownActive && d.ownKeys.includes(nvidiaCardKey(card.gpuDevice!)) ? 1 : 0));
    const allowAutomatic = editing && d.selectedTarget?.available === true && !d.cards.length;
    const items: DialogItem[] = [];
    if (d.multiGpu?.computeTargets.includes(d.computeTarget)) {
      const replication = d.multiGpu.deploymentModes?.includes('replicated') ?? false;
      items.push({kind: 'choice', id: 'gpu-deployment', label: 'GPU deployment', value: d.gpuDeployment, choices: [
        {value: 'single', label: 'Single GPU · one model copy'}, {value: 'split', label: 'Split one model · across GPUs'},
        ...(replication ? [{value: 'replicated', label: 'Replicate model copies · one per GPU'}] : []),
      ], onChange: (value) => {
        const mode = value as GpuDeployment;
        updateStandard({gpuDeployment: mode, ...(mode === 'single' && d.standard ? {gpuDevices: d.standard.gpuDevices.slice(0, 1)} : {})});
      }});
      if (d.gpuDeployment === 'replicated') items.push({kind: 'note', tone: 'normal', text: 'One API model name, with requests balanced across healthy copies. Each copy needs the full model memory budget; system RAM and CPU are reserved per copy.'});
      if (d.gpuDeployment !== 'single' && d.gpuCount < 2) items.push({kind: 'note', tone: 'warn', text: 'Select at least two GPUs on the same node for this deployment mode.'});
    }
    items.push({kind: 'heading', text: 'NVIDIA GPUs'});
    for (const card of d.cards) {
      const key = nvidiaCardKey(card.gpuDevice!);
      const selected = d.gpuKeys.includes(key);
      const reason = nvidiaCardMismatch(primary ?? card, card) ?? (free(card) <= 0 ? 'No free slots' : d.gpuKeys.length >= maximum && !selected ? 'Maximum GPU count reached' : '');
      items.push({kind: 'check', id: `card:${key}`, checked: selected, disabled: !selected && reason ? reason : undefined,
        label: `${card.name ?? card.id} · ${card.gpuDevice!.nodeName} · ${reason || `${free(card)}/${card.slots?.total ?? 0} slots free`} · ${formatMi(nvidiaPhysicalCapacityMi(card))} VRAM`,
        onChange: () => selectGpuKeys(d, selected ? d.gpuKeys.filter((value) => value !== key) : [...d.gpuKeys, key])});
    }
    for (const key of d.gpuKeys.filter((value) => !d.cards.some((card) => nvidiaCardKey(card.gpuDevice!) === value))) {
      items.push({kind: 'check', id: `card:${key}`, checked: true, label: `Selected GPU ${key} is no longer available. Uncheck it to choose a replacement.`,
        onChange: () => selectGpuKeys(d, d.gpuKeys.filter((value) => value !== key))});
    }
    if (allowAutomatic) items.push({kind: 'buttons', items: [{id: 'gpu-automatic', label: 'Use device-plugin assignment', disabled: d.gpuKeys.length ? undefined : 'Automatic assignment is already used.', onPress: () => selectGpuKeys(d, [])}]});
    items.push({kind: 'note', text: 'Select the GPUs to use. Each checkbox selects one physical card; unavailable cards show the reason. Shared slots do not isolate VRAM.'});
    items.push({kind: 'note', text: `${d.gpuKeys.length} GPU${d.gpuKeys.length === 1 ? '' : 's'} selected. ${d.replicated ? 'One complete model copy and one Pod per card, behind one API name.' : 'One model, one Pod.'} One slot per card; the entire group must be available. VRAM is budgeted per card; shared slots do not isolate memory.`});
    return items;
  };

  const realtimeHardwareItems = (d: Derived): DialogItem[] => {
    const config = d.config!;
    const device = d.device;
    return [
      {kind: 'choice', id: 'realtime-node', label: 'Compute node', value: device ? d.deviceChoice(device) : config.gpuNode, choices: [
        ...(!config.gpuNode ? [{value: '', label: 'Select a compute node', disabled: 'Choose an available compute node.'}] : []),
        ...d.devices.map((item) => ({
          value: d.deviceChoice(item),
          label: `${item.node} · ${item.name} · ${item.supported ? item.computeTarget === 'cpu' ? 'CPU' : `${d.free(item)} free GPU slot${d.free(item) === 1 ? '' : 's'}${item.allocationMode && item.allocationMode !== 'exclusive' ? ` · ${item.allocationMode === 'dra-shared' ? 'DRA' : 'Time-slicing'}` : ''}` : item.reason}`,
          disabled: !item.supported ? item.reason || 'Not supported.' : d.free(item) < 1 ? 'No free slot.' : undefined,
        })),
      ], onChange: (value) => {
        const selected = d.devices.find((item) => d.deviceChoice(item) === value);
        if (selected && draft.kind === 'omni') draft = {...draft, computeTarget: selected.computeTarget ?? draft.computeTarget, realtime: {...draft.realtime, gpuNode: selected.node, gpuCount: 1}};
      }},
      ...(!d.isCpu ? [{kind: 'choice', id: 'realtime-gpus', label: 'GPUs', value: String(config.gpuCount), choices: (d.profile?.gpuCounts ?? [1]).map((count) => ({
        value: String(count), label: `${count} GPU${count === 1 ? `${d.shared ? ' · shared slot' : ''} · all stages` : 's · thinker / audio stages'}`,
        disabled: count > d.maxGpuCount ? 'Not enough free GPU slots on this node.' : undefined,
      })), onChange: (value: string) => updateRealtime({gpuCount: Number(value)})} as DialogItem] : []),
      ...(device ? [{kind: 'note', text: `${!d.isCpu ? `[${device.gpuAllocationMode === 'shared-gtt' ? 'Shared GPU capacity' : 'VRAM per GPU'}: ${device.gpuMemoryMi ? formatMi(device.gpuMemoryMi) : 'unknown'}] ` : ''}[Allocatable RAM: ${formatMi(device.systemMemoryMi)}]`} as DialogItem] : []),
      ...(d.shared ? [{kind: 'note', tone: 'warn', text: 'Shared GPU · no VRAM isolation: GPU memory and compute are shared with other models, without isolated VRAM limits. Leave room for other workloads; concurrent models can run out of memory or slow down.'} as DialogItem] : []),
      ...(!d.devices.some((item) => item.supported && d.free(item) > 0) ? [{kind: 'note', tone: 'warn', text: 'No available compute slot. Check the device reason and GPU sharing in System → Hardware.'} as DialogItem] : []),
    ];
  };

  const memoryItems = (d: Derived): DialogItem[] => {
    const standard = d.standard!;
    const kvDescription = d.kvCacheOptions.find((option) => option.value === standard.kvCacheType)?.description;
    const budgetLabel = d.replicated || d.gpuCount === 1 ? d.computeTarget === 'cpu' ? 'RAM budget (MiB)' : 'VRAM budget (MiB)' : 'Total VRAM budget (MiB)';
    const setHost = (value: number) => { hostMemoryEdited = true; updateStandard({hostMemoryMi: value}); };
    const items: DialogItem[] = [
      {kind: 'note', text: `${kvDescription ? `${kvDescription} ` : ''}Attention-cache values are recalculated immediately; recurrent state and runtime reserve remain separate.`},
      ...(editing && !estimates.edit && estimates.editFetching ? [{kind: 'note', text: 'Recalculating memory…'} as DialogItem] : []),
      ...(editing && !d.estimate ? [
        {kind: 'facts', rows: [[budgetLabel, `${d.selectedMi * (d.replicated ? 1 : d.gpuCount)} MiB`]]} as DialogItem,
        {kind: 'note', text: `Saved budget. ${estimates.editError ? 'Memory estimation failed; changes cannot be saved until a valid estimate is available.' : 'Waiting for the current memory estimate.'}`} as DialogItem,
      ] : []),
      ...(d.gpuCount > 1 ? [{kind: 'note', tone: 'normal', text: `VRAM per GPU: ${formatMi(d.selectedMi)} · ${d.gpuCount} GPUs · ${formatMi(d.selectedMi * d.gpuCount)} planned total. The smallest selected card limits this control.`} as DialogItem] : []),
      ...estimatePanelItems(ctx, {
        id: 'estimate', estimate: d.activeEstimate ?? d.estimate, availableMi: d.availableMi, capacityKnown: d.capacityKnown, selectedMi: d.selectedMi,
        onSelected: (value) => updateStandard({selectedMi: value}), hideBreakdown: d.cpuOffloading, preserveSelectedMi: editing ? d.initialStandard?.selectedMi : undefined,
        budgetDevices: d.replicated ? 1 : d.gpuCount, breakdownOpen: ui.breakdown, onBreakdown: (open) => { ui.breakdown = open; },
      }),
      ...(d.computeTarget !== 'cpu' ? systemMemoryItems(ctx, {
        id: 'system', estimate: d.activeEstimate ?? d.estimate, selectedMi: d.hostMemoryMi, onSelected: d.hasHostBudget ? setHost : undefined,
        preserveSelectedMi: editing ? d.initialStandard?.hostMemoryMi : undefined, breakdownOpen: ui.ramBreakdown, onBreakdown: (open) => { ui.ramBreakdown = open; },
      }) : []),
    ];
    if (d.supportsOffloading) {
      items.push({kind: 'heading', text: 'CPU offloading'});
      items.push({kind: 'check', id: 'cpu-offloading', label: 'Use additional system RAM', checked: d.cpuOffloading, onChange: (checked) => updateStandard({cpuOffloading: checked})});
      items.push({kind: 'note', text: "Stores part of the model in this GPU node's RAM. This can run larger models, but may substantially reduce response speed. No disk swap or RAM from another node is used."});
      if (d.cpuOffloading) {
        if (!d.offload && !estimates.offloadError && !editing) items.push({kind: 'note', text: 'Calculating the RAM / VRAM allocation…'});
        const offload = d.offload;
        if (offload && !d.systemMemory) {
          items.push(
            {kind: 'heading', text: 'Host RAM reservation', meta: 'Includes offloading and runtime'},
            {kind: 'facts', rows: [['Minimum', formatMi(offload.ramMinimumMi)], ['Recommended', formatMi(offload.ramRecommendedMi)],
              ['100% unreserved on an eligible GPU node', offload.ramMaximumMi === null ? 'Unknown' : formatMi(d.hostMaximum)]]},
            {kind: 'number', id: 'offload-host', label: 'Host RAM budget (MiB)', value: String(d.hostMemoryMi), step: 100, min: 100, ...(d.hostMaximum ? {max: d.hostMaximum} : {}),
              onChange: (value) => setHost(Number(value || 0))},
            {kind: 'buttons', items: [
              {id: 'offload-recommended', label: 'Use recommended RAM allocation', onPress: () => { hostMemoryEdited = false; updateStandard({hostMemoryMi: roundMemory(offload.ramRecommendedMi)}); }},
              {id: 'offload-info', label: 'Calculation details', onPress: () => showCalculations(ctx, 'Host RAM reservation', [
                {label: 'Host RAM minimum', value: formatMi(offload.ramMinimumMi), calculation: d.activeEstimate?.calculations?.ramMinimumMi},
                {label: 'Host RAM recommended', value: formatMi(offload.ramRecommendedMi), calculation: d.activeEstimate?.calculations?.ramRecommendedMi},
                {label: 'Unreserved host RAM', value: offload.ramMaximumMi === null ? 'Unknown' : formatMi(d.hostMaximum), calculation: unreservedCalculation(offload.ramMaximumMi)},
              ])},
            ]},
            {kind: 'note', text: 'The GPU budget above is preserved. Kubernetes reserves this host RAM on the same node as the GPU; the estimate uses the largest eligible node, not a cluster-wide sum.'},
            ...(draft.engine === 'OLlama' ? [{kind: 'note', text: "Ollama always uses GPU-first auto-fit and places as many layers in actual free VRAM as possible. The selected values remain planning and Kubernetes host-memory budgets; the loaded model's effective split is shown separately."} as DialogItem] : []),
          );
        }
        if (d.activeEstimate) items.push(...breakdownItems(ctx, 'offload', d.activeEstimate, d.replicated ? 1 : d.gpuCount, ui.offloadBreakdown, (open) => { ui.offloadBreakdown = open; }));
      }
      if (estimates.offloadError) items.push({kind: 'note', tone: 'bad', text: estimates.offloadError});
    }
    return items;
  };

  const advancedItems = (d: Derived): DialogItem[] => {
    const items: DialogItem[] = [{kind: 'toggle', id: 'advanced', label: 'Advanced', open: ui.advanced, onChange: (open) => { ui.advanced = open; }}];
    if (!ui.advanced) return items;
    const defaults = d.cpuSettings.defaults;
    items.push(
      {kind: 'heading', text: 'CPU'},
      {kind: 'note', text: 'The reservation controls scheduling and CPU weight under contention; it does not pin cores. Models can use spare CPU up to the optional limit. RAM and VRAM budgets do not change CPU settings. Blank fields use engine defaults; a limit of 0 removes the CPU quota.'},
      {kind: 'number', id: 'cpu-request', label: 'CPU reservation (cores)', value: cpu.draft.request, decimals: true, step: 0.5, min: 0.001,
        hint: defaults ? `Auto (${defaults.requestMillicores / 1000})` : 'Auto', onChange: (value) => { cpu.draft = {...cpu.draft, request: value}; }},
      {kind: 'number', id: 'cpu-limit', label: 'CPU limit (cores, 0 = unlimited)', value: cpu.draft.limit, decimals: true, step: 0.5, min: 0,
        hint: defaults ? `Auto (${defaults.limitMillicores ? defaults.limitMillicores / 1000 : 'unlimited'})` : 'Auto', onChange: (value) => { cpu.draft = {...cpu.draft, limit: value}; }},
      ...(d.cpuSettings.invalid ? [{kind: 'note', tone: 'warn', text: 'Enter a positive CPU reservation. The limit must be at least the reservation, or 0 for unlimited.'} as DialogItem] : []),
      {kind: 'buttons', items: [{id: 'cpu-automatic', label: 'Use automatic CPU settings', disabled: !cpu.draft.request && !cpu.draft.limit ? 'Automatic CPU settings are already used.' : undefined,
        onPress: () => { cpu.draft = {request: '', limit: ''}; }}]},
    );
    const deployment = d.deploymentSettings;
    if (!d.omni && deployment.available && deployment.definition) {
      const selected = deployment.definition.options.find((option) => option.value === vision.value);
      items.push(
        {kind: 'heading', text: 'Deployment'},
        {kind: 'note', text: 'vLLM vision encoder attention for multimodal models. This is separate from the text decoder and KV-cache precision. Manual backends depend on the GPU, model and runtime image; selecting one is not a successful compatibility test. Saving a change may restart the model.'},
        {kind: 'choice', id: 'vision', label: 'Vision attention backend', value: vision.value, choices: [
          ...(deployment.invalid ? [{value: vision.value, label: `Current setting unavailable: ${vision.value}`, disabled: 'No longer offered by the runtime catalog.'}] : []),
          ...deployment.definition.options.map((option) => ({value: String(option.value), label: option.label})),
        ], onChange: (value) => { vision.value = value; }},
        ...(selected?.description ? [{kind: 'note', text: selected.description} as DialogItem] : []),
        ...(deployment.invalid ? [{kind: 'note', tone: 'warn', text: 'This vision backend is no longer offered by the runtime catalog. Select an available option.'} as DialogItem] : []),
      );
    }
    if (d.standard && d.gpuCount > 1) {
      const offloading = d.cpuOffloading || Boolean(d.systemMemory);
      const ramMaximumMi = d.activeEstimate?.systemMemoryMaximumMi;
      items.push({kind: 'heading', text: 'Multi-GPU runtime'});
      if (!d.replicated) {
        if (draft.engine === 'VLLM') items.push(
          {kind: 'choice', id: 'parallelism', label: 'GPU parallelism', value: d.parallelism, choices: [
            {value: 'auto', label: 'Auto · compatible model split'}, {value: 'tensor', label: 'Tensor · split layers across GPUs'}, {value: 'pipeline', label: 'Pipeline · consecutive layers per GPU'},
          ], onChange: (value) => updateStandard({parallelism: value as Parallelism})},
          {kind: 'note', text: 'Auto uses tensor parallelism when model dimensions divide evenly, otherwise supported pipeline parallelism. Pipeline may be preferable without fast GPU interconnects; performance depends on the model and topology.'},
        );
        else items.push({kind: 'note', tone: 'normal', text: 'Ollama spreads the model across all selected GPUs. Its layer split is not a hard VRAM limit.'});
      }
      if (!offloading) items.push({kind: 'number', id: 'multi-gpu-ram', label: d.replicated ? 'System RAM per copy (MiB)' : 'Multi-GPU system RAM (MiB)', value: String(d.hostMemoryMi), min: 1100, step: 100,
        ...(typeof ramMaximumMi === 'number' ? {max: Math.floor(ramMaximumMi / 100) * 100} : {}), onChange: (value) => { hostMemoryEdited = true; updateStandard({hostMemoryMi: Number(value || 0)}); }});
      items.push(
        {kind: 'note', text: `${d.replicated ? 'Maximum system RAM per copy' : 'Unreserved system RAM on the selected node'}: ${typeof ramMaximumMi === 'number' ? formatMi(ramMaximumMi) : 'not yet verified'}. The API rechecks this limit when saving.`},
        {kind: 'note', text: d.replicated ? `${d.gpuCount} complete copies · ${formatMi(d.hostMemoryMi)} RAM each · ${formatMi(d.hostMemoryMi * d.gpuCount)} total host RAM. CPU settings apply to each copy.` : 'System RAM and CPU reservations apply once to the whole model Pod, not once per GPU.'},
      );
    }
    if (d.omni && d.config) {
      items.push({kind: 'text', id: 'runtime-image', label: 'Runtime image (optional)', value: d.config.runtimeImage ?? '', hint: d.profile?.image || 'registry/image:tag',
        onChange: (value) => updateRealtime({runtimeImage: value.trim() || undefined})});
      if (!d.isCpu) items.push({kind: 'number', id: 'thinker-offload', label: 'Thinker CPU offload (GiB)', value: String(d.config.thinkerCpuOffloadGiB), min: 0, step: 1,
        onChange: (value) => updateRealtime({thinkerCpuOffloadGiB: Number(value || 0)})});
    }
    return items;
  };

  const items = (): DialogItem[] => {
    const d = sync();
    const options = engineOptions(d.payload);
    const result: DialogItem[] = [];
    if (!editing) result.push({kind: 'choice', id: 'engine', label: 'Inference Engine', value: engineValue(), choices: options.map((item) => ({
      value: item, label: `${item === 'VLLM-Omni' ? '(Experimental) ' : ''}${engineDisplayName(d.payload, item)}`,
    })), onChange: (value) => {
      if (value === engineValue()) return;
      form.selectedEngine = value;
      startEditor();
    }});
    else {
      result.push({kind: 'note', text: `[Model: ${initial.name}] [Engine: ${d.omni ? 'vLLM-Omni' : draft.engine}] [Compute: ${d.computeTarget}] [Source unchanged]`});
      if (!modelEditRevision(activation!)) result.push({kind: 'note', tone: 'warn', text: 'The model has no saved revision yet. Reload and try again.'});
    }
    result.push({kind: 'text', id: 'name', label: 'Name', value: draft.name, required: true, disabled: editing ? 'The model name cannot be changed while editing.' : undefined,
      onChange: (value) => { update({name: value}); onName(value); }});
    if (!editing) result.push({kind: 'note', text: '1–63 lowercase letters, numbers or hyphens; start and end with a letter or number.'});
    if (d.nameError && draft.name.length > 0) result.push({kind: 'note', tone: 'bad', text: d.nameError});
    if (d.omni) {
      result.push({kind: 'choice', id: 'profile', label: 'Realtime profile', value: d.profileId, disabled: editing ? 'The Realtime profile cannot be changed while editing.' : undefined,
        choices: Object.entries(d.profiles).map(([id, item]) => ({value: id, label: item.displayName})), onChange: (value) => selectProfile(d, value)});
      result.push({kind: 'note', text: '[Engine: vLLM-Omni] [WebSocket /v1/realtime] [Experimental runtime]'});
      if (d.profile?.description) result.push({kind: 'note', text: d.profile.description});
    }
    result.push(...sourceItems(d));
    if (d.modelError) result.push({kind: 'note', tone: 'bad', text: d.modelError});
    if (!d.omni && !editing) {
      result.push({kind: 'choice', id: 'hardware', label: 'Hardware', value: d.computeTarget, choices: [
        ...(!d.computeTarget ? [{value: '', label: 'No hardware with free slots', disabled: 'No hardware with free slots.'}] : []),
        ...d.targets.map((target) => {
          const slots = targetSlots(target, draft.engine), available = d.targetEngineAvailable(target);
          const reason = !available ? `unavailable: ${target.engineAvailability?.[draft.engine]?.message ?? 'engine is not eligible'}` : slots && slots.free === 0 ? `no free slots (${slots.used}/${slots.total} occupied)` : '';
          return {value: target.id, label: `${target.displayName ?? target.id}${reason ? ` · ${reason}` : slots ? ` · ${slots.free}/${slots.total} slots free` : ''}`,
            disabled: !available || slotsFull(target, draft.engine) ? reason : undefined};
        }),
      ], onChange: (value) => selectHardware(d, value)});
    }
    if (d.cardRequired) result.push(...nvidiaItems(d));
    if (d.noSlots) result.push({kind: 'note', tone: 'warn', text: editing ? 'No free slot on the selected NVIDIA card.' : 'No free GPU model slots. Remove a model or change GPU sharing in System > Hardware.'});
    if (d.automaticGpuPool) result.push({kind: 'note', tone: 'normal', text: 'Automatic GPU assignment: the model receives one GPU from the scheduling pool, not the combined memory of all cards. The calculator and budget use a single-card capacity. Enable NVIDIA DRA card selection in System > Hardware to choose specific cards or split a model.'});
    if (d.exceedsPhysicalMemory) result.push({kind: 'note', tone: 'warn', text: `The selected VRAM budget exceeds physical memory for a single GPU (${formatMi(d.physicalMaximumMi)}). Reduce it or choose an explicit multi-GPU split. Memory-risk acceptance cannot combine cards.`});
    if (d.engineUnavailable) result.push({kind: 'note', tone: 'warn', text: d.selectedTarget?.engineAvailability?.[draft.engine]?.message ?? `${draft.engine} is not available on the selected hardware.`});
    if (d.omni && d.config) result.push(...realtimeHardwareItems(d));
    if (!d.omni && !editing && draft.url) {
      if (d.detectedTask) result.push({kind: 'note', tone: 'normal', text: `Model task: ${d.detectedTask === 'chat' ? 'Chat' : 'Embedding'} · detected automatically`});
      else if (taskDetection.url === draft.url || estimates.error) result.push(
        {kind: 'choice', id: 'task', label: 'Model task', value: manualTask.url === draft.url ? manualTask.value : '', choices: [
          {value: '', label: 'Select the model task'}, {value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'},
        ], onChange: (value) => { manualTask = {url: draft.url, value}; }},
        {kind: 'note', text: 'The model metadata does not identify its task. Choose Chat for text generation or Embedding for document search.'},
      );
      else result.push({kind: 'note', text: 'Detecting model task…'});
    }
    if (!d.omni && editing) result.push({kind: 'choice', id: 'type', label: 'Type', value: draft.modelType, choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}],
      onChange: (value) => update({modelType: value})});
    result.push(
      {kind: 'number', id: 'context', label: 'Context Size', value: String(draft.contextWindow), min: 1, step: 1024, onChange: (value) => update({contextWindow: Number(value || 0)})},
      {kind: 'number', id: 'max-seqs', label: d.omni ? 'Concurrent sessions' : 'Max Num Seqs', value: String(draft.maxNumSeqs), min: 1, step: 1, onChange: (value) => update({maxNumSeqs: Number(value || 0)})},
    );
    if (!d.omni && d.policy.maxOutputTokens) result.push({kind: 'number', id: 'max-output', label: 'Max Output Tokens', value: draft.maxOutputTokens, min: 1, step: 256, hint: 'Runtime default',
      onChange: (value) => update({maxOutputTokens: value})});
    if (!d.omni) result.push({kind: 'choice', id: 'kv-cache', label: 'KV Cache', value: d.standard?.kvCacheType ?? '', choices: d.kvCacheOptions.map((option) => ({value: option.value, label: option.label})),
      onChange: (value) => updateStandard({kvCacheType: value})});
    if (d.standard) result.push(...memoryItems(d));
    if (d.omni && d.config) {
      result.push({kind: 'number', id: 'realtime-ram', label: 'System RAM (MiB)', value: String(d.config.systemMemoryMi), min: 1, step: 1024,
        ...(d.device?.systemMemoryMi ? {max: d.device.systemMemoryMi} : {}), onChange: (value) => updateRealtime({systemMemoryMi: Number(value || 0)})});
      if (!d.isCpu) result.push(
        {kind: 'number', id: 'realtime-fraction', label: 'GPU memory budget (fraction per GPU)', value: String(d.config.gpuMemoryFraction), min: 0.01, max: 1, step: 0.01, decimals: true,
          onChange: (value) => updateRealtime({gpuMemoryFraction: Number(value || 0)})},
        {kind: 'note', text: `${Math.round(d.config.gpuMemoryFraction * 100)}% per GPU — split between thinker, talker and codec stages; a planning budget, not an isolated VRAM limit or a guarantee that the model fits.`},
      );
      if (!d.invalidRealtime && d.config.systemMemoryMi < d.recommendedRam) result.push({kind: 'note', tone: 'warn', text: `RAM below planning estimate: estimated RAM including offloading and shared GPU memory is ${formatMi(d.recommendedRam)}. This estimate does not block experimental deployment; insufficient RAM can cause OOM.`});
    }
    result.push(...advancedItems(d));
    if (d.imageMissing) result.push({kind: 'note', tone: 'warn', text: 'Choose a backend-compatible runtime image in Advanced.'});
    if (d.invalidRealtime && d.config?.gpuNode) result.push({kind: 'note', tone: 'warn', text: "Check available slots, positive numeric settings and the node's RAM capacity."});
    if (d.hasMemoryRisk) result.push(
      {kind: 'note', tone: 'warn', text: d.exceedsPhysicalMemory ? 'Correct the physical GPU memory limit before saving.' : editing ? 'Memory warning — this change can still be applied.' : 'Memory warning — you can still try to start this model.'},
      ...d.memoryRisks.map((risk): DialogItem => ({kind: 'note', tone: 'warn', text: `• ${risk}`})),
      ...(!editing && !d.exceedsPhysicalMemory ? [{kind: 'note', tone: 'warn', text: 'Adding it accepts this risk. The pod may remain Pending, fail with out-of-memory errors or restart. Requests and limits stay at your selected budgets; a successful start is not guaranteed.'} as DialogItem] : []),
    );
    if (editing) result.push({kind: 'note', text: 'Saving reconciles the model runtime. The Pod may restart while the new parameters are applied.'});
    const estimateError = estimates.error ?? (editing && !d.omni ? estimates.editError : undefined);
    if (estimateError) result.push({kind: 'note', tone: 'bad', text: estimateError});
    if (d.changesError) result.push({kind: 'note', tone: 'bad', text: d.changesError});
    return result;
  };

  const submitLabel = () => {
    const d = derive();
    return `${d.hasMemoryRisk ? '⚠ ' : ''}${editing ? 'Save changes' : d.omni ? 'Add Realtime Model' : 'Add Local Model'}`;
  };
  const disabled = () => {
    const d = derive();
    if (d.problems.length) return d.problems[0];
    if (d.changesError) return d.changesError;
    if (!d.changed) return 'No changes to save.';
    if (d.busy) return estimates.editError ? 'Memory estimation failed; changes cannot be saved until a valid estimate is available.' : 'Recalculating memory…';
    return undefined;
  };
  const run = async () => {
    const reason = disabled();
    if (reason) throw new Error(reason);
    const d = derive();
    const name = draft.name.trim() || initial.name;
    await ctx.perform(editing ? `Update model ${initial.name}` : `Create model ${name}`, async () => {
      if (editing) {
        await ctx.api.updateModel(initial.name, {expectedRevision: modelEditRevision(activation!), local: d.changes});
        return {lines: [`${initial.name} was updated. The runtime may restart while the new parameters are applied.`]};
      }
      const created = localModelCreatePayload({...d.effectiveDraft, modelType: d.detectedTask && !d.omni ? 'auto' : d.modelType} as LocalModelDraft, d.serializationOptions);
      await ctx.api.createLocalModel(created);
      const target = d.selectedTarget?.displayName ?? d.computeTarget;
      return {lines: [
        `${created.name} was requested on ${target} with ${d.omni ? 'vLLM-Omni' : engineDisplayName(d.payload, draft.engine)}.`,
        ...(d.standard ? [`Reservation: ${formatMi(d.selectedMi * (d.replicated ? 1 : d.gpuCount))}${d.activeEstimate ? `; estimate: ${formatMi(d.activeEstimate.minimumMi)} minimum / ${formatMi(d.activeEstimate.recommendedMi)} recommended` : ''}.`] : []),
        ...(d.cpuOffloading || d.gpuCount > 1 ? [`Host RAM reserved: ${formatMi(d.hostMemoryMi)}. Memory figures are estimates, not measured usage.`] : []),
        ...(d.hasMemoryRisk ? ['The memory warning was accepted; a successful start is not guaranteed.'] : []),
      ]};
    });
  };

  return {
    items,
    submit: {
      get label() { return submitLabel(); },
      tone: 'primary',
      disabled,
      run,
    },
  };
};
