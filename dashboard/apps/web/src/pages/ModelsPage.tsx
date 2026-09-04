import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canMutateRuntime, formatBytes, formatMi, matchingVariants, safeModelName,
  selectedArtifact,
} from '@magicstick/dashboard-core';
import type {
  ComputeMemoryDevice, DiscoveryItem, MemoryEstimate, ModelArtifact, ModelVariant,
  ModelsPayload, Session,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, StatusBadge} from '../components';

const roundMemory = (value: number) => Math.max(100, Math.ceil(value / 100) * 100);
const quantizationText = (value: unknown) => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  const item = value as {label?: string; method?: string; bits?: number};
  return item.label ?? [item.method, item.bits ? `${item.bits}-bit` : ''].filter(Boolean).join(' ');
};

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
  const runtime = estimate.runtimeDetails ?? {};
  const kvBudgetMi = Number(estimate.kvCacheMi ?? 0);
  const hasTheoreticalKv = estimate.theoreticalKvCacheMi !== null && estimate.theoreticalKvCacheMi !== undefined;
  const baseKvMi = Number(hasTheoreticalKv ? estimate.theoreticalKvCacheMi : kvBudgetMi);
  const hybridSafetyMi = Number(estimate.hybridAllocatorSafetyMi ?? Math.max(0, kvBudgetMi - baseKvMi));
  const runtimeParts = [
    {label: 'Compile / warm-up', value: Number(runtime.compileReserveMi ?? 0)},
    {label: 'Multimodal processor cache', value: Number(runtime.multimodalReserveMi ?? 0)},
    {label: 'Quantization working copy', value: Number(runtime.unpackReserveMi ?? 0)},
    {label: 'Engine runtime reserve', value: Number(runtime.engineRuntimeReserveMi ?? 0)},
  ].filter((item) => item.value > 0);
  const explainedRuntimeMi = runtimeParts.reduce((total, item) => total + item.value, 0);
  const otherRuntimeMi = Math.max(0, Number(estimate.reserveMi ?? 0) - explainedRuntimeMi);
  const cards = [
    {label: 'Weights', value: formatMi(estimate.weightsMi)},
    {label: hasTheoreticalKv ? 'Theoretical KV cache' : 'Estimated KV cache', value: formatMi(baseKvMi)},
    ...(hybridSafetyMi > 0 ? [{label: 'Hybrid allocator safety', value: formatMi(hybridSafetyMi)}] : []),
    ...runtimeParts.map((item) => ({label: item.label, value: formatMi(item.value)})),
    ...(otherRuntimeMi > 0 ? [{label: 'Other runtime reserve', value: formatMi(otherRuntimeMi)}] : []),
    ...(Number(estimate.recommendedReserveMi ?? 0) > 0 ? [{label: 'Recommended headroom', value: formatMi(estimate.recommendedReserveMi)}] : []),
    {label: 'Download (disk / network)', value: formatBytes(estimate.downloadBytes)},
  ];
  return <details>
    <summary>Breakdown</summary>
    <dl className="facts">{cards.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
    {hybridSafetyMi > 0 && <p className="muted">Configured KV budget: {formatMi(kvBudgetMi)} = {formatMi(baseKvMi)} theoretical cache + {formatMi(hybridSafetyMi)} compatibility safety for the hybrid vLLM allocator.</p>}
    <p className="muted">Minimum includes weights, the complete KV budget, and runtime components. Recommended adds the separate headroom shown above. Download size is not added to memory.</p>
    {estimate.warnings?.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
  </details>;
};

const EstimatePanel = ({estimate, availableMi, selectedMi, onSelected}: {estimate?: MemoryEstimate; availableMi: number; selectedMi: number; onSelected: (value: number) => void}) => {
  if (!estimate) return <div className="empty compact-empty">Choose a model reference to calculate memory.</div>;
  const minimum = roundMemory(estimate.minimumMi);
  const recommended = roundMemory(estimate.recommendedMi);
  const maximum = Math.max(100, Math.floor(availableMi / 100) * 100);
  const scaleMaximum = Math.max(maximum, minimum, recommended);
  const availablePercent = maximum / scaleMaximum * 100;
  const marker = (value: number) => ({left: `${Math.min(100, value / scaleMaximum * 100)}%`} as CSSProperties);
  return <section className="estimate">
    <header><div><strong>{estimate.computeTarget === 'cpu' ? 'RAM' : 'VRAM'} reservation</strong><span className="muted">{estimate.confidence ?? 'estimated'} confidence</span></div></header>
    <div className="estimate-metrics"><div><span>Minimum</span><strong>{formatMi(minimum)}</strong></div><div><span>Recommended</span><strong>{formatMi(recommended)}</strong></div><div><span>100% unreserved</span><strong>{formatMi(maximum)}</strong></div></div>
    <div className="capacity-scale">
      <div className="capacity-available" style={{width: `${availablePercent}%`}}><input aria-label="Memory reservation" type="range" min="100" max={maximum} step="100" value={Math.min(maximum, Math.max(100, selectedMi))} onChange={(event) => onSelected(Number(event.target.value))} /></div>
      {availablePercent < 100 && <div className="capacity-overflow" style={{left: `${availablePercent}%`}} />}
      <span className="capacity-marker minimum" style={marker(minimum)}><span>Minimum {formatMi(minimum)}</span></span>
      <span className="capacity-marker recommended" style={marker(recommended)}><span>Recommended {formatMi(recommended)}</span></span>
      <span className="capacity-marker available" style={marker(maximum)}><span>100% {formatMi(maximum)}</span></span>
    </div>
    <div className="slider-labels"><span>Selected: {formatMi(selectedMi)}</span><span>{Math.round(Math.min(maximum, selectedMi) / maximum * 100)}% of unreserved memory</span></div>
    <div className="button-grid three"><Button type="button" onClick={() => onSelected(Math.min(maximum, minimum))}>Minimum</Button><Button type="button" variant="primary" onClick={() => onSelected(Math.min(maximum, recommended))}>Recommended</Button><Button type="button" onClick={() => onSelected(maximum)}>100%</Button></div>
    {(minimum > maximum || recommended > maximum) && <div className="notice notice-warn">{minimum > maximum ? 'Minimum and recommended' : 'Recommended'} memory extends into the grey area beyond currently unreserved capacity.</div>}
    <EstimateBreakdown estimate={estimate} />
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
  const [formError, setFormError] = useState<unknown>(null); const [searching, setSearching] = useState(false); const [loadingArtifacts, setLoadingArtifacts] = useState(false);

  useEffect(() => {
    const nextTargets = availableTargets.filter((target) => target.engines?.includes(engine));
    if (!nextTargets.some((target) => target.id === computeTarget)) setComputeTarget(nextTargets[0]?.id ?? 'cpu');
    setUrl(''); setPresetId(''); setArtifactId(''); setSearchResults([]); setArtifacts([]); setEstimate(undefined);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const availableMi = Math.max(100, ...targetDevices.map((device) => device.unreservedMi ?? 0), estimate?.maximumMi ?? 0, targetDevices.length ? 0 : estimate?.recommendedMi ?? 1024);
  const selectedDiscoveryArtifact = artifacts.find((item) => item.id === selectedSearchArtifact);

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
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.estimateMemory({engine, computeTarget, url, contextWindow, maxNumSeqs, modelType});
        setEstimate(result); setSelectedMi(roundMemory(result.recommendedMi)); setFormError(null);
      } catch (reason) { setFormError(reason); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [computeTarget, contextWindow, engine, maxNumSeqs, modelType, url]);

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
      const target = availableTargets.find((item) => item.id === computeTarget);
      if (!target?.available || !target.engines?.includes(engine)) throw new Error('The selected engine and hardware combination is not available.');
      const local: Record<string, unknown> = {modelType, computeTarget, engine, contextWindow, maxNumSeqs};
      if (target.kind === 'cpu' || computeTarget === 'cpu') local.memoryRequiredMi = selectedMi; else local.vram = `${selectedMi}Mi`;
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

    <div className="form-grid three"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Selected URL"><input value={url} readOnly /></Field><Field label="Max Num Seqs"><input type="number" min="1" value={maxNumSeqs} onChange={(event) => setMaxNumSeqs(Number(event.target.value))} /></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field></div>
    <EstimatePanel estimate={estimate} availableMi={availableMi} selectedMi={selectedMi} onSelected={setSelectedMi} />
    <ErrorNotice error={formError ?? createMutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={createMutation.isPending || !url}>Add Local Model</Button></div>
  </form>;
};

const ExternalModelForm = ({onClose, onCreated}: {onClose: () => void; onCreated: () => Promise<void>}) => {
  const [name, setName] = useState(''); const [model, setModel] = useState('openai/gpt-4o-mini'); const [apiBase, setApiBase] = useState('https://api.openai.com/v1'); const [apiKey, setApiKey] = useState(''); const [modelType, setModelType] = useState('chat'); const [contextWindow, setContextWindow] = useState(128000);
  const mutation = useMutation({mutationFn: () => api.createExternalModel({name, enabled: true, targetNamespace: 'ai', external: {model, apiBase, modelType, contextWindow}, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onCreated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Optional when supplied elsewhere" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Add External Model</Button></div></form>;
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
        <div className="tag-list">{local && <><span className="tag">Compute: {target}</span><span className="tag">Engine: {String(activation.status?.engine ?? local.engine ?? 'VLLM')}</span>{(activation.status?.artifact || local.artifact) && <span className="tag">Artifact: {String(activation.status?.artifact ?? local.artifact)}</span>}{(activation.status?.format || local.format) && <span className="tag">Format: {String(activation.status?.format ?? local.format)}</span>}{(activation.status?.quantization || local.quantization) && <span className="tag">Quantization: {quantizationText(activation.status?.quantization ?? local.quantization)}</span>}<span className="tag">{isCpu ? 'RAM' : 'VRAM'}: {isCpu ? formatMi(Number(activation.status?.memoryRequiredMi ?? local.memoryRequiredMi)) : activation.status?.vramRequiredMi ? formatMi(Number(activation.status.vramRequiredMi)) : String(local.vram ?? 'default')}</span><span className="tag">Context: {String(local.contextWindow ?? 'default')}</span><span className="tag">Max seqs: {String(local.maxNumSeqs ?? 'default')}</span><span className="tag">Target: {String(activation.spec?.targetNamespace ?? 'ai')}</span></>}{external && <><span className="tag">Provider: {String(external.model ?? 'external')}</span><span className="tag">Context: {String(external.contextWindow ?? 'default')}</span></>}</div>
        <ProgressBar phase={phase} enabled={activation.spec?.enabled !== false} message={activation.status?.message} />
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
