import type {
  CpuResources, LocalModelConfigurationPolicy, LocalModelDraft, ModelActivation,
  ModelsPayload, NvidiaGpuSelection, RealtimeDevice, RealtimeProfile, VllmConfiguration,
} from '@magicstick/dashboard-contracts';
import {safeModelName} from './index';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

export const modelEditRevision = (activation: ModelActivation) => {
  const {uid, generation, resourceVersion} = activation.metadata ?? {};
  return uid && Number.isInteger(generation) && Number(generation) > 0
    ? `generation:${uid}:${generation}` : String(resourceVersion ?? '');
};

export const parseMemoryMi = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti)?$/i);
  if (!match) return 0;
  const factors: Record<string, number> = {ki: 1 / 1024, mi: 1, gi: 1024, ti: 1024 * 1024};
  return Math.max(0, Math.round(Number(match[1]) * (factors[(match[2] ?? 'Mi').toLowerCase()] ?? 1)));
};

export const normalizeHuggingFaceReference = (value: string) => {
  const repo = value.trim().replace(/^(?:hf:\/\/|https:\/\/(?:www\.)?huggingface\.co\/)/, '').replace(/\/$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ? `hf://${repo}` : '';
};

export const realtimeDefaultRam = (profile?: RealtimeProfile, device?: RealtimeDevice) => Math.min(device?.systemMemoryMi || 16384, Math.max(
  profile?.defaultSystemMemoryMi ?? 16384,
  device?.gpuAllocationMode === 'shared-gtt'
    ? Math.floor(device.gpuMemoryMi * .9) + (profile?.hostRuntimeHeadroomMi ?? 8192) : 0,
));

/** Older installed catalogs keep their existing form behavior until updated. */
export const localModelConfigurationPolicy = (models: ModelsPayload, engine: string, profile?: string): LocalModelConfigurationPolicy => {
  const definition = models.computeTargets.engineCatalog?.[engine];
  const advertised = profile ? definition?.realtimeProfiles?.[profile]?.configuration : definition?.configuration;
  return advertised ?? (profile
    ? {sources: ['search', 'direct'], discovery: 'repository', memory: 'staged', task: 'realtime', maxOutputTokens: false}
    : {sources: ['search', 'preset', 'direct'], discovery: 'artifacts', memory: 'estimate', task: 'detect', maxOutputTokens: true});
};

export const initialLocalModelDraft = (models: ModelsPayload, engineChoice: string, activation?: ModelActivation, name = ''): LocalModelDraft => {
  const local = record(activation?.spec?.local);
  const status = record(activation?.status);
  const engine = String(local.engine ?? status.engine ?? engineChoice) === 'OLlama' ? 'OLlama' : 'VLLM';
  const omni = Boolean(local.realtime) || engineChoice === 'VLLM-Omni';
  const profiles = models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {};
  const savedRealtime = record(local.realtime);
  const profileId = String(savedRealtime.profile ?? Object.keys(profiles)[0] ?? '');
  const profile = profiles[profileId];
  const device = models.computeTargets.realtimeDevices?.find((item) => item.profile === profileId && item.node === savedRealtime.gpuNode)
    ?? models.computeTargets.realtimeDevices?.find((item) => item.profile === profileId && item.supported && item.freeGpuCount > 0);
  const target = models.computeTargets.targets.find((item) => item.available
    && (item.engineAvailability?.[engine]?.available ?? item.engines?.includes(engine)) && (item.slots?.free ?? 1) > 0);
  const computeTarget = String(local.computeTarget ?? status.computeTarget ?? (omni ? device?.computeTarget ?? profile?.computeTargets?.[0] ?? 'nvidia-gpu' : target?.id ?? ''));
  const common = {
    name: activation?.metadata?.name ?? name, engine, computeTarget,
    url: String(local.url ?? (omni ? `hf://${profile?.model ?? ''}` : '')),
    source: 'search' as const, presetId: '', artifactId: '', modelType: String(local.modelType ?? (omni ? 'chat' : '')),
    contextWindow: Number(local.contextWindow ?? (omni ? profile?.defaultContextWindow ?? 8192 : 4096)),
    maxNumSeqs: Number(local.maxNumSeqs ?? 1), maxOutputTokens: local.maxOutputTokens ? String(local.maxOutputTokens) : '',
  };
  if (omni) return {...common, name: common.name || 'qwen3-omni-realtime', engine: 'VLLM', kind: 'omni', realtime: {
    profile: profileId, gpuNode: String(savedRealtime.gpuNode ?? device?.node ?? ''), gpuCount: Number(savedRealtime.gpuCount ?? 1),
    systemMemoryMi: Number(savedRealtime.systemMemoryMi ?? realtimeDefaultRam(profile, device)),
    gpuMemoryFraction: Number(savedRealtime.gpuMemoryFraction ?? .9), thinkerCpuOffloadGiB: Number(savedRealtime.thinkerCpuOffloadGiB ?? 0),
    ...(savedRealtime.runtimeImage ? {runtimeImage: String(savedRealtime.runtimeImage)} : {}),
    ...(savedRealtime.restartNonce ? {restartNonce: String(savedRealtime.restartNonce)} : {}),
  }};
  const sharing = record(status.gpuSharing);
  const savedDevices = local.gpuDevices ?? (local.gpuDevice ? [local.gpuDevice] : sharing.devices
    ?? (sharing.device && sharing.nodeUid ? [{uuid: sharing.device, nodeUid: sharing.nodeUid, nodeName: sharing.node}] : []));
  const firstCard = models.computeMemory?.devices?.find((item) => item.computeTarget === 'nvidia-gpu' && item.gpuDevice && item.slots?.scope === 'device' && (item.slots.free ?? 0) > 0);
  const gpuDevices = computeTarget === 'nvidia-gpu' ? activation ? savedDevices as NvidiaGpuSelection[] : firstCard?.gpuDevice ? [firstCard.gpuDevice] : [] : [];
  const budget = computeTarget === 'cpu' ? parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi)
    : parseMemoryMi(local.vramMi ?? local.vram ?? status.vramRequiredMi);
  return {...common, engine, kind: 'standard', modelType: String(local.modelType ?? (activation ? 'chat' : '')),
    kvCacheType: String(local.kvCacheType ?? models.computeTargets.targets.find((item) => item.id === computeTarget)?.kvCacheTypes?.[engine]?.[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto')),
    selectedMi: Math.max(100, budget || 100), hostMemoryMi: Math.max(100, parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi) || 16400),
    cpuOffloading: local.cpuOffloading === true, gpuDevices,
    gpuDeployment: (local.gpuDeployment ?? (gpuDevices.length > 1 ? 'split' : 'single')) as 'single' | 'split' | 'replicated',
    parallelism: (record(local.vllm).parallelism ?? 'auto') as NonNullable<VllmConfiguration['parallelism']>,
  };
};

export interface LocalModelSerializationOptions {
  cpuResources?: Partial<CpuResources> | null;
  cpuChanged?: boolean;
  vllm?: VllmConfiguration;
  deploymentChanged?: boolean;
  allowMemoryRisk?: boolean;
  initialAllowMemoryRisk?: boolean;
}

const gpuSettings = (draft: Extract<LocalModelDraft, {kind: 'standard'}>) => draft.gpuDevices.length > 1
  ? {gpuDevices: draft.gpuDevices, gpuDeployment: draft.gpuDeployment}
  : draft.gpuDevices.length ? {gpuDevice: draft.gpuDevices[0], gpuDeployment: draft.gpuDeployment} : {};
const vllmSettings = (draft: Extract<LocalModelDraft, {kind: 'standard'}>, options: LocalModelSerializationOptions) => ({
  ...options.vllm,
  ...(draft.engine === 'VLLM' && draft.gpuDevices.length > 1 && draft.gpuDeployment !== 'replicated' ? {parallelism: draft.parallelism} : {}),
});

/** Whitelists each engine's intent so switching engines cannot leak stale fields. */
export const localModelCreatePayload = (draft: LocalModelDraft, options: LocalModelSerializationOptions = {}) => {
  const local: Record<string, unknown> = {
    engine: draft.engine, computeTarget: draft.computeTarget, modelType: draft.modelType,
    contextWindow: draft.contextWindow, maxNumSeqs: draft.maxNumSeqs,
    ...(options.cpuResources ? {cpuResources: options.cpuResources} : {}),
  };
  if (draft.kind === 'omni') Object.assign(local, {engine: 'VLLM', modelType: 'chat', url: normalizeHuggingFaceReference(draft.url), realtime: draft.realtime});
  else {
    Object.assign(local, gpuSettings(draft), {kvCacheType: draft.kvCacheType}, draft.computeTarget === 'cpu' ? {memoryRequiredMi: draft.selectedMi} : {vram: `${draft.selectedMi}Mi`});
    const vllm = vllmSettings(draft, options);
    if (draft.engine === 'VLLM' && Object.keys(vllm).length) local.vllm = vllm;
    if (draft.computeTarget === 'nvidia-gpu') local.cpuOffloading = draft.cpuOffloading;
    if (draft.cpuOffloading || draft.gpuDevices.length > 1) local.memoryRequiredMi = draft.hostMemoryMi;
    if (options.allowMemoryRisk) local.allowMemoryRisk = true;
    if (draft.maxOutputTokens) local.maxOutputTokens = Number(draft.maxOutputTokens);
    if (draft.source === 'preset' && draft.presetId) Object.assign(local, {preset: draft.presetId, ...(draft.artifactId ? {artifact: draft.artifactId} : {})});
    else local.url = draft.url;
  }
  return {name: draft.name || safeModelName(draft.url), enabled: true, targetNamespace: 'ai', local};
};

/** Explicit null clears optional settings; omitted keys preserve saved intent. */
export const localModelChanges = (initial: LocalModelDraft, draft: LocalModelDraft, options: LocalModelSerializationOptions = {}): Record<string, unknown> => {
  if (initial.kind !== draft.kind || initial.engine !== draft.engine || initial.computeTarget !== draft.computeTarget) throw new Error('The model engine and hardware target cannot be changed while editing.');
  const changes: Record<string, unknown> = {};
  for (const key of ['contextWindow', 'maxNumSeqs'] as const) if (draft[key] !== initial[key]) changes[key] = draft[key];
  if (options.cpuChanged) changes.cpuResources = options.cpuResources ?? null;
  if (initial.kind === 'omni' && draft.kind === 'omni') {
    if (draft.realtime.profile !== initial.realtime.profile) throw new Error('The Realtime profile cannot be changed while editing.');
    if (JSON.stringify(draft.realtime) !== JSON.stringify(initial.realtime)) changes.realtime = draft.realtime;
    return changes;
  }
  if (initial.kind !== 'standard' || draft.kind !== 'standard') return changes;
  if (draft.modelType !== initial.modelType) changes.modelType = draft.modelType;
  if (draft.maxOutputTokens !== initial.maxOutputTokens) changes.maxOutputTokens = draft.maxOutputTokens ? Number(draft.maxOutputTokens) : null;
  if (draft.kvCacheType !== initial.kvCacheType) changes.kvCacheType = draft.kvCacheType;
  if (draft.selectedMi !== initial.selectedMi) changes[draft.computeTarget === 'cpu' ? 'memoryRequiredMi' : 'vramMi'] = draft.selectedMi;
  if (draft.cpuOffloading !== initial.cpuOffloading) changes.cpuOffloading = draft.cpuOffloading;
  const identity = (devices: NvidiaGpuSelection[]) => devices.map((device) => `${device.nodeUid}/${device.uuid}`).join(',');
  const devicesChanged = identity(draft.gpuDevices) !== identity(initial.gpuDevices);
  const deploymentChanged = draft.gpuDeployment !== initial.gpuDeployment;
  if (devicesChanged || deploymentChanged) {
    Object.assign(changes, gpuSettings(draft));
    if (!draft.gpuDevices.length) changes.gpuDeployment = null;
    if (initial.gpuDevices.length <= 1 && (draft.gpuDevices.length > 1 || !draft.gpuDevices.length)) changes.gpuDevice = null;
    if (initial.gpuDevices.length > 1 && draft.gpuDevices.length < 2) changes.gpuDevices = null;
  }
  const needsHostRam = draft.cpuOffloading || draft.gpuDevices.length > 1;
  if (needsHostRam && (draft.hostMemoryMi !== initial.hostMemoryMi || draft.cpuOffloading !== initial.cpuOffloading || devicesChanged)) changes.memoryRequiredMi = draft.hostMemoryMi;
  if (!needsHostRam && (initial.cpuOffloading || initial.gpuDevices.length > 1)) changes.memoryRequiredMi = null;
  if (draft.engine === 'VLLM' && (options.deploymentChanged || ((devicesChanged || deploymentChanged || draft.parallelism !== initial.parallelism) && (draft.gpuDevices.length > 1 || initial.gpuDevices.length > 1)))) {
    const settings = vllmSettings(draft, options);
    changes.vllm = Object.keys(settings).length ? settings : null;
  }
  if (Object.keys(changes).length && options.allowMemoryRisk !== options.initialAllowMemoryRisk) changes.allowMemoryRisk = Boolean(options.allowMemoryRisk);
  return changes;
};
