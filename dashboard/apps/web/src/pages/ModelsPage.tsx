import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canAdminister, canMutateRuntime, formatBytes, formatMi, matchingVariants, safeModelName,
  selectedArtifact,
} from '@magicstick/dashboard-core';
import type {
  DiscoveryItem, MemoryCalculation, MemoryEstimate, ModelArtifact, ModelVariant,
  ModelActivation, ModelsPayload, NvidiaGpuSelection, Session, VllmConfiguration,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, StatusBadge} from '../components';
import {MemoryInfo, unreservedCalculation} from '../MemoryInfo';
import {ComputeMemory} from '../ComputeMemory';
import {sharedSlotPools, slotsFull, targetSlots} from '../GpuSlots';
import {NvidiaGpuGroupSelect, matchingNvidiaCards, nvidiaCardKey} from '../NvidiaGpuSelect';
import {nvidiaPhysicalCapacityMi} from '../NvidiaGpuSelection';
import {useCpuSettings} from '../CpuSettings';
import {useVllmDeploymentSettings} from '../VllmDeploymentSettings';
import {AdvancedModelSettings} from '../AdvancedModelSettings';
import {RealtimeModelForm} from '../RealtimeModelForm';

const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
type GpuDeployment = 'single' | 'split' | 'replicated';
const groupSettings = (devices: NvidiaGpuSelection[], mode: GpuDeployment) => devices.length > 1 ? {gpuDevices: devices, gpuDeployment: mode} : devices.length ? {gpuDevice: devices[0], gpuDeployment: mode} : {};
const GpuDeploymentSelect = ({mode, onChange, replication, count}: {mode: GpuDeployment; onChange: (mode: GpuDeployment) => void; replication: boolean; count: number}) => <section className="stack compact">
  <Field label="GPU deployment"><select value={mode} onChange={(event) => onChange(event.target.value as GpuDeployment)}>
    <option value="single">Single GPU · one model copy</option><option value="split">Split one model · across GPUs</option>
    {replication && <option value="replicated">Replicate model copies · one per GPU</option>}
  </select></Field>
  {mode === 'replicated' && <p>One API model name, with requests balanced across healthy copies. Each copy needs the full model memory budget; system RAM and CPU are reserved per copy.</p>}
  {mode !== 'single' && count < 2 && <p role="status">Select at least two GPUs on the same node for this deployment mode.</p>}
</section>;
const savedGpuKeys = (local: Record<string, unknown>, status: Record<string, unknown>) => {
  const sharing = asRecord(status.gpuSharing);
  const devices = local.gpuDevices ?? (local.gpuDevice ? [local.gpuDevice] : sharing.devices ?? (sharing.device && sharing.nodeUid ? [{uuid: sharing.device, nodeUid: sharing.nodeUid, nodeName: sharing.node}] : []));
  return (devices as NvidiaGpuSelection[]).map(nvidiaCardKey).join(',');
};
const MultiGpuSettings = ({count, engine, strategy, onStrategy, ramMi, onRam, offloading, ramMaximumMi, replicated}: {
  count: number; engine: string; strategy: NonNullable<VllmConfiguration['parallelism']>; onStrategy: (value: NonNullable<VllmConfiguration['parallelism']>) => void;
  ramMi: number; onRam: (value: number) => void; offloading: boolean; ramMaximumMi?: number | null; replicated: boolean;
}) => count > 1 ? <section className="stack compact"><strong>Multi-GPU runtime</strong>
  {!replicated && (engine === 'VLLM' ? <Field label="GPU parallelism"><select value={strategy} onChange={(event) => onStrategy(event.target.value as typeof strategy)}>
    <option value="auto">Auto · compatible model split</option><option value="tensor">Tensor · split layers across GPUs</option><option value="pipeline">Pipeline · consecutive layers per GPU</option>
  </select></Field> : <p>Ollama spreads the model across all selected GPUs. Its layer split is not a hard VRAM limit.</p>)}
  {!replicated && engine === 'VLLM' && <p className="muted">Auto uses tensor parallelism when model dimensions divide evenly, otherwise supported pipeline parallelism. Pipeline may be preferable without fast GPU interconnects; performance depends on the model and topology.</p>}
  {!offloading && <Field label={replicated ? 'System RAM per copy (MiB)' : 'Multi-GPU system RAM (MiB)'}><input type="number" min="1100" step="100" max={typeof ramMaximumMi === 'number' ? Math.floor(ramMaximumMi / 100) * 100 : undefined} value={ramMi} onChange={(event) => onRam(Number(event.target.value))} /></Field>}
  <p className="muted">{replicated ? 'Maximum system RAM per copy' : 'Unreserved system RAM on the selected node'}: {typeof ramMaximumMi === 'number' ? formatMi(ramMaximumMi) : 'not yet verified'}. The API rechecks this limit when saving.</p>
  <p className="muted">{replicated ? `${count} complete copies · ${formatMi(ramMi)} RAM each · ${formatMi(ramMi * count)} total host RAM. CPU settings apply to each copy.` : 'System RAM and CPU reservations apply once to the whole model Pod, not once per GPU.'}</p>
</section> : null;
const modelEditRevision = (activation: ModelActivation) => {
  const {uid, generation, resourceVersion} = activation.metadata ?? {};
  return uid && Number.isInteger(generation) && Number(generation) > 0
    ? `generation:${uid}:${generation}`
    : String(resourceVersion ?? '');
};
const parseMemoryMi = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value));
  const match = String(value ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti)?$/i);
  if (!match) return 0;
  const factors: Record<string, number> = {ki: 1 / 1024, mi: 1, gi: 1024, ti: 1024 * 1024};
  return Math.max(0, Math.round(Number(match[1]) * (factors[(match[2] ?? 'Mi').toLowerCase()] ?? 1)));
};
const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

const fallbackKvCacheOptions = (engine: string) => engine === 'OLlama'
  ? [{value: 'f16', label: 'Standard - F16', description: 'Highest cache precision.'}]
  : [{value: 'auto', label: 'Standard - model precision', description: 'Uses the model precision selected by vLLM.'}];

const EstimateBreakdown = ({estimate, budgetDevices = 1}: {estimate: MemoryEstimate; budgetDevices?: number}) => {
  const offloading = estimate.offloading;
  const runtime = estimate.runtimeDetails ?? {};
  const kvBudgetMi = Number(estimate.kvCacheMi ?? 0);
  const hasTheoreticalKv = estimate.theoreticalKvCacheMi !== null && estimate.theoreticalKvCacheMi !== undefined;
  const baseKvMi = Number(hasTheoreticalKv ? estimate.theoreticalKvCacheMi : kvBudgetMi);
  const hybridSafetyMi = Number(estimate.hybridAllocatorSafetyMi ?? Math.max(0, kvBudgetMi - baseKvMi));
  const attentionKvMi = Number(runtime.attentionKvCacheMi ?? 0);
  const recurrentStateMi = Number(runtime.recurrentStateMi ?? 0);
  const kvSavingsMi = Number(estimate.kvCacheSavingsMi ?? 0);
  const hasDetailedOllamaCache = attentionKvMi > 0 || recurrentStateMi > 0;
  const runtimeParts = [
    {label: 'Compile / warm-up', key: 'compileReserveMi', value: Number(runtime.compileReserveMi ?? 0)},
    {label: 'Multimodal processor cache', key: 'multimodalReserveMi', value: Number(runtime.multimodalReserveMi ?? 0)},
    {label: 'Quantization working copy', key: 'unpackReserveMi', value: Number(runtime.unpackReserveMi ?? 0)},
    {label: 'Engine runtime reserve', key: 'engineRuntimeReserveMi', value: Number(runtime.engineRuntimeReserveMi ?? 0)},
  ].filter((item) => item.value > 0);
  const explainedRuntimeMi = runtimeParts.reduce((total, item) => total + item.value, 0);
  const otherRuntimeMi = Math.max(0, Number(estimate.reserveMi ?? 0) - explainedRuntimeMi);
  const cards = [
    {label: 'Weights', key: 'weightsMi', value: formatMi(estimate.weightsMi)},
    ...(hasDetailedOllamaCache
      ? [
          {label: 'Attention KV cache', key: 'attentionKvCacheMi', value: formatMi(attentionKvMi)},
          ...(recurrentStateMi > 0 ? [{label: 'Recurrent state cache', key: 'recurrentStateMi', value: formatMi(recurrentStateMi)}] : []),
        ]
      : [{label: hasTheoreticalKv ? 'Theoretical KV cache' : 'Estimated KV cache', key: hasTheoreticalKv ? 'theoreticalKvCacheMi' : 'kvCacheMi', value: formatMi(baseKvMi)}]),
    ...(hybridSafetyMi > 0 ? [{label: 'Hybrid allocator safety', key: 'hybridAllocatorSafetyMi', value: formatMi(hybridSafetyMi)}] : []),
    ...(kvSavingsMi > 0 ? [{label: 'KV cache saving vs F16', key: 'kvCacheSavingsMi', value: formatMi(kvSavingsMi)}] : []),
    ...runtimeParts.map((item) => ({...item, value: formatMi(item.value)})),
    ...(otherRuntimeMi > 0 ? [{label: 'Other runtime reserve', key: 'otherRuntimeMi', value: formatMi(otherRuntimeMi)}] : []),
    ...(Number(estimate.recommendedReserveMi ?? 0) > 0 ? [{label: 'Recommended headroom', key: 'recommendedReserveMi', value: formatMi(estimate.recommendedReserveMi)}] : []),
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ];
  const calculations: Record<string, MemoryCalculation> = {...estimate.calculations, otherRuntimeMi: {
    formula: 'total runtime reserve − runtime components itemized above',
    substitution: `${Number(estimate.reserveMi ?? 0)} − ${explainedRuntimeMi} = ${otherRuntimeMi} MiB`,
    notes: ['This is the unitemized remainder, not another reserve added to the total.'],
  }};
  const offloadCards = offloading ? [
    {label: 'Weights · GPU', key: 'weightsOnGpuMi', value: formatMi(offloading.weightsOnGpuMi)},
    {label: 'Weights · RAM', key: 'weightsOnCpuMi', value: formatMi(offloading.weightsOnCpuMi)},
    {label: 'KV budget · GPU', key: 'kvOnGpuMi', value: formatMi(offloading.kvOnGpuMi)},
    {label: 'KV upper bound · RAM', key: 'kvOnCpuMi', value: formatMi(offloading.kvOnCpuMi)},
    {label: 'GPU runtime reserve', key: 'reserveMi', value: formatMi(estimate.reserveMi)},
    {label: 'GPU recommended headroom', key: 'recommendedReserveMi', value: formatMi(estimate.recommendedReserveMi)},
    {label: 'Host runtime reserve', key: 'hostRuntimeMi', value: formatMi(offloading.hostRuntimeMi)},
    {label: 'RAM startup headroom', key: 'ramHeadroomMi', value: formatMi(offloading.ramRecommendedMi - offloading.ramMinimumMi)},
    {label: 'Download (disk / network)', key: 'downloadBytes', value: formatBytes(estimate.downloadBytes)},
  ] : [];
  return <details>
    <summary>Breakdown</summary>
    {budgetDevices > 1 && <p className="muted">GPU estimates below are per GPU. The total VRAM budget covers {budgetDevices} GPUs; host RAM and download size remain separate.</p>}
    <dl className="facts">{(offloading ? offloadCards : cards).map((item) => <div key={item.key}><dt>{item.label}</dt><dd><MemoryInfo label={item.label} value={item.value} calculation={calculations[item.key]} /></dd></div>)}</dl>
    {offloading && <p className="muted">Planning estimates, not measured usage. Host RAM includes offloaded weights and runtime. Ollama uses GPU-first auto-fit; its displayed weight/cache split is proportional and the exact placement is confirmed only after loading. vLLM weight offloading does not offload KV cache.</p>}
    {hybridSafetyMi > 0 && <p className="muted">Configured KV budget: {formatMi(kvBudgetMi)} = {formatMi(baseKvMi)} theoretical cache + {formatMi(hybridSafetyMi)} compatibility safety for the hybrid vLLM allocator.</p>}
    {!offloading && <p className="muted">Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.</p>}
    {estimate.warnings?.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
  </details>;
};

const EstimatePanel = ({estimate, availableMi, capacityKnown = true, selectedMi, onSelected, hideBreakdown = false, preserveSelectedMi, budgetDevices = 1}: {estimate?: MemoryEstimate; availableMi: number; capacityKnown?: boolean; selectedMi: number; onSelected: (value: number) => void; hideBreakdown?: boolean; preserveSelectedMi?: number; budgetDevices?: number}) => {
  if (!estimate) return <div className="empty compact-empty">Choose a model reference to calculate memory.</div>;
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(0, Math.floor(availableMi / 100) * 100);
  const scaleMaximum = Math.max(100, maximum, minimum, recommended);
  const selectedStep = preserveSelectedMi === selectedMi ? 1 : 100;
  // State, estimates and saved intent remain per device; split-model controls show the group total.
  const total = (value: number) => value * budgetDevices;
  const availablePercent = maximum / scaleMaximum * 100;
  const marker = (value: number) => {
    const percent = Math.min(100, value / scaleMaximum * 100);
    return {left: `${percent}%`, '--marker-label-shift': percent > 85 ? '-100%' : percent < 15 ? '0%' : '-50%'} as CSSProperties;
  };
  return <section className="estimate">
    <header><div><strong>{budgetDevices > 1 ? 'Total VRAM' : estimate.computeTarget === 'cpu' ? 'RAM' : 'VRAM'} reservation</strong><span className="muted">{estimate.confidence ?? 'estimated'} confidence</span></div></header>
    <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Minimum" value={formatMi(total(minimum))} calculation={estimate.calculations?.minimumMi} roundedMi={estimate.minimumMi} budgetDevices={budgetDevices} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Recommended" value={formatMi(total(recommended))} calculation={estimate.calculations?.recommendedMi} roundedMi={estimate.recommendedMi} budgetDevices={budgetDevices} /></strong></div><div><span>100% unreserved</span><strong><MemoryInfo label="100% unreserved" value={capacityKnown ? formatMi(total(maximum)) : 'Unknown'} calculation={unreservedCalculation(capacityKnown ? availableMi : null, budgetDevices)} /></strong></div></div>
    <div className="capacity-scale">
      <div className="capacity-available" style={{width: `${availablePercent}%`}}><input aria-label="Memory reservation" type="range" min={total(100)} max={total(Math.max(100, maximum))} step={total(selectedStep)} disabled={!capacityKnown || maximum < 100} value={total(Math.min(Math.max(100, maximum), Math.max(100, selectedMi)))} onChange={(event) => onSelected(Number(event.target.value) / budgetDevices)} /></div>
      {availablePercent < 100 && <div className="capacity-overflow" style={{left: `${availablePercent}%`}} />}
      <span className="capacity-marker minimum" style={marker(minimum)}><span>Minimum {formatMi(total(minimum))}</span></span>
      <span className="capacity-marker recommended" style={marker(recommended)}><span>Recommended {formatMi(total(recommended))}</span></span>
      <span className="capacity-marker available" style={marker(maximum)}><span>{capacityKnown ? `100% ${formatMi(total(maximum))}` : 'Capacity unknown'}</span></span>
    </div>
    <div className="slider-labels"><span>Selected: {formatMi(total(selectedMi))}</span><span>{!capacityKnown ? 'Capacity unknown' : maximum > 0 ? `${Math.round(selectedMi / maximum * 100)}% of unreserved memory` : `< ${total(100)} MiB unreserved`}</span></div>
    <Field label={budgetDevices > 1 ? 'Total VRAM budget (MiB)' : estimate.computeTarget === 'cpu' ? 'RAM budget (MiB)' : 'VRAM budget (MiB)'}><input type="number" min={total(100)} step={total(selectedStep)} value={total(selectedMi)} onChange={(event) => onSelected(Number(event.target.value) / budgetDevices)} /></Field>
    <div className="button-grid three"><Button type="button" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, minimum) : minimum)}>Minimum</Button><Button type="button" variant="primary" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, recommended) : recommended)}>Recommended</Button><Button type="button" disabled={!capacityKnown || maximum < 100} onClick={() => onSelected(maximum)}>100%</Button></div>
    {capacityKnown && (minimum > maximum || recommended > maximum) && <div className="notice notice-warn">{minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.</div>}
    {!hideBreakdown && <EstimateBreakdown estimate={estimate} budgetDevices={budgetDevices} />}
  </section>;
};

const DiscoveryMetadata = ({item}: {item?: DiscoveryItem}) => item ? <div className="tag-list discovery-meta">
  <span className="tag">Publisher: {item.author ?? item.repo.split('/')[0]}</span>
  {item.format && <span className="tag">Format: {item.format}</span>}
  {quantizationText(item.quantization) && <span className="tag">Quantization: {quantizationText(item.quantization)}</span>}
  {item.trustStatus && <span className="tag">Trust: {item.trustStatus}</span>}
  {(item.sizeLabel || item.downloadBytes) && <span className="tag">Download: {item.sizeLabel ?? formatBytes(item.downloadBytes)}</span>}
  {item.revision && <span className="tag">Revision: {item.revision}</span>}
  {item.modelMaxContext && <span className="tag">Model context: {item.modelMaxContext.toLocaleString()}{item.modelContextSource === 'base-model' ? ' · base model' : ''}</span>}
</div> : null;

type ModelLifecycleAction = 'start' | 'stop' | 'restart';

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const LocalModelForm = ({models, onClose, onCreated}: {models: ModelsPayload; onClose: () => void; onCreated: () => Promise<void>}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const hasRealtime = Object.keys(models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {}).length > 0;
  const experimentalEngines = new Set(['VLLM-Omni']);
  const engineDisplayName = (engine: string) => engine === 'VLLM-Omni' ? 'vLLM-Omni' : models.computeTargets.engineCatalog?.[engine]?.displayName ?? engine;
  const engineOptions = [...new Set([
    ...Object.keys(models.computeTargets.engineCatalog ?? {}),
    ...availableTargets.flatMap((target) => target.declaredEngines ?? target.engines ?? []),
  ])].flatMap((engine) => engine === 'VLLM' && hasRealtime ? [engine, 'VLLM-Omni'] : [engine])
    .sort((a, b) => Number(experimentalEngines.has(a)) - Number(experimentalEngines.has(b))
      || engineDisplayName(a).localeCompare(engineDisplayName(b), 'en', {sensitivity: 'base'}));
  const [selectedEngine, setEngine] = useState(engineOptions[0] ?? 'VLLM');
  const engine = engineOptions.includes(selectedEngine) ? selectedEngine : engineOptions[0] ?? 'VLLM';
  return <>
    <Field label="Inference Engine"><select value={engine} onChange={(event) => setEngine(event.target.value)}>{engineOptions.map((item) => <option key={item} value={item}>{experimentalEngines.has(item) ? '(Experimental) ' : ''}{engineDisplayName(item)}</option>)}</select></Field>
    {engine === 'VLLM-Omni'
      ? <RealtimeModelForm models={models} onClose={onClose} onSaved={onCreated} />
      : <StandardLocalModelForm models={models} engine={engine} onClose={onClose} onCreated={onCreated} />}
  </>;
};

const StandardLocalModelForm = ({models, engine, onClose, onCreated}: {models: ModelsPayload; engine: string; onClose: () => void; onCreated: () => Promise<void>}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const targetSupportsEngine = (target: typeof availableTargets[number], candidate: string) => (target.engines ?? []).includes(candidate)
    || (target.declaredEngines ?? []).includes(candidate)
    || Boolean(target.engineAvailability?.[candidate]);
  const targetEngineAvailable = (target: typeof availableTargets[number] | undefined, candidate: string) => Boolean(target)
    && (target?.engineAvailability?.[candidate]?.available ?? target?.engines?.includes(candidate) ?? false);
  const targets = availableTargets.filter((target) => targetSupportsEngine(target, engine));
  const [computeTarget, setComputeTarget] = useState(targets.find((target) => targetEngineAvailable(target, engine) && !slotsFull(target, engine))?.id ?? '');
  const selectedTarget = availableTargets.find((target) => target.id === computeTarget);
  const cpuSettings = useCpuSettings(undefined, models, engine, computeTarget);
  const deploymentSettings = useVllmDeploymentSettings(undefined, models, engine, computeTarget);
  const nvidiaCards = (models.computeMemory?.devices ?? []).filter((d) => d.computeTarget === 'nvidia-gpu' && d.gpuDevice && d.slots?.scope === 'device');
  const [gpuKey, setGpuKey] = useState(() => {const card = nvidiaCards.find((d) => (d.slots?.free ?? 0) > 0); return card?.gpuDevice ? nvidiaCardKey(card.gpuDevice) : '';});
  const gpuKeys = gpuKey ? gpuKey.split(',') : [];
  const selectedCards = computeTarget === 'nvidia-gpu' ? gpuKeys.flatMap((key) => nvidiaCards.filter((d) => nvidiaCardKey(d.gpuDevice!) === key)) : [];
  const selectedCard = selectedCards[0];
  const gpuCount = Math.max(1, selectedCards.length);
  const multiGpu = models.computeTargets.engineCatalog?.[engine]?.multiGpu;
  const [parallelism, setParallelism] = useState<NonNullable<VllmConfiguration['parallelism']>>('auto');
  const [gpuDeployment, setGpuDeployment] = useState<GpuDeployment>('single');
  const replicated = gpuDeployment === 'replicated';
  const gpuPayload = groupSettings(selectedCards.map((card) => card.gpuDevice!), gpuDeployment);
  const cardRequired = computeTarget === 'nvidia-gpu' && (nvidiaCards.length > 0 || !!gpuKey);
  const noSlots = slotsFull(selectedTarget, engine) || cardRequired && (!selectedCard || selectedCards.length !== gpuKeys.length || selectedCards.some((card) => !card.slots?.free || card !== selectedCard && !matchingNvidiaCards(selectedCard, card)));
  const automaticGpuPool = computeTarget === 'nvidia-gpu' && sharedSlotPools(models.computeMemory?.devices ?? []).some((pool) =>
    pool.deviceIds.some((id) => models.computeMemory?.devices?.some((device) => device.id === id && device.computeTarget === computeTarget)));
  const engineUnavailable = !targetEngineAvailable(selectedTarget, engine);
  const kvCacheOptions = useMemo(
    () => selectedTarget?.kvCacheTypes?.[engine] ?? fallbackKvCacheOptions(engine),
    [engine, selectedTarget],
  );
  const [kvCacheType, setKvCacheType] = useState(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
  const provider = engine === 'OLlama' ? 'ollama' : 'huggingface';
  const [source, setSource] = useState<'search' | 'preset' | 'direct'>('search');
  const [name, setName] = useState(''); const [manualTask, setManualTask] = useState({url: '', value: ''});
  const [taskDetection, setTaskDetection] = useState<{url: string; value?: 'chat' | 'embedding' | null}>({url: ''});
  const [contextWindow, setContextWindow] = useState(4096); const [maxNumSeqs, setMaxNumSeqs] = useState(1);
  const [url, setUrl] = useState(''); const [presetId, setPresetId] = useState(''); const [artifactId, setArtifactId] = useState('');
  const [search, setSearch] = useState('Qwen'); const [popular, setPopular] = useState<DiscoveryItem[]>([]);
  const [searchResults, setSearchResults] = useState<DiscoveryItem[]>([]); const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState(''); const [artifacts, setArtifacts] = useState<DiscoveryItem[]>([]);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null); const [selectedSearchArtifact, setSelectedSearchArtifact] = useState('');
  const [artifactBaseModel, setArtifactBaseModel] = useState<DiscoveryItem>();
  const [estimate, setEstimate] = useState<MemoryEstimate>(); const [selectedMi, setSelectedMi] = useState(100);
  const [cpuOffloading, setCpuOffloading] = useState(false);
  const [offloadEstimate, setOffloadEstimate] = useState<MemoryEstimate>();
  const [hostMemoryMi, setHostMemoryMi] = useState(16400);
  const [hostMemoryEdited, setHostMemoryEdited] = useState(false);
  const [offloadError, setOffloadError] = useState<unknown>(null);
  const [formError, setFormError] = useState<unknown>(null); const [searching, setSearching] = useState(false); const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  useEffect(() => {
    const declaredTargets = availableTargets.filter((target) => targetSupportsEngine(target, engine));
    if (!declaredTargets.some((target) => target.id === computeTarget && targetEngineAvailable(target, engine) && !slotsFull(target, engine))) {
      setComputeTarget(declaredTargets.find((target) => targetEngineAvailable(target, engine) && !slotsFull(target, engine))?.id ?? '');
    }
    setUrl(''); setPresetId(''); setArtifactId(''); setSearchResults([]); setArtifacts([]); setEstimate(undefined);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!kvCacheOptions.some((option) => option.value === kvCacheType)) {
      setKvCacheType(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
    }
  }, [computeTarget, engine, kvCacheOptions, kvCacheType]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({provider, engine, computeTarget, modelType: '', limit: '8'});
    api.popularModels(params).then((result) => { if (!cancelled) setPopular(result.results); }).catch(() => { if (!cancelled) setPopular([]); });
    return () => { cancelled = true; };
  }, [provider, engine, computeTarget]);

  const presets = useMemo(() => Object.entries(models.presets).flatMap(([id, preset]) => matchingVariants(preset.variants, engine, computeTarget).map((variant) => ({id, label: preset.displayName ?? id, variant, modelType: String(variant.modelType ?? preset.type ?? '')}))), [computeTarget, engine, models.presets]);
  const selectedPreset = presets.find((item) => item.id === presetId);
  const presetTask = source === 'preset' && ['chat', 'embedding'].includes(selectedPreset?.modelType ?? '') ? selectedPreset!.modelType : '';
  const detectedTask = presetTask || (taskDetection.url === url ? taskDetection.value : '') || '';
  const manualModelType = manualTask.url === url ? manualTask.value : '';
  const modelType = detectedTask || manualModelType;
  const requestedModelType = presetTask || (detectedTask ? 'auto' : manualModelType || 'auto');
  const selectedPresetArtifact = selectedArtifact(selectedPreset?.variant, artifactId);
  const selectedSearchModel = searchResults.find((item) => item.repo === searchModel);
  const targetDevices = selectedCard ? selectedCards : models.computeMemory?.devices?.filter((device) => device.computeTarget === computeTarget || device.id === computeTarget) ?? [];
  const capacities = [...targetDevices.map((device) => gpuCount > 1 && typeof device.unreservedMi === 'number'
    ? Math.min(device.unreservedMi, nvidiaPhysicalCapacityMi(device) ?? 0) : device.unreservedMi),
    ...(cardRequired ? [] : [estimate?.maximumMi])].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const capacityKnown = capacities.length > 0 && (!cardRequired || capacities.length === selectedCards.length);
  const availableMi = capacityKnown ? (cardRequired ? Math.min(...capacities) : Math.max(...capacities)) : 0;
  const selectedDiscoveryArtifact = artifacts.find((item) => item.id === selectedSearchArtifact);
  const supportsOffloading = computeTarget === 'nvidia-gpu';
  const offload = supportsOffloading && cpuOffloading ? offloadEstimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor((offload?.ramMaximumMi ?? 0) / 100) * 100);
  const activeEstimate = cpuOffloading ? offloadEstimate : estimate;
  const memoryRisks = activeEstimate ? [
    ...(activeEstimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(selectedMi < roundMemory(activeEstimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(cpuOffloading && offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ] : [];
  const hasMemoryRisk = memoryRisks.length > 0;
  const invalidBudget = (cardRequired && gpuDeployment !== 'single' && gpuCount < 2) || !Number.isInteger(selectedMi) || selectedMi < 100 || selectedMi % 100 !== 0
    || ((cpuOffloading || gpuCount > 1) && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < (gpuCount > 1 ? 1100 : 100) || hostMemoryMi % 100 !== 0))
    || (gpuCount > 1 && (selectedCards.some((device) => selectedMi > Number(nvidiaPhysicalCapacityMi(device) ?? 0))
      || (typeof activeEstimate?.systemMemoryMaximumMi === 'number' && hostMemoryMi > activeEstimate.systemMemoryMaximumMi)));

  useEffect(() => { setCpuOffloading(false); setOffloadEstimate(undefined); setHostMemoryEdited(false); }, [engine, computeTarget]);
  useEffect(() => { setHostMemoryEdited(false); }, [url]);
  useEffect(() => {
    if (!hostMemoryEdited && offload) setHostMemoryMi(roundMemory(offload.ramRecommendedMi));
  }, [offload, hostMemoryEdited]);
  useEffect(() => {
    setOffloadEstimate(undefined); setOffloadError(null);
    if (!cpuOffloading || !supportsOffloading || !url) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType: requestedModelType, kvCacheType, cpuOffloading: true, vramMi: selectedMi, ...gpuPayload, ...(gpuCount > 1 && !replicated && engine === 'VLLM' ? {vllm: {parallelism}} : {})});
        if (!cancelled) { setOffloadEstimate(result); setTaskDetection({url, value: result.detectedModelType}); }
      } catch (reason) { if (!cancelled) setOffloadError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cpuOffloading, supportsOffloading, engine, computeTarget, url, contextWindow, maxNumSeqs, requestedModelType, kvCacheType, selectedMi, gpuKey, parallelism, gpuDeployment]);

  const applyModel = (nextUrl: string, artifact?: ModelArtifact, variant?: ModelVariant, baseModel?: DiscoveryItem) => {
    setUrl(nextUrl); setName((current) => current || safeModelName(nextUrl));
    const context = [artifact?.modelMaxContext, variant?.contextWindow, baseModel?.modelMaxContext]
      .map((value) => Number(value ?? 0))
      .find((value) => Number.isFinite(value) && value > 0) ?? 0;
    if (context > 0) {
      setContextWindow(context);
    }
    if (variant?.maxNumSeqs) {
      setMaxNumSeqs(variant.maxNumSeqs);
    }
  };

  useEffect(() => {
    if (source !== 'preset' || !selectedPreset) return;
    applyModel(selectedPresetArtifact?.url ?? selectedPreset.variant.url ?? '', selectedPresetArtifact, selectedPreset.variant);
  }, [artifactId, presetId, source]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!url) { setEstimate(undefined); return; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType: requestedModelType, kvCacheType, ...gpuPayload, ...(gpuCount > 1 && !replicated && engine === 'VLLM' ? {vllm: {parallelism}} : {})});
        if (!cancelled) {
          setEstimate(result);
          setTaskDetection({url, value: result.detectedModelType});
          const maximum = capacityKnown ? Math.max(100, Math.floor(availableMi / 100) * 100) : roundMemory(result.recommendedMi);
          setSelectedMi((current) => Math.min(maximum, cpuOffloading ? current : roundMemory(result.recommendedMi)));
          setFormError(null);
        }
      } catch (reason) { if (!cancelled) setFormError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [computeTarget, contextWindow, engine,  kvCacheType, maxNumSeqs, requestedModelType, url, cpuOffloading, gpuKey, parallelism, gpuDeployment]);

  const searchParams = (query: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, q: query, engine, computeTarget, modelType: '', limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const artifactParams = (repo: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, repo, engine, computeTarget, modelType: '', limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const runSearch = async (query = search, append = false) => {
    setSearching(true); setFormError(null);
    if (!append) { setArtifacts([]); setSelectedSearchArtifact(''); setArtifactBaseModel(undefined); }
    try {
      const result = await api.searchModels(searchParams(query, append ? searchCursor : null));
      const combined = append ? [...searchResults, ...result.results] : result.results;
      setSearchResults(combined); setSearchCursor(result.nextCursor ?? null);
      if (!append) { const first = result.results[0]?.repo ?? ''; setSearchModel(first); if (first) await loadArtifacts(first, false); }
    } catch (reason) { setFormError(reason); } finally { setSearching(false); }
  };
  const loadArtifacts = async (repo: string, append = false) => {
    setSearchModel(repo); setFormError(null); setLoadingArtifacts(true);
    try {
      const result = await api.modelArtifacts(artifactParams(repo, append ? artifactCursor : null));
      const combined = append ? [...artifacts, ...result.artifacts] : result.artifacts;
      setArtifacts(combined); setArtifactCursor(result.nextCursor ?? null); if (!append) setArtifactBaseModel(result.baseModel);
      if (!append) {
        const first = result.artifacts.find((item) => item.compatibility !== 'incompatible') ?? result.artifacts[0];
        setSelectedSearchArtifact(first?.id ?? ''); if (first?.url) applyModel(first.url, first, undefined, result.baseModel ?? selectedSearchModel);
      }
    } catch (reason) { setFormError(reason); } finally { setLoadingArtifacts(false); }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!url) throw new Error('Select or enter a model reference.');
      if (!modelType) throw new Error('Choose a model task when it cannot be detected.');
      if (cpuSettings.invalid) throw new Error('Enter a valid CPU reservation and optional limit.');
      if (deploymentSettings.invalid) throw new Error('Select a vision attention backend offered by the runtime catalog.');
      if (noSlots) throw new Error('No free GPU model slots. Remove a model or change GPU sharing in System > Hardware.');
      if (engineUnavailable) throw new Error(selectedTarget?.engineAvailability?.[engine]?.message ?? 'The selected engine and hardware combination is not available.');
      if (invalidBudget) throw new Error('Enter positive memory budgets in steps of 100 MiB.');
      const target = availableTargets.find((item) => item.id === computeTarget);
      if (!target?.available || !targetSupportsEngine(target, engine)) throw new Error('The selected engine and hardware combination is not available.');
      const local: Record<string, unknown> = {modelType: detectedTask ? 'auto' : modelType, computeTarget, engine};
      if (cardRequired && selectedCard) Object.assign(local, gpuPayload);
      if (cpuSettings.payload) local.cpuResources = cpuSettings.payload;
      if (deploymentSettings.payload) local.vllm = deploymentSettings.payload;
      if (gpuCount > 1) {
        local.memoryRequiredMi = hostMemoryMi;
        if (engine === 'VLLM' && !replicated) local.vllm = {parallelism};
      }
      local.contextWindow = contextWindow;
      local.maxNumSeqs = maxNumSeqs;
      local.kvCacheType = kvCacheType;
      if (hasMemoryRisk) local.allowMemoryRisk = true;
      if (target.kind === 'cpu' || computeTarget === 'cpu') local.memoryRequiredMi = selectedMi; else local.vram = `${selectedMi}Mi`;
      if (supportsOffloading) {
        local.cpuOffloading = cpuOffloading;
        if (cpuOffloading) {
          local.memoryRequiredMi = hostMemoryMi;
        }
      }
      if (source === 'preset' && presetId) { local.preset = presetId; if (artifactId) local.artifact = artifactId; } else local.url = url;
      await api.createLocalModel({name: name || safeModelName(url), enabled: true, targetNamespace: 'ai', local});
    },
    onSuccess: async () => { await onCreated(); onClose(); },
  });

  return <form className="stack" onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}>
    <div className="form-grid">
      <Field label="Hardware"><select value={computeTarget} aria-describedby={[noSlots ? 'model-slots-full' : '', automaticGpuPool ? 'model-automatic-gpu' : ''].filter(Boolean).join(' ') || undefined} onChange={(event) => setComputeTarget(event.target.value)}>
        {!computeTarget && <option value="" disabled>No hardware with free slots</option>}
        {targets.map((target) => {const slots = targetSlots(target, engine); const available = targetEngineAvailable(target, engine); return <option key={target.id} value={target.id} disabled={!available || slotsFull(target, engine)}>{target.displayName ?? target.id}{!available ? ` · unavailable: ${target.engineAvailability?.[engine]?.message ?? 'engine is not eligible'}` : slots ? slots.free === 0 ? ` · no free slots (${slots.used}/${slots.total} occupied)` : ` · ${slots.free}/${slots.total} slots free` : ''}</option>;})}
      </select></Field>
      <Field label="Model source"><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="search">{provider === 'ollama' ? 'Ollama Library' : 'Hugging Face search'}</option><option value="preset">Tested preset</option><option value="direct">Direct reference</option></select></Field>
    </div>

    {cardRequired && <>
      {multiGpu?.computeTargets.includes(computeTarget) && <GpuDeploymentSelect mode={gpuDeployment} count={gpuCount} replication={multiGpu.deploymentModes?.includes('replicated') ?? false} onChange={(mode) => {setGpuDeployment(mode); if (mode === 'single') setGpuKey(gpuKeys[0] ?? '');}} />}
      <NvidiaGpuGroupSelect cards={nvidiaCards} values={gpuKeys} onChange={(keys) => {setGpuKey(keys.join(',')); if (keys.length > 1 && gpuDeployment === 'single') setGpuDeployment('split'); if (keys.length === 1 && gpuDeployment === 'split') setGpuDeployment('single');}} maximum={multiGpu?.computeTargets.includes(computeTarget) ? multiGpu.maxDevices : 1} replicated={replicated} />
    </>}
    {noSlots && <p id="model-slots-full" className="notice notice-warn" role="status">No free GPU model slots. Remove a model or change GPU sharing in System &gt; Hardware.</p>}
    {automaticGpuPool && <p id="model-automatic-gpu" className="notice" role="status">Automatic GPU assignment: this hardware choice selects a node scheduling pool, not an individual card. Enable NVIDIA DRA card selection in System &gt; Hardware to choose a specific card.</p>}
    {engineUnavailable && <p className="notice notice-warn" role="status">{selectedTarget?.engineAvailability?.[engine]?.message ?? `${engine} is not available on the selected hardware.`}</p>}

    {source === 'search' && <Panel title={provider === 'ollama' ? 'Ollama Library' : 'Hugging Face'} className="nested-panel">
      <div className="search-row"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Qwen, GLM, DeepSeek…" /><Button type="button" variant="primary" disabled={searching || search.trim().length < 2} onClick={() => runSearch()}>{searching ? 'Searching…' : 'Search'}</Button></div>
      <div className="quick-list"><span className="muted">Model families</span>{['Qwen', 'DeepSeek', 'GLM', 'Llama', 'Gemma', 'Mistral'].map((item) => <Button key={item} type="button" variant="ghost" onClick={() => { setSearch(item); void runSearch(item); }}>{item}</Button>)}</div>
      <ErrorNotice error={formError} />
      {popular.length > 0 && <div className="quick-list"><span className="muted">{provider === 'ollama' ? 'Popular on Ollama' : 'Trending on Hugging Face'}</span>{popular.slice(0, 8).map((item) => <Button key={item.repo} type="button" variant="ghost" onClick={() => { setSearch(item.repo); void runSearch(item.repo); }}>{item.name ?? item.repo}</Button>)}</div>}
      {searchResults.length > 0 && <div className="stack compact discovery-selects">
        <Field label="Matching model"><select value={searchModel} onChange={(event) => loadArtifacts(event.target.value, false)}>{searchResults.map((item) => <option key={item.repo} value={item.repo}>{item.repo}{item.pulls ? ` · ${item.pulls.toLocaleString()} pulls` : ''}</option>)}</select></Field>
        {searchCursor && <Button type="button" variant="ghost" disabled={searching} onClick={() => runSearch(search, true)}>Load more models</Button>}
        <Field label={provider === 'ollama' ? 'Tag / quantization' : 'Quantization / artifact'}><select value={selectedSearchArtifact} disabled={loadingArtifacts} onChange={(event) => { const id = event.target.value; setSelectedSearchArtifact(id); const item = artifacts.find((artifact) => artifact.id === id); if (item?.url) applyModel(item.url, item, undefined, artifactBaseModel ?? selectedSearchModel); }}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.repo}{item.sizeLabel ? ` · ${item.sizeLabel}` : item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : ''}</option>)}</select></Field>
        {artifactCursor && <Button type="button" variant="ghost" disabled={loadingArtifacts} onClick={() => loadArtifacts(searchModel, true)}>Load more {provider === 'ollama' ? 'tags' : 'quantizations'}</Button>}
        <DiscoveryMetadata item={selectedDiscoveryArtifact} />
      </div>}
      {!searching && !searchResults.length && <p className="muted">Enter at least two characters or choose a model family or popular model.</p>}
    </Panel>}

    {source === 'preset' && <div className="stack compact discovery-selects"><Field label="Preset"><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setArtifactId(''); }}><option value="">Select a tested preset</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="Precision / Quantization"><select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} disabled={!selectedPreset}><option value="">Default artifact</option>{selectedPreset?.variant.artifacts?.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></Field></div>}
    {source === 'direct' && <Field label={engine === 'OLlama' ? 'Ollama model reference' : 'Hugging Face URL'}><input value={url} onChange={(event) => { const nextUrl = event.target.value; setUrl(nextUrl); if (nextUrl) setName((current) => current || safeModelName(nextUrl)); }} placeholder={engine === 'OLlama' ? 'ollama://qwen3.5:9b' : 'hf://Qwen/Qwen3.6-27B'} required /></Field>}

    {url && <section className="stack compact" aria-label="Model task detection">
      {detectedTask ? <p role="status">Model task: <strong>{detectedTask === 'chat' ? 'Chat' : 'Embedding'}</strong> · detected automatically</p>
        : taskDetection.url === url || formError ? <>
          <Field label="Model task"><select value={manualModelType} onChange={(event) => setManualTask({url, value: event.target.value})} required>
            <option value="">Select the model task</option><option value="chat">Chat</option><option value="embedding">Embedding</option>
          </select></Field>
          <p className="muted">The model metadata does not identify its task. Choose Chat for text generation or Embedding for document search.</p>
        </> : <p role="status">Detecting model task…</p>}
    </section>}

    <div className="form-grid three"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Selected URL"><input value={url} readOnly /></Field><><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="KV Cache"><select value={kvCacheType} onChange={(event) => setKvCacheType(event.target.value)}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></></div>
    <>
      <p className="muted">{kvCacheOptions.find((option) => option.value === kvCacheType)?.description} Attention-cache values are recalculated immediately; recurrent state and runtime reserve remain separate.</p>
      {gpuCount > 1 && <p role="status">VRAM per GPU: {formatMi(selectedMi)} · {gpuCount} GPUs · {formatMi(selectedMi * gpuCount)} planned total. The smallest selected card limits this control.</p>}
      <EstimatePanel estimate={cpuOffloading ? offloadEstimate ?? estimate : estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={setSelectedMi} hideBreakdown={cpuOffloading} budgetDevices={replicated ? 1 : gpuCount} />
    </>
    {supportsOffloading && <Panel title="CPU offloading" className="nested-panel">
      <label className="check-field"><input type="checkbox" checked={cpuOffloading} onChange={(event) => setCpuOffloading(event.target.checked)} />Use additional system RAM</label>
      <p className="muted">Stores part of the model in this GPU node's RAM. This can run larger models, but may substantially reduce response speed. No disk swap or RAM from another node is used.</p>
      {cpuOffloading && <>
        {!offload && !offloadError && <p role="status">Calculating the RAM / VRAM allocation…</p>}
        {offload && <section className="estimate stack compact">
          <header><strong>Host RAM reservation</strong><p className="muted">Includes offloading and runtime</p></header>
          <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Host RAM minimum" value={formatMi(offload.ramMinimumMi)} calculation={offloadEstimate?.calculations?.ramMinimumMi} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Host RAM recommended" value={formatMi(offload.ramRecommendedMi)} calculation={offloadEstimate?.calculations?.ramRecommendedMi} /></strong></div><div><span>100% unreserved on an eligible GPU node</span><strong><MemoryInfo label="Unreserved host RAM" value={offload.ramMaximumMi === null ? 'Unknown' : formatMi(hostMaximum)} calculation={unreservedCalculation(offload.ramMaximumMi)} /></strong></div></div>
          <input aria-label="Host RAM reservation" type="range" min="100" step="100" max={Math.max(100, hostMaximum)} value={Math.min(Math.max(100, hostMaximum), hostMemoryMi)} disabled={!hostMaximum} onChange={(event) => { setHostMemoryEdited(true); setHostMemoryMi(Number(event.target.value)); }} />
          <Field label="Host RAM budget (MiB)"><input type="number" min="100" step="100" value={hostMemoryMi} onChange={(event) => { setHostMemoryEdited(true); setHostMemoryMi(Number(event.target.value)); }} /></Field>
          <Button type="button" onClick={() => { setHostMemoryEdited(false); setHostMemoryMi(roundMemory(offload.ramRecommendedMi)); }}>Use recommended RAM allocation</Button>
          <p className="muted">The GPU budget above is preserved. Kubernetes reserves this host RAM on the same node as the GPU; the estimate uses the largest eligible node, not a cluster-wide sum.</p>
          {engine === 'OLlama' && <p className="muted">Ollama always uses GPU-first auto-fit and places as many layers in actual free VRAM as possible. The selected values remain planning and Kubernetes host-memory budgets; the loaded model's effective split is shown separately.</p>}
        </section>}
        {offloadEstimate && <EstimateBreakdown estimate={offloadEstimate} budgetDevices={replicated ? 1 : gpuCount} />}
      </>}
      <ErrorNotice error={offloadError} />
    </Panel>}
    <AdvancedModelSettings cpuSettings={cpuSettings} deploymentSettings={deploymentSettings}><MultiGpuSettings count={gpuCount} engine={engine} strategy={parallelism} onStrategy={setParallelism} ramMi={hostMemoryMi} onRam={setHostMemoryMi} offloading={cpuOffloading} ramMaximumMi={activeEstimate?.systemMemoryMaximumMi} replicated={replicated} /></AdvancedModelSettings>
    <ErrorNotice error={source === 'search' ? createMutation.error : formError ?? createMutation.error} />
    {hasMemoryRisk && <div id="model-memory-risk" className="notice notice-warn" role="note"><strong>Memory warning — you can still try to start this model.</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul><p>Adding it accepts this risk. The pod may remain Pending, fail with out-of-memory errors or restart. Requests and limits stay at your selected budgets; a successful start is not guaranteed.</p></div>}
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} aria-describedby={[noSlots ? 'model-slots-full' : '', hasMemoryRisk ? 'model-memory-risk' : ''].filter(Boolean).join(' ') || undefined} disabled={createMutation.isPending || !url || !modelType || invalidBudget || cpuSettings.invalid || deploymentSettings.invalid || !selectedTarget || noSlots || engineUnavailable}>{hasMemoryRisk && <span aria-hidden="true">⚠ </span>}Add Local Model</Button></div>
  </form>;
};

const ExternalModelForm = ({onClose, onCreated}: {onClose: () => void; onCreated: () => Promise<void>}) => {
  const [name, setName] = useState(''); const [model, setModel] = useState('openai/gpt-4o-mini'); const [apiBase, setApiBase] = useState('https://api.openai.com/v1'); const [apiKey, setApiKey] = useState(''); const [modelType, setModelType] = useState('chat'); const [contextWindow, setContextWindow] = useState(128000);
  const mutation = useMutation({mutationFn: () => api.createExternalModel({name, enabled: true, targetNamespace: 'ai', external: {model, apiBase, modelType, contextWindow}, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onCreated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Optional when supplied elsewhere" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Add External Model</Button></div></form>;
};

const StandardLocalModelEditForm = ({activation, models, onClose, onUpdated}: {activation: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const name = String(activation.metadata?.name ?? '');
  const local = (activation.spec?.local ?? {}) as Record<string, unknown>;
  const status = (activation.status ?? {}) as Record<string, unknown>;
  const [initial] = useState(() => {
    const computeTarget = String(local.computeTarget ?? status.computeTarget ?? 'nvidia-gpu');
    const engine = String(local.engine ?? status.engine ?? 'VLLM');
    const budget = computeTarget === 'cpu'
      ? parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi)
      : parseMemoryMi(local.vramMi ?? local.vram ?? status.vramRequiredMi);
    return {
      revision: modelEditRevision(activation), computeTarget, engine,
      modelType: String(local.modelType ?? 'chat'), contextWindow: Number(local.contextWindow ?? 4096),
      maxOutputTokens: local.maxOutputTokens ? String(local.maxOutputTokens) : '', maxNumSeqs: Number(local.maxNumSeqs ?? 1),
      kvCacheType: String(local.kvCacheType ?? (engine === 'OLlama' ? 'f16' : 'auto')),
      selectedMi: Math.max(100, budget || 100), cpuOffloading: local.cpuOffloading === true,
      hostMemoryMi: Math.max(100, parseMemoryMi(local.memoryRequiredMi ?? status.memoryRequiredMi) || 16400),
      allowMemoryRisk: local.allowMemoryRisk === true,
      gpuKey: computeTarget === 'nvidia-gpu' ? savedGpuKeys(local, status) : '',
      gpuDeployment: (local.gpuDeployment ?? (((local.gpuDevices as unknown[] | undefined)?.length ?? 0) > 1 ? 'split' : 'single')) as GpuDeployment,
      parallelism: (asRecord(local.vllm).parallelism ?? 'auto') as NonNullable<VllmConfiguration['parallelism']>,
      ownActive: activation.spec?.enabled !== false,
    };
  });
  const [modelType, setModelType] = useState(initial.modelType);
  const [contextWindow, setContextWindow] = useState(initial.contextWindow);
  const [maxOutputTokens, setMaxOutputTokens] = useState(initial.maxOutputTokens);
  const [maxNumSeqs, setMaxNumSeqs] = useState(initial.maxNumSeqs);
  const [kvCacheType, setKvCacheType] = useState(initial.kvCacheType);
  const [selectedMi, setSelectedMi] = useState(initial.selectedMi);
  const [cpuOffloading, setCpuOffloading] = useState(initial.cpuOffloading);
  const [hostMemoryMi, setHostMemoryMi] = useState(initial.hostMemoryMi);
  const [gpuKey, setGpuKey] = useState(initial.gpuKey);
  const [gpuDeployment, setGpuDeployment] = useState(initial.gpuDeployment);
  const replicated = gpuDeployment === 'replicated';
  const gpuKeys = gpuKey ? gpuKey.split(',') : [];
  const ownKeys = initial.gpuKey ? initial.gpuKey.split(',') : [];
  const [parallelism, setParallelism] = useState(initial.parallelism);
  const cards = (models.computeMemory?.devices ?? []).filter((d) => initial.computeTarget === 'nvidia-gpu' && d.gpuDevice && d.slots?.scope === 'device');
  const selectedCards = gpuKeys.flatMap((key) => cards.filter((d) => nvidiaCardKey(d.gpuDevice!) === key));
  const card = selectedCards[0];
  const gpuCount = Math.max(1, selectedCards.length);
  const multiGpu = models.computeTargets.engineCatalog?.[initial.engine]?.multiGpu;
  const gpuPayload = groupSettings(selectedCards.map((item) => item.gpuDevice!), gpuDeployment);
  const noCardSlot = (cards.length > 0 || !!gpuKey) && (!card || selectedCards.length !== gpuKeys.length || selectedCards.some((item) =>
    (item.slots?.free ?? 0) + (initial.ownActive && ownKeys.includes(nvidiaCardKey(item.gpuDevice!)) ? 1 : 0) <= 0 || item !== card && !matchingNvidiaCards(card, item)));
  const cpuSettings = useCpuSettings(local.cpuResources, models, initial.engine, initial.computeTarget);
  const deploymentSettings = useVllmDeploymentSettings(local.vllm, models, initial.engine, initial.computeTarget);
  const target = models.computeTargets.targets.find((item) => item.id === initial.computeTarget);
  const legacyAllocation = initial.computeTarget === 'nvidia-gpu' && target?.available === true && !cards.length;
  const advertisedKvCacheOptions = target?.kvCacheTypes?.[initial.engine] ?? fallbackKvCacheOptions(initial.engine);
  const kvCacheOptions = advertisedKvCacheOptions.some((option) => option.value === initial.kvCacheType)
    ? advertisedKvCacheOptions
    : [{value: initial.kvCacheType, label: `Current - ${initial.kvCacheType}`, description: 'Currently stored value.'}, ...advertisedKvCacheOptions];
  const supportsOffloading = initial.computeTarget === 'nvidia-gpu';
  const userChanged = gpuDeployment !== initial.gpuDeployment || gpuKey !== initial.gpuKey || parallelism !== initial.parallelism || cpuSettings.changed || deploymentSettings.changed || modelType !== initial.modelType || contextWindow !== initial.contextWindow
    || maxOutputTokens !== initial.maxOutputTokens || maxNumSeqs !== initial.maxNumSeqs
    || kvCacheType !== initial.kvCacheType || selectedMi !== initial.selectedMi
    || cpuOffloading !== initial.cpuOffloading || ((cpuOffloading || gpuCount > 1) && hostMemoryMi !== initial.hostMemoryMi);
  const estimateQuery = useQuery({
    queryKey: ['model-edit-estimate', name, modelType, contextWindow, maxOutputTokens, maxNumSeqs, kvCacheType, selectedMi, cpuOffloading, gpuKey, parallelism, gpuDeployment],
    queryFn: () => api.estimateModelUpdate(name, {
      modelType, contextWindow, maxOutputTokens: maxOutputTokens ? Number(maxOutputTokens) : null,
      maxNumSeqs, kvCacheType, cpuOffloading, ...(initial.computeTarget === 'cpu' ? {memoryRequiredMi: selectedMi} : {vramMi: selectedMi}),
      ...(card ? {gpuDevice: null, gpuDevices: null, ...gpuPayload} : gpuKey !== initial.gpuKey ? {gpuDevice: null, gpuDevices: null, gpuDeployment: null} : {}),
      ...(initial.engine === 'VLLM' && (gpuCount > 1 || ownKeys.length > 1) ? {vllm: gpuCount > 1 && !replicated ? {parallelism} : null} : {}),
    }),
    enabled: Boolean(name), retry: false,
    // Keep the range input mounted while a changed budget is re-estimated. If
    // the panel is replaced during pointer interaction, the browser loses the
    // active drag and the dialog visibly flickers.
    placeholderData: (previousData) => previousData,
  });
  const estimate = estimateQuery.data;
  const targetDevices = card ? selectedCards : models.computeMemory?.devices?.filter((device) => device.computeTarget === initial.computeTarget || device.id === initial.computeTarget) ?? [];
  const fallbackAvailable = card ? Math.min(...targetDevices.map((device) => Number(device.unreservedMi ?? 0) + (initial.ownActive && ownKeys.includes(nvidiaCardKey(device.gpuDevice!)) ? initial.selectedMi : 0)))
    : targetDevices.reduce((maximum, device) => Math.max(maximum, Number(device.unreservedMi ?? 0)), 0) + initial.selectedMi;
  const capacityKnown = typeof estimate?.maximumMi === 'number' || fallbackAvailable > initial.selectedMi;
  const availableMi = typeof estimate?.maximumMi === 'number' ? estimate.maximumMi : fallbackAvailable;
  const offload = cpuOffloading ? estimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor(Number(offload?.ramMaximumMi ?? 0) / 100) * 100);
  const memoryRisks = estimate ? [
    ...(estimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(selectedMi < roundMemory(estimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(offload?.ramMaximumMi === null ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ] : [];
  const hasMemoryRisk = memoryRisks.length > 0;
  const changes = useMemo(() => {
    const next: Record<string, unknown> = {};
    if (gpuKey !== initial.gpuKey || gpuDeployment !== initial.gpuDeployment) {
      Object.assign(next, gpuPayload);
      if (!gpuKey) next.gpuDeployment = null;
      if (gpuCount > 1 && local.gpuDevice || !gpuKey && !local.gpuDevices) next.gpuDevice = null;
      if (local.gpuDevices && gpuCount < 2) next.gpuDevices = null;
    }
    if (modelType !== initial.modelType) next.modelType = modelType;
    if (contextWindow !== initial.contextWindow) next.contextWindow = contextWindow;
    if (maxOutputTokens !== initial.maxOutputTokens) next.maxOutputTokens = maxOutputTokens ? Number(maxOutputTokens) : null;
    if (maxNumSeqs !== initial.maxNumSeqs) next.maxNumSeqs = maxNumSeqs;
    if (kvCacheType !== initial.kvCacheType) next.kvCacheType = kvCacheType;
    if (selectedMi !== initial.selectedMi) next[initial.computeTarget === 'cpu' ? 'memoryRequiredMi' : 'vramMi'] = selectedMi;
    if (cpuOffloading !== initial.cpuOffloading) next.cpuOffloading = cpuOffloading;
    if ((cpuOffloading || gpuCount > 1) && (hostMemoryMi !== initial.hostMemoryMi || !initial.cpuOffloading || gpuKey !== initial.gpuKey)) next.memoryRequiredMi = hostMemoryMi;
    if (!cpuOffloading && gpuCount < 2 && (initial.cpuOffloading || ownKeys.length > 1)) next.memoryRequiredMi = null;
    if (userChanged && hasMemoryRisk !== initial.allowMemoryRisk) next.allowMemoryRisk = hasMemoryRisk;
    if (cpuSettings.changed) next.cpuResources = cpuSettings.payload;
    if (deploymentSettings.changed) next.vllm = deploymentSettings.payload;
    if (initial.engine === 'VLLM' && (gpuKey !== initial.gpuKey || parallelism !== initial.parallelism || gpuDeployment !== initial.gpuDeployment) && (gpuCount > 1 || ownKeys.length > 1)) next.vllm = gpuCount > 1 && !replicated ? {parallelism} : null;
    return next;
  }, [gpuKey, card, parallelism, gpuDeployment, cpuOffloading, contextWindow, hasMemoryRisk, hostMemoryMi, initial, kvCacheType, maxNumSeqs, maxOutputTokens, modelType, selectedMi, userChanged, cpuSettings.changed, cpuSettings.payload, deploymentSettings.changed, deploymentSettings.payload]);
  const invalid = noCardSlot || (!!card && gpuDeployment !== 'single' && gpuCount < 2) || cpuSettings.invalid || deploymentSettings.invalid || !initial.revision || !Number.isInteger(contextWindow) || contextWindow < 1
    || !Number.isInteger(maxNumSeqs) || maxNumSeqs < 1
    || (maxOutputTokens !== '' && (!Number.isInteger(Number(maxOutputTokens)) || Number(maxOutputTokens) < 1))
    || !Number.isInteger(selectedMi) || selectedMi < 100 || (selectedMi !== initial.selectedMi && selectedMi % 100 !== 0)
    || ((cpuOffloading || gpuCount > 1) && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < (gpuCount > 1 ? 1100 : 100) || (hostMemoryMi !== initial.hostMemoryMi && hostMemoryMi % 100 !== 0)))
    || (gpuCount > 1 && (selectedCards.some((device) => selectedMi > Number(nvidiaPhysicalCapacityMi(device) ?? 0))
      || (typeof estimate?.systemMemoryMaximumMi === 'number' && hostMemoryMi > estimate.systemMemoryMaximumMi)));
  const mutation = useMutation({
    mutationFn: () => {if (noCardSlot) throw new Error('No free slot on the selected NVIDIA card.'); return api.updateModel(name, {expectedRevision: initial.revision, local: changes});},
    onSuccess: async () => { await onUpdated(); onClose(); },
  });
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="tag-list"><span className="tag">Model: {name}</span><span className="tag">Engine: {initial.engine}</span><span className="tag">Compute: {initial.computeTarget}</span><span className="tag">Source unchanged</span></div>
    {(!!cards.length || !!initial.gpuKey) && <>
      {multiGpu?.computeTargets.includes(initial.computeTarget) && <GpuDeploymentSelect mode={gpuDeployment} count={gpuCount} replication={multiGpu.deploymentModes?.includes('replicated') ?? false} onChange={(mode) => {setGpuDeployment(mode); if (mode === 'single') setGpuKey(gpuKeys[0] ?? '');}} />}
      <NvidiaGpuGroupSelect cards={cards} values={gpuKeys} onChange={(keys) => {setGpuKey(keys.join(',')); if (keys.length > 1 && gpuDeployment === 'single') setGpuDeployment('split'); if (keys.length === 1 && gpuDeployment === 'split') setGpuDeployment('single');}} ownKeys={ownKeys} ownActive={initial.ownActive} allowAutomatic={legacyAllocation} maximum={multiGpu?.computeTargets.includes(initial.computeTarget) ? multiGpu.maxDevices : 1} replicated={replicated} />
    </>}
    <div className="form-grid"><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="Max Output Tokens"><input type="number" min="1" value={maxOutputTokens} placeholder="Runtime default" onChange={(event) => setMaxOutputTokens(event.target.value)} /></Field><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="KV Cache"><select value={kvCacheType} onChange={(event) => setKvCacheType(event.target.value)}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></div>
    <p className="muted">{kvCacheOptions.find((option) => option.value === kvCacheType)?.description}</p>
    {estimateQuery.isPending && <p role="status">Recalculating memory…</p>}
    {gpuCount > 1 && <p role="status">VRAM per GPU: {formatMi(selectedMi)} · {gpuCount} GPUs · {formatMi(selectedMi * gpuCount)} planned total.</p>}
    <EstimatePanel estimate={estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={setSelectedMi} hideBreakdown={cpuOffloading} preserveSelectedMi={initial.selectedMi} budgetDevices={replicated ? 1 : gpuCount} />
    {supportsOffloading && <Panel title="CPU offloading" className="nested-panel"><label className="check-field"><input type="checkbox" checked={cpuOffloading} onChange={(event) => setCpuOffloading(event.target.checked)} />Use additional system RAM</label>{cpuOffloading && offload && <div className="stack compact"><div className="estimate-metrics"><div><span>Minimum</span><strong>{formatMi(offload.ramMinimumMi)}</strong></div><div><span>Recommended</span><strong>{formatMi(offload.ramRecommendedMi)}</strong></div><div><span>Unreserved</span><strong>{offload.ramMaximumMi === null ? 'Unknown' : formatMi(hostMaximum)}</strong></div></div><Field label="Host RAM budget (MiB)"><input type="number" min="100" step={hostMemoryMi === initial.hostMemoryMi ? 1 : 100} value={hostMemoryMi} onChange={(event) => setHostMemoryMi(Number(event.target.value))} /></Field><Button type="button" onClick={() => setHostMemoryMi(roundMemory(offload.ramRecommendedMi))}>Use recommended RAM allocation</Button></div>}</Panel>}
    {hasMemoryRisk && <div className="notice notice-warn" role="note"><strong>Memory warning — this change can still be applied.</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul></div>}
    <AdvancedModelSettings cpuSettings={cpuSettings} deploymentSettings={deploymentSettings}><MultiGpuSettings count={gpuCount} engine={initial.engine} strategy={parallelism} onStrategy={setParallelism} ramMi={hostMemoryMi} onRam={setHostMemoryMi} offloading={cpuOffloading} ramMaximumMi={estimate?.systemMemoryMaximumMi} replicated={replicated} /></AdvancedModelSettings>
    <p className="muted">Saving reconciles the model runtime. The Pod may restart while the new parameters are applied.</p>
    <ErrorNotice error={estimateQuery.error ?? mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} disabled={!userChanged || invalid || estimateQuery.isFetching || estimateQuery.isError || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save changes'}</Button></div>
  </form>;
};

const LocalModelEditForm = ({activation, models, onClose, onUpdated}: {activation: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const local = asRecord(activation.spec?.local);
  if (local.realtime) return <RealtimeModelForm activation={activation} models={models} onClose={onClose} onSaved={onUpdated} />;
  return <StandardLocalModelEditForm activation={activation} models={models} onClose={onClose} onUpdated={onUpdated} />;
};

const optionalPositive = (value: string) => value ? Number(value) : null;

const ExternalModelEditForm = ({activation, onClose, onUpdated}: {activation: ModelActivation; onClose: () => void; onUpdated: () => Promise<void>}) => {
  const name = String(activation.metadata?.name ?? '');
  const external = (activation.spec?.external ?? {}) as Record<string, unknown>;
  const [initial] = useState(() => ({
    revision: modelEditRevision(activation), model: String(external.model ?? ''), apiBase: String(external.apiBase ?? ''),
    modelType: String(external.modelType ?? 'chat'), apiVersion: String(external.apiVersion ?? ''), customLlmProvider: String(external.customLlmProvider ?? ''),
    tpm: external.tpm ? String(external.tpm) : '', rpm: external.rpm ? String(external.rpm) : '',
    contextWindow: external.contextWindow ? String(external.contextWindow) : '', maxOutputTokens: external.maxOutputTokens ? String(external.maxOutputTokens) : '',
  }));
  const [model, setModel] = useState(initial.model); const [apiBase, setApiBase] = useState(initial.apiBase); const [modelType, setModelType] = useState(initial.modelType);
  const [apiVersion, setApiVersion] = useState(initial.apiVersion); const [customLlmProvider, setCustomLlmProvider] = useState(initial.customLlmProvider);
  const [tpm, setTpm] = useState(initial.tpm); const [rpm, setRpm] = useState(initial.rpm); const [contextWindow, setContextWindow] = useState(initial.contextWindow); const [maxOutputTokens, setMaxOutputTokens] = useState(initial.maxOutputTokens); const [apiKey, setApiKey] = useState('');
  const current = {model, apiBase, modelType, apiVersion, customLlmProvider, tpm, rpm, contextWindow, maxOutputTokens};
  const changes = Object.fromEntries(Object.entries(current).filter(([key, value]) => value !== initial[key as keyof typeof initial]).map(([key, value]) => [key,
    ['tpm', 'rpm', 'contextWindow', 'maxOutputTokens'].includes(key) ? optionalPositive(value)
      : ['apiBase', 'apiVersion', 'customLlmProvider'].includes(key) ? value || null : value,
  ]));
  const changed = Object.keys(changes).length > 0 || Boolean(apiKey);
  const numericValues = [tpm, rpm, contextWindow, maxOutputTokens].filter(Boolean).map(Number);
  const invalid = !initial.revision || !model.trim() || numericValues.some((value) => !Number.isInteger(value) || value < 1);
  const mutation = useMutation({mutationFn: () => api.updateModel(name, {expectedRevision: initial.revision, external: changes, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onUpdated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
    <div className="tag-list"><span className="tag">Model: {name}</span><span className="tag">External provider</span></div>
    <div className="form-grid"><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" placeholder="Provider default" /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Provider"><input value={customLlmProvider} onChange={(event) => setCustomLlmProvider(event.target.value)} placeholder="Optional" /></Field><Field label="API Version"><input value={apiVersion} onChange={(event) => setApiVersion(event.target.value)} placeholder="Optional" /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} placeholder="Provider default" /></Field><Field label="Max Output Tokens"><input type="number" min="1" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="Provider default" /></Field><Field label="Tokens per minute"><input type="number" min="1" value={tpm} onChange={(event) => setTpm(event.target.value)} placeholder="Unlimited" /></Field><Field label="Requests per minute"><input type="number" min="1" value={rpm} onChange={(event) => setRpm(event.target.value)} placeholder="Unlimited" /></Field><Field label="Replace API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Leave blank to keep the current key" /></Field></div>
    <p className="muted">Saving reconciles the provider entry. A blank API key keeps the configured Secret unchanged.</p><ErrorNotice error={mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!changed || invalid || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Save changes'}</Button></div>
  </form>;
};

const EditModelDialog = ({activation, models, onClose, onUpdated}: {activation?: ModelActivation; models: ModelsPayload; onClose: () => void; onUpdated: () => Promise<void>}) => <Dialog open={Boolean(activation)} title={`Edit Model · ${activation?.metadata?.name ?? ''}`} description={activation?.spec?.type === 'local' ? 'Change runtime parameters without replacing the model source, engine, or hardware target.' : 'Change provider and runtime parameters without replacing the activation.'} onClose={onClose}>
  {activation?.spec?.type === 'local'
    ? <LocalModelEditForm activation={activation} models={models} onClose={onClose} onUpdated={onUpdated} />
    : activation ? <ExternalModelEditForm activation={activation} onClose={onClose} onUpdated={onUpdated} /> : null}
</Dialog>;

const OffloadingStatus = ({local, status}: {local: Record<string, unknown>; status?: Record<string, unknown>}) => {
  if (!local.cpuOffloading) return null;
  const usage = status?.memoryUsage as {ramMi?: number; vramMi?: number; source?: string; sampledAt?: string} | undefined;
  const ramBudget = Number(status?.memoryRequiredMi ?? local.memoryRequiredMi ?? 0);
  const vramBudget = Number(status?.vramRequiredMi ?? local.vramMi ?? 0);
  const exceedsBudget = usage && ((ramBudget > 0 && Number(usage.ramMi) > ramBudget) || (vramBudget > 0 && Number(usage.vramMi) > vramBudget));
  return <div className="stack compact">
    <div className="tag-list"><span className="tag">CPU offloading enabled</span><span className="tag">Host RAM reserved: {formatMi(Number(status?.memoryRequiredMi ?? local.memoryRequiredMi))}</span></div>
    {usage ? <p className="muted">Engine-reported buffers: {formatMi(usage.ramMi)} RAM · {formatMi(usage.vramMi)} VRAM. Source: {usage.source}. These are not reservations or total process memory.</p> : <p className="muted">Actual RAM / VRAM split is not currently reported. The values above are reservations, not measured usage.</p>}
    {exceedsBudget && <p className="notice notice-warn">The engine reports more memory than the planned budget. Increase the allocation or reduce model size/context; the Ollama layer split is not a byte-exact VRAM limit.</p>}
  </div>;
};

const ModelLogsDialog = ({name, onClose}: {name: string; onClose: () => void}) => {
  const [replica, setReplica] = useState('');
  useEffect(() => {setReplica('');}, [name]);
  const query = useQuery({
    queryKey: ['model-logs', name, replica],
    queryFn: () => replica ? api.modelLogs(name, 300, replica) : api.modelLogs(name),
    enabled: Boolean(name),
    refetchInterval: name ? 5_000 : false,
  });
  const copyValue = query.data?.pods.flatMap((pod) => pod.containers.flatMap((container) => container.logs.map((log) => [
    `# ${pod.name} · ${container.name} · ${log.previous ? 'previous' : 'current'}`,
    log.text || log.error || 'No output returned.',
  ].join('\n')))).join('\n\n') ?? '';
  return <Dialog open={Boolean(name)} title={`Runtime logs · ${name}`} description={`Latest ${query.data?.tailLines ?? 300} lines per container. Output may contain model input or other sensitive data.`} onClose={onClose}>
    <div className="stack compact">
      <div className="model-log-toolbar">
        <span className="muted">{query.data ? `Updated ${new Date(query.data.generatedAt).toLocaleTimeString()}` : 'Loading current output…'}</span>
        <div className="actions">{copyValue && <CopyButton value={copyValue} label="Copy all" />}<Button type="button" onClick={() => query.refetch()} disabled={query.isFetching}>{query.isFetching ? 'Refreshing…' : 'Refresh'}</Button></div>
      </div>
      <ErrorNotice error={query.error} />
      {!!query.data?.replicas?.length && <Field label="Model copy"><select value={replica} onChange={(event) => setReplica(event.target.value)}>
        <option value="">All copies · newest Pods</option>{query.data.replicas.map((item) => <option key={item.name} value={item.name}>{item.uuid || item.name}</option>)}
      </select></Field>}
      {query.isPending && <Loading />}
      {query.data && !query.data.pods.length && <Empty>No runtime Pod exists for this model yet.</Empty>}
      {query.data?.pods.map((pod) => <details className="model-log-pod" key={pod.name} open>
        <summary><strong>{pod.name}</strong><span className="tag">{pod.phase}</span>{pod.node && <span className="tag">Node: {pod.node}</span>}{pod.deleting && <span className="tag">Terminating</span>}</summary>
        <div className="stack compact">
          {pod.containers.map((container) => <section className="model-log-container" key={`${container.kind}:${container.name}`}>
            <header><strong>{container.name}</strong><div className="tag-list"><span className="tag">{container.kind === 'init' ? 'Init container' : 'Container'}</span><span className="tag">{container.state}{container.reason ? ` · ${container.reason}` : ''}</span>{container.restartCount > 0 && <span className="tag">Restarts: {container.restartCount}</span>}</div></header>
            {container.logs.map((log) => <div className="model-log-stream" key={log.previous ? 'previous' : 'current'}>
              <div className="model-log-stream-title"><strong>{log.previous ? 'Previous run' : 'Current run'}</strong>{log.truncated && <span className="tag">Output limited</span>}</div>
              <pre aria-label={`${pod.name} ${container.name} ${log.previous ? 'previous' : 'current'} logs`}>{log.text || log.error || 'No output returned.'}</pre>
            </div>)}
          </section>)}
          {!pod.containers.length && <Empty>This Pod has no declared containers yet.</Empty>}
          {Boolean(pod.omittedContainers) && <p className="muted">{pod.omittedContainers} additional container(s) omitted.</p>}
        </div>
      </details>)}
      {Boolean(query.data?.omittedPods) && <p className="muted">{query.data?.omittedPods} older Pod(s) omitted.</p>}
    </div>
  </Dialog>;
};

export const ModelsPage = ({session}: {session: Session}) => {
  const queryClient = useQueryClient(); const query = useQuery({queryKey: ['models'], queryFn: () => api.models(), refetchInterval: 15_000});
  const [createOpen, setCreateOpen] = useState(false); const [location, setLocation] = useState<'local' | 'external'>('local');
  const [removeTarget, setRemoveTarget] = useState(''); const [editTarget, setEditTarget] = useState(''); const [logsTarget, setLogsTarget] = useState(''); const [runtimeConfirm, setRuntimeConfirm] = useState(false);
  const mutable = canMutateRuntime(session); const admin = canAdminister(session); const refresh = async () => { await queryClient.invalidateQueries({queryKey: ['models']}); };
  const removeMutation = useMutation({mutationFn: (name: string) => api.removeModel(name), onSuccess: async () => { setRemoveTarget(''); await refresh(); }});
  const lifecycleMutation = useMutation({
    mutationFn: ({name, action, expectedRevision}: {name: string; action: ModelLifecycleAction; expectedRevision: string}) => api.request<{activation?: ModelActivation}>(
      `/api/models/${encodeURIComponent(name)}/${action}`,
      {method: 'POST', body: JSON.stringify({expectedRevision})},
    ),
    retry: false,
    onMutate: () => queryClient.cancelQueries({queryKey: ['models']}),
    onSuccess: async (result, {name}) => {
      // Use the server-confirmed desired state immediately. The reconciler's
      // status may still describe the previous run until its next inspection.
      if (result?.activation?.metadata?.name === name) {
        const updated = result.activation;
        queryClient.setQueryData<ModelsPayload>(['models'], (current) => current && ({
          ...current, activations: current.activations.map((item) => item.metadata?.name === name ? updated : item),
        }));
      }
      await refresh();
    },
  });
  const runtimeMutation = useMutation({mutationFn: () => api.removeLocalRuntime(), onSuccess: async () => { setRuntimeConfirm(false); await refresh(); }});
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;

  const activations = query.data.activations; const activationNames = new Set(activations.map((item) => item.metadata?.name).filter(Boolean));
  const editActivation = activations.find((item) => item.metadata?.name === editTarget);
  const registered = (query.data.models ?? []).filter((item) => !activationNames.has(item.id));
  const localModels = activations.filter((activation) => activation.spec?.type === 'local' && (activation.spec?.enabled !== false || activation.metadata?.deletionTimestamp || activation.status?.phase === 'Removing'));
  const runtimeModules = query.data.modules as Record<string, {enabled?: boolean; autoEnabled?: boolean}> | undefined;
  const showRuntimeRemoval = mutable && localModels.length === 0 && ['gpu', 'kubeai'].some((id) => runtimeModules?.[id]?.enabled && runtimeModules[id]?.autoEnabled);

  return <div className="stack">
    <div className="section-title"><div><h2>Models</h2><p>Local inference and external OpenAI-compatible providers.</p></div></div>
    <ComputeMemory memory={query.data.computeMemory} />
    <div className="section-title"><div><h2>Installed Models</h2><p>{activations.length + registered.length} model{activations.length + registered.length === 1 ? '' : 's'}</p></div>{mutable && <Button variant="primary" onClick={() => setCreateOpen(true)}>Create</Button>}</div>
    <div className="stack compact">{activations.map((activation) => {
      const local = activation.spec?.local as Record<string, unknown> | undefined; const external = activation.spec?.external as Record<string, unknown> | undefined;
      const phase = activation.metadata?.deletionTimestamp ? 'Removing' : activation.status?.phase ?? (activation.spec?.enabled === false ? 'Disabled' : 'Requested');
      const target = String(activation.status?.computeTarget ?? local?.computeTarget ?? (local ? 'nvidia-gpu' : 'external'));
      const isCpu = target === 'cpu';
      const engine = local?.realtime ? 'vLLM-Omni' : String(activation.status?.engine ?? local?.engine ?? 'VLLM');
      const activationName = String(activation.metadata?.name ?? '');
      const phaseName = String(phase).toLowerCase();
      const stopped = activation.spec?.enabled === false;
      const stopping = stopped && !['disabled', 'stopped'].includes(phaseName);
      const lifecycleControls = mutable && Boolean(local || external) && !activation.metadata?.deletionTimestamp;
      const lifecycleBusy = lifecycleMutation.isPending || removeMutation.isPending || runtimeMutation.isPending;
      const pendingAction = lifecycleMutation.isPending && lifecycleMutation.variables?.name === activationName ? lifecycleMutation.variables.action : undefined;
      const lifecycleDisabled = lifecycleBusy || stopping || phaseName === 'removing' || !modelEditRevision(activation);
      const unsupportedEngine = Boolean(local && !['VLLM', 'OLLAMA'].includes(engine.toUpperCase()));
      const lifecycleHint = stopping ? 'Waiting for this model to finish stopping.'
        : external ? 'Start or stop this provider route in Magic Stick. The remote provider itself is not shut down.'
        : stopped ? 'Start the model with its saved settings.'
        : 'Stop the model and release its runtime resources. Saved settings are kept.';
      const runLifecycle = (action: ModelLifecycleAction) => lifecycleMutation.mutate({
        name: activationName,
        action,
        expectedRevision: modelEditRevision(activation),
      });
      const group = (local?.gpuDevices ?? activation.status?.gpuSharing?.devices ?? []) as NvidiaGpuSelection[];
      const replicated = local?.gpuDeployment === 'replicated';
      const replication = activation.status?.replication;
      return <Panel key={activation.metadata?.name} title={activation.metadata?.name ?? 'unnamed'} meta={`${activation.spec?.type ?? (local ? 'local' : 'external')} · ${String(local?.modelType ?? external?.modelType ?? 'chat')}`} actions={<StatusBadge phase={phase} />}>
        {group.length > 1 && <div className="stack compact"><strong>{replicated ? `${group.length} model copies · one API name · ${replication?.ready ?? 0}/${group.length} ready` : `${group.length} GPUs · one model`}</strong>
          <span>VRAM per GPU: {formatMi(parseMemoryMi(local?.vramMi ?? local?.vram ?? activation.status?.vramRequiredMi))} · System RAM{replicated ? ' per copy' : ''}: {formatMi(parseMemoryMi(local?.memoryRequiredMi))} · {replicated ? 'Load-balanced requests' : engine === 'VLLM' ? `Parallelism: ${String(asRecord(local?.vllm).parallelism ?? 'auto')}` : 'Ollama spread'}</span>
          <details><summary>Selected GPU identities</summary><ul>{group.map(device => <li key={nvidiaCardKey(device)}>{device.nodeName} · {device.uuid}</li>)}</ul></details>
          {replicated && <details><summary>Model copies</summary><div className="stack compact">{group.map((device) => {
            const instance = replication?.instances.find((item) => item.uuid === device.uuid);
            return <section key={device.uuid}><strong>{device.nodeName} · {device.uuid}</strong><StatusBadge phase={stopped ? phase : instance?.phase ?? 'Requested'} /><p>{stopped ? activation.status?.message : instance?.message ?? 'Waiting for replica reconciliation.'}</p></section>;
          })}</div></details>}
        </div>}
        <div className="tag-list">{local && <><span className="tag">Compute: {target}</span><span className="tag">Engine: {engine}</span>{(activation.status?.artifact || local.artifact) && <span className="tag">Artifact: {String(activation.status?.artifact ?? local.artifact)}</span>}{(activation.status?.format || local.format) && <span className="tag">Format: {String(activation.status?.format ?? local.format)}</span>}{(activation.status?.quantization || local.quantization) && <span className="tag">Quantization: {quantizationText(activation.status?.quantization ?? local.quantization)}</span>}{local.realtime ? <><span className="tag">Profile: vLLM-Omni Realtime</span><span className="tag">Compute node: {String(asRecord(local.realtime).gpuNode ?? 'pending')}</span>{!isCpu && <span className="tag">GPUs: {String(asRecord(local.realtime).gpuCount ?? 1)}</span>}<span className="tag">Context: {String(local.contextWindow ?? 8192)}</span><span className="tag">System RAM: {formatMi(Number(asRecord(local.realtime).systemMemoryMi ?? 16384))}</span></> : <><span className="tag">KV requested: {String(activation.status?.requestedKvCacheType ?? local.kvCacheType ?? (String(local.engine ?? 'VLLM') === 'OLlama' ? 'f16' : 'auto'))}</span><span className="tag">KV active: {String(activation.status?.effectiveKvCacheType || 'pending confirmation')}</span><span className="tag">{isCpu ? 'RAM' : 'VRAM'}: {isCpu ? formatMi(Number(activation.status?.memoryRequiredMi ?? local.memoryRequiredMi)) : activation.status?.vramRequiredMi ? formatMi(Number(activation.status.vramRequiredMi)) : String(local.vram ?? 'default')}</span><span className="tag">Context: {String(local.contextWindow ?? 'default')}</span><span className="tag">Max seqs: {String(local.maxNumSeqs ?? 'default')}</span></>}<span className="tag">Target: {String(activation.spec?.targetNamespace ?? 'ai')}</span></>}{external && <><span className="tag">Provider: {String(external.model ?? 'external')}</span><span className="tag">Context: {String(external.contextWindow ?? 'default')}</span></>}</div>
        {unsupportedEngine && <p className="notice notice-warn">This engine is no longer supported. Remove this definition and create a model with a supported engine.</p>}
        <ProgressBar phase={phase} enabled={activation.spec?.enabled !== false} message={activation.status?.message} />
        {activation.status?.gpuSharing && <div className="tag-list"><span className="tag" title={activation.status.gpuSharing.mode === 'exclusive' ? 'Exclusive GPU allocation.' : `Shared GPU access; no isolated GPU memory limit.${activation.status.gpuSharing.claimName ? ` Claim: ${activation.status.gpuSharing.claimName}` : ''}`}>GPU allocation: {activation.status.gpuSharing.mode === 'dra-shared' ? 'Shared · DRA' : activation.status.gpuSharing.mode === 'time-slicing' ? 'Shared · Time-slicing' : 'Exclusive'}</span><span className="tag">GPU node: {activation.status.gpuSharing.node}{activation.status.gpuSharing.device ? ` · ${activation.status.gpuSharing.device}` : ''}</span></div>}
        {local && <OffloadingStatus local={local} status={activation.status} />}
        <p className="muted">{String(activation.status?.message ?? activation.status?.modelRef ?? 'Waiting for catalog registration.')}</p>
        <div className="actions">
          {mutable && <Button type="button" disabled={unsupportedEngine || lifecycleBusy || stopping || phaseName === 'removing'} onClick={() => setEditTarget(activationName)} aria-label={`Edit ${activationName || 'model'}`}>Edit</Button>}
          {lifecycleControls && <>
            {!stopped && local && Boolean(local.realtime) && <Button type="button" disabled={lifecycleDisabled} onClick={() => runLifecycle('restart')} aria-label={`Restart ${activationName}`}>{pendingAction === 'restart' ? 'Restarting…' : 'Restart'}</Button>}
            <Button type="button" variant={stopped ? 'default' : 'ghost'} disabled={lifecycleDisabled || stopped && unsupportedEngine} title={lifecycleHint}
              onClick={() => runLifecycle(stopped ? 'start' : 'stop')} aria-label={`${stopped ? 'Start' : 'Stop'} ${activationName}`}>
              {pendingAction === 'start' ? 'Starting…' : pendingAction === 'stop' || stopping ? 'Stopping…' : stopped ? 'Start' : 'Stop'}
            </Button>
          </>}
          {admin && local && <Button type="button" onClick={() => setLogsTarget(activationName)} aria-label={`View logs for ${activationName || 'model'}`}>Logs</Button>}
          {mutable && <Button variant="danger" disabled={lifecycleBusy || phaseName === 'removing'} onClick={() => setRemoveTarget(activationName)}>{phaseName === 'removing' ? 'Removing' : 'Remove'}</Button>}
        </div>
      </Panel>;
    })}
    {registered.length > 0 && <Panel title="Registered Models" meta={`${registered.length} catalog entr${registered.length === 1 ? 'y' : 'ies'}`}>{registered.map((model) => <article className="list-row" key={model.id ?? model.name}><div><strong>{model.id ?? model.name ?? 'unnamed'}</strong><p>{model.modelRef ?? 'catalog'} · {model.provider ?? model.source ?? 'registered'}</p></div><StatusBadge phase="Registered" /></article>)}</Panel>}
    {!activations.length && !registered.length && <Empty>No models registered yet.</Empty>}</div>
    {showRuntimeRemoval && <Button variant="danger" disabled={lifecycleMutation.isPending || runtimeMutation.isPending} onClick={() => setRuntimeConfirm(true)}>Remove Local Inference Runtime</Button>}
    <ErrorNotice error={removeMutation.error ?? lifecycleMutation.error ?? runtimeMutation.error} />
    <Dialog open={createOpen} title="Create Model" description="Choose local inference or an external model provider." onClose={() => setCreateOpen(false)}><div className="stack"><Field label="Location"><select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="local">Local</option><option value="external">External</option></select></Field>{location === 'local' ? <LocalModelForm models={query.data} onClose={() => setCreateOpen(false)} onCreated={refresh} /> : <ExternalModelForm onClose={() => setCreateOpen(false)} onCreated={refresh} />}</div></Dialog>
    <EditModelDialog key={editTarget} activation={editActivation} models={query.data} onClose={() => setEditTarget('')} onUpdated={refresh} />
    <ModelLogsDialog name={logsTarget} onClose={() => setLogsTarget('')} />
    <ConfirmDialog key={removeTarget} open={Boolean(removeTarget)} title="Remove model" description={`Remove ${removeTarget}? The model runtime and generated catalog entry will be reconciled away.`} confirmLabel="Remove" busy={removeMutation.isPending} error={removeMutation.error} onClose={() => setRemoveTarget('')} onConfirm={() => removeMutation.mutate(removeTarget)} />
    <ConfirmDialog key={String(runtimeConfirm)} open={runtimeConfirm} title="Remove local inference runtime" description="Remove automatically installed local inference runtime modules after the last local model has gone? Manually managed modules are preserved." confirmLabel="Remove Runtime" busy={runtimeMutation.isPending} error={runtimeMutation.error} onClose={() => setRuntimeConfirm(false)} onConfirm={() => runtimeMutation.mutate()} />
  </div>;
};
