import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canMutateRuntime, formatBytes, formatMi, matchingVariants, safeModelName,
  selectedArtifact,
} from '@magicstick/dashboard-core';
import type {
  ComputeMemoryDevice, DiscoveryItem, MemoryCalculation, MemoryEstimate, ModelArtifact, ModelVariant,
  ModelsPayload, Session,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, StatusBadge} from '../components';
import {MemoryInfo, unreservedCalculation} from '../MemoryInfo';

const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

const fallbackKvCacheOptions = (engine: string) => engine === 'OLlama'
  ? [{value: 'f16', label: 'Standard - F16', description: 'Highest cache precision.'}]
  : [{value: 'auto', label: 'Standard - model precision', description: 'Uses the model precision selected by vLLM.'}];

const MemoryGauge = ({device}: {device: ComputeMemoryDevice}) => {
  const total = Math.max(1, device.totalMi ?? 0);
  const unreserved = Math.max(0, device.unreservedMi ?? total);
  const free = Math.max(0, device.freeMi ?? 0);
  const unreservedPercent = Math.min(100, Math.round(unreserved / total * 100));
  const freePercent = Math.min(100, Math.round(free / total * 100));
  return <article className="memory-gauge">
    <div className="gauge-rings" style={{'--unreserved': `${unreservedPercent * 1.8}deg`, '--free': `${freePercent * 1.8}deg`} as CSSProperties}><div className="gauge-value"><strong>{formatMi(free)}</strong><span>actually free</span></div></div>
    <strong>{device.name ?? device.id}</strong>
    <small><i />{formatMi(unreserved)} unreserved · {formatMi(total)} total</small>
    {!device.metricsAvailable && <span className="muted">Live metrics unavailable</span>}
  </article>;
};

const EstimateBreakdown = ({estimate}: {estimate: MemoryEstimate}) => {
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
    <dl className="facts">{(offloading ? offloadCards : cards).map((item) => <div key={item.key}><dt>{item.label}</dt><dd><MemoryInfo label={item.label} value={item.value} calculation={calculations[item.key]} /></dd></div>)}</dl>
    {offloading && <p className="muted">Planning estimates, not measured usage. Host RAM includes offloaded weights and runtime. For Ollama, the host KV upper bound conservatively covers an unknown hybrid-layer split; it is not additional measured cache. vLLM weight offloading does not offload KV cache.</p>}
    {hybridSafetyMi > 0 && <p className="muted">Configured KV budget: {formatMi(kvBudgetMi)} = {formatMi(baseKvMi)} theoretical cache + {formatMi(hybridSafetyMi)} compatibility safety for the hybrid vLLM allocator.</p>}
    {!offloading && <p className="muted">Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.</p>}
    {estimate.warnings?.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
  </details>;
};

const EstimatePanel = ({estimate, availableMi, capacityKnown = true, selectedMi, onSelected, hideBreakdown = false}: {estimate?: MemoryEstimate; availableMi: number; capacityKnown?: boolean; selectedMi: number; onSelected: (value: number) => void; hideBreakdown?: boolean}) => {
  if (!estimate) return <div className="empty compact-empty">Choose a model reference to calculate memory.</div>;
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(0, Math.floor(availableMi / 100) * 100);
  const scaleMaximum = Math.max(100, maximum, minimum, recommended);
  const availablePercent = maximum / scaleMaximum * 100;
  const marker = (value: number) => {
    const percent = Math.min(100, value / scaleMaximum * 100);
    return {left: `${percent}%`, '--marker-label-shift': percent > 85 ? '-100%' : percent < 15 ? '0%' : '-50%'} as CSSProperties;
  };
  return <section className="estimate">
    <header><div><strong>{estimate.computeTarget === 'cpu' ? 'RAM' : 'VRAM'} reservation</strong><span className="muted">{estimate.confidence ?? 'estimated'} confidence</span></div></header>
    <div className="estimate-metrics"><div><span>Minimum</span><strong><MemoryInfo label="Minimum" value={formatMi(minimum)} calculation={estimate.calculations?.minimumMi} roundedMi={estimate.minimumMi} /></strong></div><div><span>Recommended</span><strong><MemoryInfo label="Recommended" value={formatMi(recommended)} calculation={estimate.calculations?.recommendedMi} roundedMi={estimate.recommendedMi} /></strong></div><div><span>100% unreserved</span><strong><MemoryInfo label="100% unreserved" value={capacityKnown ? formatMi(maximum) : 'Unknown'} calculation={unreservedCalculation(capacityKnown ? availableMi : null)} /></strong></div></div>
    <div className="capacity-scale">
      <div className="capacity-available" style={{width: `${availablePercent}%`}}><input aria-label="Memory reservation" type="range" min="100" max={Math.max(100, maximum)} step="100" disabled={!capacityKnown || maximum < 100} value={Math.min(Math.max(100, maximum), Math.max(100, selectedMi))} onChange={(event) => onSelected(Number(event.target.value))} /></div>
      {availablePercent < 100 && <div className="capacity-overflow" style={{left: `${availablePercent}%`}} />}
      <span className="capacity-marker minimum" style={marker(minimum)}><span>Minimum {formatMi(minimum)}</span></span>
      <span className="capacity-marker recommended" style={marker(recommended)}><span>Recommended {formatMi(recommended)}</span></span>
      <span className="capacity-marker available" style={marker(maximum)}><span>{capacityKnown ? `100% ${formatMi(maximum)}` : 'Capacity unknown'}</span></span>
    </div>
    <div className="slider-labels"><span>Selected: {formatMi(selectedMi)}</span><span>{!capacityKnown ? 'Capacity unknown' : maximum > 0 ? `${Math.round(selectedMi / maximum * 100)}% of unreserved memory` : '< 100 MiB unreserved'}</span></div>
    <Field label={estimate.computeTarget === 'cpu' ? 'RAM budget (MiB)' : 'VRAM budget (MiB)'}><input type="number" min="100" step="100" value={selectedMi} onChange={(event) => onSelected(Number(event.target.value))} /></Field>
    <div className="button-grid three"><Button type="button" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, minimum) : minimum)}>Minimum</Button><Button type="button" variant="primary" onClick={() => onSelected(capacityKnown && maximum >= 100 ? Math.min(maximum, recommended) : recommended)}>Recommended</Button><Button type="button" disabled={!capacityKnown || maximum < 100} onClick={() => onSelected(maximum)}>100%</Button></div>
    {capacityKnown && (minimum > maximum || recommended > maximum) && <div className="notice notice-warn">{minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.</div>}
    {!hideBreakdown && <EstimateBreakdown estimate={estimate} />}
  </section>;
};

const DiscoveryMetadata = ({item}: {item?: DiscoveryItem}) => item ? <div className="tag-list discovery-meta">
  <span className="tag">Publisher: {item.author ?? item.repo.split('/')[0]}</span>
  {item.format && <span className="tag">Format: {item.format}</span>}
  {quantizationText(item.quantization) && <span className="tag">Quantization: {quantizationText(item.quantization)}</span>}
  {item.trustStatus && <span className="tag">Trust: {item.trustStatus}</span>}
  {(item.sizeLabel || item.downloadBytes) && <span className="tag">Download: {item.sizeLabel ?? formatBytes(item.downloadBytes)}</span>}
  {item.modelMaxContext && <span className="tag">Model context: {item.modelMaxContext.toLocaleString()}</span>}
</div> : null;

const LocalModelForm = ({models, onClose, onCreated}: {models: ModelsPayload; onClose: () => void; onCreated: () => Promise<void>}) => {
  const availableTargets = models.computeTargets.targets.filter((target) => target.available);
  const engineOptions = [...new Set(availableTargets.flatMap((target) => target.engines ?? []))];
  const [engine, setEngine] = useState(engineOptions[0] ?? 'VLLM');
  const targets = availableTargets.filter((target) => target.engines?.includes(engine));
  const [computeTarget, setComputeTarget] = useState(targets[0]?.id ?? models.computeTargets.default ?? 'cpu');
  const selectedTarget = availableTargets.find((target) => target.id === computeTarget);
  const kvCacheOptions = useMemo(
    () => selectedTarget?.kvCacheTypes?.[engine] ?? fallbackKvCacheOptions(engine),
    [engine, selectedTarget],
  );
  const [kvCacheType, setKvCacheType] = useState(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
  const provider = engine === 'OLlama' ? 'ollama' : 'huggingface';
  const [source, setSource] = useState<'search' | 'preset' | 'direct'>('search');
  const [name, setName] = useState(''); const [modelType, setModelType] = useState('chat');
  const [contextWindow, setContextWindow] = useState(4096); const [maxNumSeqs, setMaxNumSeqs] = useState(1);
  const [url, setUrl] = useState(''); const [presetId, setPresetId] = useState(''); const [artifactId, setArtifactId] = useState('');
  const [search, setSearch] = useState('Qwen'); const [popular, setPopular] = useState<DiscoveryItem[]>([]);
  const [searchResults, setSearchResults] = useState<DiscoveryItem[]>([]); const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState(''); const [artifacts, setArtifacts] = useState<DiscoveryItem[]>([]);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null); const [selectedSearchArtifact, setSelectedSearchArtifact] = useState('');
  const [estimate, setEstimate] = useState<MemoryEstimate>(); const [selectedMi, setSelectedMi] = useState(100);
  const [cpuOffloading, setCpuOffloading] = useState(false);
  const [offloadEstimate, setOffloadEstimate] = useState<MemoryEstimate>();
  const [hostMemoryMi, setHostMemoryMi] = useState(100);
  const [hostMemoryEdited, setHostMemoryEdited] = useState(false);
  const [offloadError, setOffloadError] = useState<unknown>(null);
  const [formError, setFormError] = useState<unknown>(null); const [searching, setSearching] = useState(false); const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  useEffect(() => {
    const nextTargets = availableTargets.filter((target) => target.engines?.includes(engine));
    if (!nextTargets.some((target) => target.id === computeTarget)) setComputeTarget(nextTargets[0]?.id ?? 'cpu');
    setUrl(''); setPresetId(''); setArtifactId(''); setSearchResults([]); setArtifacts([]); setEstimate(undefined);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!kvCacheOptions.some((option) => option.value === kvCacheType)) {
      setKvCacheType(kvCacheOptions[0]?.value ?? (engine === 'OLlama' ? 'f16' : 'auto'));
    }
  }, [computeTarget, engine, kvCacheOptions, kvCacheType]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({provider, engine, computeTarget, modelType, limit: '8'});
    api.popularModels(params).then((result) => { if (!cancelled) setPopular(result.results); }).catch(() => { if (!cancelled) setPopular([]); });
    return () => { cancelled = true; };
  }, [provider, engine, computeTarget, modelType]);

  const presets = useMemo(() => Object.entries(models.presets).flatMap(([id, preset]) => matchingVariants(preset.variants, engine, computeTarget).map((variant) => ({id, label: preset.displayName ?? id, variant}))), [computeTarget, engine, models.presets]);
  const selectedPreset = presets.find((item) => item.id === presetId);
  const selectedPresetArtifact = selectedArtifact(selectedPreset?.variant, artifactId);
  const targetDevices = models.computeMemory?.devices?.filter((device) => device.computeTarget === computeTarget || device.id === computeTarget) ?? [];
  const capacities = [...targetDevices.map((device) => device.unreservedMi), estimate?.maximumMi].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const capacityKnown = capacities.length > 0;
  const availableMi = capacityKnown ? Math.max(...capacities) : 0;
  const selectedDiscoveryArtifact = artifacts.find((item) => item.id === selectedSearchArtifact);
  const supportsOffloading = computeTarget === 'nvidia-gpu';
  const offload = supportsOffloading && cpuOffloading ? offloadEstimate?.offloading : undefined;
  const hostMaximum = Math.max(0, Math.floor((offload?.ramMaximumMi ?? 0) / 100) * 100);
  const activeEstimate = cpuOffloading ? offloadEstimate : estimate;
  const memoryRisks = [
    ...(!activeEstimate ? ['The memory estimate is not available yet.'] : []),
    ...(activeEstimate && activeEstimate.confidence !== 'high' ? ['Memory requirements are estimated and may differ at runtime.'] : []),
    ...(activeEstimate && selectedMi < roundMemory(activeEstimate.minimumMi) ? ['The selected memory is below the estimated minimum.'] : []),
    ...(capacityKnown && selectedMi > availableMi ? ['The selected memory exceeds currently unreserved capacity.'] : []),
    ...(!capacityKnown ? ['Unreserved device capacity could not be verified.'] : []),
    ...(cpuOffloading && (!offload || !offload.fitsVram) ? ['The offloading plan may not fit the selected VRAM budget.'] : []),
    ...(cpuOffloading && (!offload || offload.ramMaximumMi === null) ? ['Unreserved host RAM could not be verified.'] : []),
    ...(offload && hostMemoryMi < offload.ramMinimumMi ? ['Host RAM is below the estimated offloading minimum.'] : []),
    ...(offload && offload.ramMaximumMi !== null && hostMemoryMi > hostMaximum ? ['Host RAM exceeds currently unreserved capacity.'] : []),
  ];
  const hasMemoryRisk = memoryRisks.length > 0;
  const invalidBudget = !Number.isInteger(selectedMi) || selectedMi < 100 || selectedMi % 100 !== 0
    || (cpuOffloading && (!Number.isInteger(hostMemoryMi) || hostMemoryMi < 100 || hostMemoryMi % 100 !== 0));

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
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType, cpuOffloading: true, vramMi: selectedMi});
        if (!cancelled) setOffloadEstimate(result);
      } catch (reason) { if (!cancelled) setOffloadError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [cpuOffloading, supportsOffloading, engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType, selectedMi]);

  const applyModel = (nextUrl: string, artifact?: ModelArtifact, variant?: ModelVariant) => {
    setUrl(nextUrl); setName((current) => current || safeModelName(nextUrl));
    const context = Number(artifact?.modelMaxContext ?? variant?.contextWindow ?? 0);
    if (context > 0) setContextWindow(context);
    if (variant?.maxNumSeqs) setMaxNumSeqs(variant.maxNumSeqs);
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
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType, kvCacheType});
        if (!cancelled) {
          setEstimate(result);
          const maximum = capacityKnown ? Math.max(100, Math.floor(availableMi / 100) * 100) : roundMemory(result.recommendedMi);
          setSelectedMi((current) => Math.min(maximum, cpuOffloading ? current : roundMemory(result.recommendedMi)));
          setFormError(null);
        }
      } catch (reason) { if (!cancelled) setFormError(reason); }
    }, 350);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [computeTarget, contextWindow, engine, kvCacheType, maxNumSeqs, modelType, url, cpuOffloading]);

  const searchParams = (query: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, q: query, engine, computeTarget, modelType, limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const artifactParams = (repo: string, cursor?: string | null) => {
    const params = new URLSearchParams({provider, repo, engine, computeTarget, modelType, limit: '20'});
    if (cursor) params.set('cursor', cursor);
    return params;
  };
  const runSearch = async (query = search, append = false) => {
    setSearching(true); setFormError(null);
    if (!append) { setArtifacts([]); setSelectedSearchArtifact(''); }
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
      setArtifacts(combined); setArtifactCursor(result.nextCursor ?? null);
      if (!append) {
        const first = result.artifacts.find((item) => item.compatibility !== 'incompatible') ?? result.artifacts[0];
        setSelectedSearchArtifact(first?.id ?? ''); if (first?.url) applyModel(first.url, first);
      }
    } catch (reason) { setFormError(reason); } finally { setLoadingArtifacts(false); }
  };

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!url) throw new Error('Select or enter a model reference.');
      if (invalidBudget) throw new Error('Enter positive memory budgets in steps of 100 MiB.');
      const target = availableTargets.find((item) => item.id === computeTarget);
      if (!target?.available || !target.engines?.includes(engine)) throw new Error('The selected engine and hardware combination is not available.');
      const local: Record<string, unknown> = {modelType, computeTarget, engine, contextWindow, maxNumSeqs, kvCacheType};
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
    <div className="form-grid three">
      <Field label="Inference Engine"><select value={engine} onChange={(event) => setEngine(event.target.value)}>{engineOptions.map((item) => <option key={item}>{item}</option>)}</select></Field>
      <Field label="Hardware"><select value={computeTarget} onChange={(event) => setComputeTarget(event.target.value)}>{targets.map((target) => <option key={target.id} value={target.id}>{target.displayName ?? target.id}</option>)}</select></Field>
      <Field label="Model source"><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}><option value="search">{provider === 'ollama' ? 'Ollama Library' : 'Hugging Face search'}</option><option value="preset">Tested preset</option><option value="direct">Direct reference</option></select></Field>
    </div>

    {source === 'search' && <Panel title={provider === 'ollama' ? 'Ollama Library' : 'Hugging Face'} className="nested-panel">
      <div className="search-row"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Qwen, GLM, DeepSeek…" /><Button type="button" variant="primary" disabled={searching || search.trim().length < 2} onClick={() => runSearch()}>{searching ? 'Searching…' : 'Search'}</Button></div>
      <div className="quick-list"><span className="muted">Model families</span>{['Qwen', 'DeepSeek', 'GLM', 'Llama', 'Gemma', 'Mistral'].map((item) => <Button key={item} type="button" variant="ghost" onClick={() => { setSearch(item); void runSearch(item); }}>{item}</Button>)}</div>
      {popular.length > 0 && <div className="quick-list"><span className="muted">{provider === 'ollama' ? 'Popular on Ollama' : 'Trending on Hugging Face'}</span>{popular.slice(0, 8).map((item) => <Button key={item.repo} type="button" variant="ghost" onClick={() => { setSearch(item.repo); void runSearch(item.repo); }}>{item.name ?? item.repo}</Button>)}</div>}
      {searchResults.length > 0 && <div className="stack compact discovery-selects">
        <Field label="Matching model"><select value={searchModel} onChange={(event) => loadArtifacts(event.target.value, false)}>{searchResults.map((item) => <option key={item.repo} value={item.repo}>{item.repo}{item.pulls ? ` · ${item.pulls.toLocaleString()} pulls` : ''}</option>)}</select></Field>
        {searchCursor && <Button type="button" variant="ghost" disabled={searching} onClick={() => runSearch(search, true)}>Load more models</Button>}
        <Field label={provider === 'ollama' ? 'Tag / quantization' : 'Quantization / artifact'}><select value={selectedSearchArtifact} disabled={loadingArtifacts} onChange={(event) => { const id = event.target.value; setSelectedSearchArtifact(id); const item = artifacts.find((artifact) => artifact.id === id); if (item?.url) applyModel(item.url, item); }}>{artifacts.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.repo}{item.sizeLabel ? ` · ${item.sizeLabel}` : item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : ''}</option>)}</select></Field>
        {artifactCursor && <Button type="button" variant="ghost" disabled={loadingArtifacts} onClick={() => loadArtifacts(searchModel, true)}>Load more {provider === 'ollama' ? 'tags' : 'quantizations'}</Button>}
        <DiscoveryMetadata item={selectedDiscoveryArtifact} />
      </div>}
      {!searching && !searchResults.length && <p className="muted">Enter at least two characters or choose a model family or popular model.</p>}
    </Panel>}

    {source === 'preset' && <div className="stack compact discovery-selects"><Field label="Preset"><select value={presetId} onChange={(event) => { setPresetId(event.target.value); setArtifactId(''); }}><option value="">Select a tested preset</option>{presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field><Field label="Precision / Quantization"><select value={artifactId} onChange={(event) => setArtifactId(event.target.value)} disabled={!selectedPreset}><option value="">Default artifact</option>{selectedPreset?.variant.artifacts?.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></Field></div>}
    {source === 'direct' && <Field label={engine === 'OLlama' ? 'Ollama model reference' : 'Hugging Face URL'}><input value={url} onChange={(event) => { const nextUrl = event.target.value; setUrl(nextUrl); if (nextUrl) setName((current) => current || safeModelName(nextUrl)); }} placeholder={engine === 'OLlama' ? 'ollama://qwen3.5:9b' : 'hf://Qwen/Qwen3.6-27B'} required /></Field>}

    <div className="form-grid three"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Selected URL"><input value={url} readOnly /></Field><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="KV Cache"><select value={kvCacheType} onChange={(event) => setKvCacheType(event.target.value)}>{kvCacheOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></Field></div>
    <p className="muted">{kvCacheOptions.find((option) => option.value === kvCacheType)?.description} Attention-cache values are recalculated immediately; recurrent state and runtime reserve remain separate.</p>
    <EstimatePanel estimate={cpuOffloading ? offloadEstimate ?? estimate : estimate} availableMi={availableMi} capacityKnown={capacityKnown} selectedMi={selectedMi} onSelected={setSelectedMi} hideBreakdown={cpuOffloading} />
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
          {engine === 'OLlama' && <p className="notice notice-warn">Ollama uses an estimated layer split, not a byte-exact VRAM limit. The loaded model's reported memory is shown separately.</p>}
        </section>}
        {offloadEstimate && <EstimateBreakdown estimate={offloadEstimate} />}
      </>}
      <ErrorNotice error={offloadError} />
    </Panel>}
    <ErrorNotice error={formError ?? createMutation.error} />
    {hasMemoryRisk && <div id="model-memory-risk" className="notice notice-warn" role="note"><strong>Memory warning — you can still try to start this model.</strong><ul>{memoryRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul><p>Adding it accepts this risk. The pod may remain Pending, fail with out-of-memory errors or restart. Requests and limits stay at your selected budgets; a successful start is not guaranteed.</p></div>}
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" className={hasMemoryRisk ? 'memory-risk-button' : undefined} aria-describedby={hasMemoryRisk ? 'model-memory-risk' : undefined} disabled={createMutation.isPending || !url || invalidBudget}>{hasMemoryRisk && <span aria-hidden="true">⚠ </span>}Add Local Model</Button></div>
  </form>;
};

const ExternalModelForm = ({onClose, onCreated}: {onClose: () => void; onCreated: () => Promise<void>}) => {
  const [name, setName] = useState(''); const [model, setModel] = useState('openai/gpt-4o-mini'); const [apiBase, setApiBase] = useState('https://api.openai.com/v1'); const [apiKey, setApiKey] = useState(''); const [modelType, setModelType] = useState('chat'); const [contextWindow, setContextWindow] = useState(128000);
  const mutation = useMutation({mutationFn: () => api.createExternalModel({name, enabled: true, targetNamespace: 'ai', external: {model, apiBase, modelType, contextWindow}, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onCreated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Optional when supplied elsewhere" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Add External Model</Button></div></form>;
};

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

export const ModelsPage = ({session}: {session: Session}) => {
  const queryClient = useQueryClient(); const query = useQuery({queryKey: ['models'], queryFn: () => api.models()});
  const [createOpen, setCreateOpen] = useState(false); const [location, setLocation] = useState<'local' | 'external'>('local');
  const [removeTarget, setRemoveTarget] = useState(''); const [runtimeConfirm, setRuntimeConfirm] = useState(false);
  const mutable = canMutateRuntime(session); const refresh = async () => { await queryClient.invalidateQueries({queryKey: ['models']}); };
  const removeMutation = useMutation({mutationFn: (name: string) => api.removeModel(name), onSuccess: async () => { setRemoveTarget(''); await refresh(); }});
  const runtimeMutation = useMutation({mutationFn: () => api.removeLocalRuntime(), onSuccess: async () => { setRuntimeConfirm(false); await refresh(); }});
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;

  const activations = query.data.activations; const activationNames = new Set(activations.map((item) => item.metadata?.name).filter(Boolean));
  const registered = (query.data.models ?? []).filter((item) => !activationNames.has(item.id));
  const localModels = activations.filter((activation) => activation.spec?.type === 'local' && (activation.spec?.enabled !== false || activation.metadata?.deletionTimestamp || activation.status?.phase === 'Removing'));
  const runtimeModules = query.data.modules as Record<string, {enabled?: boolean; autoEnabled?: boolean}> | undefined;
  const showRuntimeRemoval = mutable && localModels.length === 0 && ['gpu', 'kubeai'].some((id) => runtimeModules?.[id]?.enabled && runtimeModules[id]?.autoEnabled);

  return <div className="stack">
    <div className="section-title"><div><h2>Models</h2><p>Local inference and external OpenAI-compatible providers.</p></div></div>
    <section><p className="eyebrow">Compute Memory</p><div className="memory-grid">{query.data.computeMemory?.devices?.length ? query.data.computeMemory.devices.map((device) => <MemoryGauge key={device.id} device={device} />) : <MemoryGauge device={{id: 'cpu-unavailable', name: 'CPU', kind: 'cpu'}} />}</div></section>
    <div className="section-title"><div><h2>Installed Models</h2><p>{activations.length + registered.length} model{activations.length + registered.length === 1 ? '' : 's'}</p></div>{mutable && <Button variant="primary" onClick={() => setCreateOpen(true)}>Create</Button>}</div>
    <div className="stack compact">{activations.map((activation) => {
      const local = activation.spec?.local as Record<string, unknown> | undefined; const external = activation.spec?.external as Record<string, unknown> | undefined;
      const phase = activation.metadata?.deletionTimestamp ? 'Removing' : activation.status?.phase ?? (activation.spec?.enabled === false ? 'Disabled' : 'Requested');
      const target = String(activation.status?.computeTarget ?? local?.computeTarget ?? (local ? 'nvidia-gpu' : 'external'));
      const isCpu = target === 'cpu';
      return <Panel key={activation.metadata?.name} title={activation.metadata?.name ?? 'unnamed'} meta={`${activation.spec?.type ?? (local ? 'local' : 'external')} · ${String(local?.modelType ?? external?.modelType ?? 'chat')}`} actions={<StatusBadge phase={phase} />}>
        <div className="tag-list">{local && <><span className="tag">Compute: {target}</span><span className="tag">Engine: {String(activation.status?.engine ?? local.engine ?? 'VLLM')}</span>{(activation.status?.artifact || local.artifact) && <span className="tag">Artifact: {String(activation.status?.artifact ?? local.artifact)}</span>}{(activation.status?.format || local.format) && <span className="tag">Format: {String(activation.status?.format ?? local.format)}</span>}{(activation.status?.quantization || local.quantization) && <span className="tag">Quantization: {quantizationText(activation.status?.quantization ?? local.quantization)}</span>}<span className="tag">KV requested: {String(activation.status?.requestedKvCacheType ?? local.kvCacheType ?? (String(local.engine ?? 'VLLM') === 'OLlama' ? 'f16' : 'auto'))}</span><span className="tag">KV active: {String(activation.status?.effectiveKvCacheType || 'pending confirmation')}</span><span className="tag">{isCpu ? 'RAM' : 'VRAM'}: {isCpu ? formatMi(Number(activation.status?.memoryRequiredMi ?? local.memoryRequiredMi)) : activation.status?.vramRequiredMi ? formatMi(Number(activation.status.vramRequiredMi)) : String(local.vram ?? 'default')}</span><span className="tag">Context: {String(local.contextWindow ?? 'default')}</span><span className="tag">Max seqs: {String(local.maxNumSeqs ?? 'default')}</span><span className="tag">Target: {String(activation.spec?.targetNamespace ?? 'ai')}</span></>}{external && <><span className="tag">Provider: {String(external.model ?? 'external')}</span><span className="tag">Context: {String(external.contextWindow ?? 'default')}</span></>}</div>
        <ProgressBar phase={phase} enabled={activation.spec?.enabled !== false} message={activation.status?.message} />
        {local && <OffloadingStatus local={local} status={activation.status} />}
        <p className="muted">{String(activation.status?.message ?? activation.status?.modelRef ?? 'Waiting for catalog registration.')}</p>
        {mutable && <Button variant="danger" disabled={removeMutation.isPending || String(phase).toLowerCase() === 'removing'} onClick={() => setRemoveTarget(activation.metadata?.name ?? '')}>{String(phase).toLowerCase() === 'removing' ? 'Removing' : 'Remove'}</Button>}
      </Panel>;
    })}
    {registered.length > 0 && <Panel title="Registered Models" meta={`${registered.length} catalog entr${registered.length === 1 ? 'y' : 'ies'}`}>{registered.map((model) => <article className="list-row" key={model.id ?? model.name}><div><strong>{model.id ?? model.name ?? 'unnamed'}</strong><p>{model.modelRef ?? 'catalog'} · {model.provider ?? model.source ?? 'registered'}</p></div><StatusBadge phase="Registered" /></article>)}</Panel>}
    {!activations.length && !registered.length && <Empty>No models registered yet.</Empty>}</div>
    {showRuntimeRemoval && <Button variant="danger" onClick={() => setRuntimeConfirm(true)}>Remove Local Inference Runtime</Button>}
    <ErrorNotice error={removeMutation.error ?? runtimeMutation.error} />
    <Dialog open={createOpen} title="Create Model" description="Choose local inference or an external model provider." onClose={() => setCreateOpen(false)}><div className="stack"><Field label="Location"><select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="local">Local</option><option value="external">External</option></select></Field>{location === 'local' ? <LocalModelForm models={query.data} onClose={() => setCreateOpen(false)} onCreated={refresh} /> : <ExternalModelForm onClose={() => setCreateOpen(false)} onCreated={refresh} />}</div></Dialog>
    <ConfirmDialog key={removeTarget} open={Boolean(removeTarget)} title="Remove model" description={`Remove ${removeTarget}? The model runtime and generated catalog entry will be reconciled away.`} confirmLabel="Remove" busy={removeMutation.isPending} error={removeMutation.error} onClose={() => setRemoveTarget('')} onConfirm={() => removeMutation.mutate(removeTarget)} />
    <ConfirmDialog key={String(runtimeConfirm)} open={runtimeConfirm} title="Remove local inference runtime" description="Remove automatically installed local inference runtime modules after the last local model has gone? Manually managed modules are preserved." confirmLabel="Remove Runtime" busy={runtimeMutation.isPending} error={runtimeMutation.error} onClose={() => setRuntimeConfirm(false)} onConfirm={() => runtimeMutation.mutate()} />
  </div>;
};
