import {useEffect, useRef, useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {formatMi, safeModelName} from '@magicstick/dashboard-core';
import type {DiscoveryItem, ModelActivation, ModelsPayload, RealtimeConfiguration, RealtimeDevice, RealtimeProfile} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {Button, ErrorNotice, Field, Panel} from './components';

const hfReference = (value: string) => {
  const repo = value.trim().replace(/^(?:hf:\/\/|https:\/\/(?:www\.)?huggingface\.co\/)/, '').replace(/\/$/, '');
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) ? `hf://${repo}` : '';
};

const defaultRam = (profile: RealtimeProfile | undefined, device: RealtimeDevice | undefined) => Math.min(device?.systemMemoryMi || 16384, Math.max(
  profile?.defaultSystemMemoryMi ?? 16384,
  device?.gpuAllocationMode === 'shared-gtt'
    ? Math.floor(device.gpuMemoryMi * .9) + (profile?.hostRuntimeHeadroomMi ?? 8192) : 0,
));

export const RealtimeModelForm = ({models, activation, onClose, onSaved}: {
  models: ModelsPayload; activation?: ModelActivation; onClose: () => void; onSaved: () => Promise<void>;
}) => {
  const profiles = models.computeTargets.engineCatalog?.VLLM?.realtimeProfiles ?? {};
  const local = activation?.spec?.local;
  const [profileId, setProfileId] = useState(local?.realtime?.profile ?? Object.keys(profiles)[0] ?? '');
  const profile = profiles[profileId];
  const devices = (models.computeTargets.realtimeDevices ?? []).filter((item) => item.profile === profileId);
  const initialDevice = devices.find((item) => item.node === local?.realtime?.gpuNode)
    ?? devices.find((item) => item.supported && item.freeGpuCount > 0);
  const [name, setName] = useState(activation?.metadata?.name ?? 'qwen3-omni-realtime');
  const [initial] = useState(() => ({
    profile: profileId, gpuNode: local?.realtime?.gpuNode ?? initialDevice?.node ?? '',
    gpuCount: local?.realtime?.gpuCount ?? 1,
    systemMemoryMi: local?.realtime?.systemMemoryMi ?? defaultRam(profile, initialDevice),
    gpuMemoryFraction: local?.realtime?.gpuMemoryFraction ?? 0.9,
    thinkerCpuOffloadGiB: local?.realtime?.thinkerCpuOffloadGiB ?? 0,
    ...(local?.realtime?.runtimeImage ? {runtimeImage: local.realtime.runtimeImage} : {}),
    ...(local?.realtime?.restartNonce ? {restartNonce: local.realtime.restartNonce} : {}),
  }));
  const [config, setConfig] = useState<RealtimeConfiguration>(initial);
  const [context, setContext] = useState(Number(local?.contextWindow ?? profile?.defaultContextWindow ?? 8192));
  const [concurrency, setConcurrency] = useState(Number(local?.maxNumSeqs ?? 1));
  const [source, setSource] = useState<'search' | 'direct'>('search');
  const [url, setUrl] = useState(String(local?.url ?? `hf://${profile?.model ?? ''}`));
  const [search, setSearch] = useState('Qwen3-Omni');
  const [results, setResults] = useState<DiscoveryItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [searchError, setSearchError] = useState<unknown>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const lastSearch = useRef('');
  const searchRequest = useRef(0);
  const device = devices.find((item) => item.node === config.gpuNode);
  const computeTarget = String(local?.computeTarget ?? device?.computeTarget ?? profile?.computeTargets?.[0] ?? 'nvidia-gpu');
  const canonicalUrl = hfReference(url);
  const knownModel = canonicalUrl === `hf://${profile?.model}` || Boolean(activation && canonicalUrl === local?.url);
  const modelValid = Boolean(canonicalUrl);
  const modelError = !canonicalUrl ? new Error('Enter hf://organization/model, organization/model, or a Hugging Face repository URL.')
    : null;

  useEffect(() => {
    searchRequest.current += 1;
    setResults([]); setCursor(null); setSearched(false); setSearchError(null); setSearching(false);
    return () => { searchRequest.current += 1; };
  }, [profileId, computeTarget]);

  const runSearch = async (append = false) => {
    const request = ++searchRequest.current;
    const query = append ? lastSearch.current : search.trim();
    setSearching(true); setSearchError(null);
    if (!append) { setResults([]); setCursor(null); lastSearch.current = query; }
    try {
      const params = new URLSearchParams({provider: 'huggingface', q: query, engine: 'VLLM', computeTarget,
        modelType: 'chat', realtimeProfile: profileId, limit: '20'});
      if (append && cursor) params.set('cursor', cursor);
      const response = await api.searchModels(params);
      if (request !== searchRequest.current) return;
      setResults((previous) => append ? [...previous, ...response.results.filter((item) => !previous.some((entry) => entry.repo === item.repo))] : response.results);
      setCursor(response.nextCursor ?? null); setSearched(true);
    } catch (error) { if (request === searchRequest.current) setSearchError(error); }
    finally { if (request === searchRequest.current) setSearching(false); }
  };
  const maxOffload = 2147483647;
  const cpu = computeTarget === 'cpu';
  const imageMissing = !config.runtimeImage && profile?.image === '';
  const recommendedRam = Math.max((config.thinkerCpuOffloadGiB + 4) * 1024,
    device?.gpuAllocationMode === 'shared-gtt'
      ? Math.floor(device.gpuMemoryMi * config.gpuMemoryFraction) * config.gpuCount + (profile?.hostRuntimeHeadroomMi ?? 8192) : 0);
  const free = (item: RealtimeDevice) => item.computeTarget === 'cpu' ? 1 : Math.min(item.slotCount ?? item.gpuCount, item.freeGpuCount +
    (activation?.spec?.enabled !== false && initial.gpuNode === item.node && activation ? initial.gpuCount : 0));
  const shared = device?.allocationMode === 'time-slicing' || device?.allocationMode === 'dra-shared';
  const maxGpuCount = device ? Math.min(free(device), device.maxGpuCount ?? device.gpuCount) : 0;
  const integer = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max;
  const invalidResources = !profile || !device?.supported || !integer(config.gpuCount, 1, maxGpuCount)
    || !profile.gpuCounts.includes(config.gpuCount) || !integer(context, 1, 2147483647)
    || !integer(concurrency, 1, 2147483647) || !integer(config.thinkerCpuOffloadGiB, 0, maxOffload)
    || !integer(config.systemMemoryMi, 1, device?.systemMemoryMi ?? 0)
    || !Number.isFinite(config.gpuMemoryFraction) || config.gpuMemoryFraction <= 0 || config.gpuMemoryFraction > 1;
  const invalid = invalidResources || !modelValid || imageMissing;
  const changed = !activation || JSON.stringify(initial) !== JSON.stringify(config)
    || context !== Number(local?.contextWindow ?? profile?.defaultContextWindow) || concurrency !== Number(local?.maxNumSeqs ?? 1);
  const mutation = useMutation({
    mutationFn: () => {
      if (invalid || !profile) throw new Error('Select an eligible GPU node and valid Realtime resources.');
      const values = {realtime: {...config, profile: profileId}, contextWindow: context, maxNumSeqs: concurrency};
      if (activation) {
        const metadata = activation.metadata;
        const expectedRevision = metadata?.uid && metadata.generation ? `generation:${metadata.uid}:${metadata.generation}` : String(metadata?.resourceVersion ?? '');
        return api.updateModel(name, {expectedRevision, local: values});
      }
      return api.createLocalModel({name: name || safeModelName(canonicalUrl), enabled: true, targetNamespace: 'ai', local: {
        engine: 'VLLM', computeTarget, modelType: 'chat', url: canonicalUrl, ...values,
      }});
    },
    onSuccess: async () => { await onSaved(); onClose(); },
  });
  const update = (patch: Partial<RealtimeConfiguration>) => setConfig((current) => ({...current, ...patch}));
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); if (!invalid && changed) mutation.mutate(); }}>
    <div className="form-grid">
      <Field label="Name"><input value={name} disabled={Boolean(activation)} required onChange={(event) => setName(event.target.value)} /></Field>
      <Field label="Realtime profile"><select value={profileId} disabled={Boolean(activation)} onChange={(event) => {
        const id = event.target.value;
        const nextProfile = profiles[id];
        const nextDevice = models.computeTargets.realtimeDevices?.find((item) => item.profile === id && item.supported && item.freeGpuCount > 0);
        setProfileId(id);
        setContext(nextProfile?.defaultContextWindow ?? 8192);
        setConcurrency(1);
        setConfig({profile: id, gpuNode: nextDevice?.node ?? '', gpuCount: 1,
          systemMemoryMi: defaultRam(nextProfile, nextDevice),
          gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0});
      }}>{Object.entries(profiles).map(([id, item]) => <option key={id} value={id}>{item.displayName}</option>)}</select></Field>
    </div>
    <div className="tag-list"><span className="tag">Engine: vLLM-Omni</span><span className="tag">WebSocket /v1/realtime</span>
      <span className="tag" title={profile?.description} tabIndex={0}>Experimental runtime ⓘ</span></div>
    {!activation && <>
      <Field label="Model source"><select value={source} onChange={(event) => setSource(event.target.value as typeof source)}>
        <option value="search">Hugging Face search</option><option value="direct">Direct reference</option>
      </select></Field>
      {source === 'search' && <Panel title="Hugging Face" className="nested-panel">
        <div className="search-row"><input aria-label="Search Hugging Face" value={search} placeholder="Qwen3-Omni…"
          onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); if (!searching && search.trim().length >= 2) void runSearch(); }
          }} /><Button type="button" variant="primary" disabled={searching || search.trim().length < 2}
            onClick={() => void runSearch()}>{searching ? 'Searching…' : 'Search'}</Button></div>
        <ErrorNotice error={searchError} />
        {results.length > 0 && <Field label="Matching model"><select value={results.some((item) => item.url === canonicalUrl) ? canonicalUrl : ''}
          onChange={(event) => setUrl(event.target.value)}><option value="" disabled>Select a model</option>
          {results.map((item) => <option key={item.repo} value={item.url}>
            {item.repo}
          </option>)}</select></Field>}
        {cursor && <Button type="button" variant="ghost" disabled={searching} onClick={() => void runSearch(true)}>Load more models</Button>}
        {searched && !searching && !results.length && !searchError && <p role="status" className="muted">No matching public models found.</p>}
      </Panel>}
      {source === 'direct' && <Field label="Hugging Face URL"><input value={url} required placeholder={`hf://${profile?.model ?? 'organization/model'}`}
        onChange={(event) => setUrl(event.target.value)} /></Field>}
      {!knownModel && <Button type="button" variant="ghost" onClick={() => setUrl(`hf://${profile?.model ?? ''}`)}>Use profile default</Button>}
    </>}
    <Field label="Selected URL"><input readOnly value={canonicalUrl || url} /></Field>
    <ErrorNotice error={modelError} />
    <div className="form-grid">
      <Field label="Compute node"><select value={config.gpuNode} onChange={(event) => update({gpuNode: event.target.value, gpuCount: 1})}>
        {!config.gpuNode && <option value="" disabled>Select a compute node</option>}
        {devices.map((item, index) => <option key={item.node || `unavailable-${index}`} value={item.node} disabled={!item.supported || free(item) < 1}>
          {item.node} · {item.name} · {item.supported ? item.computeTarget === 'cpu' ? 'CPU' : `${free(item)} free GPU slot${free(item) === 1 ? '' : 's'}${item.allocationMode && item.allocationMode !== 'exclusive' ? ` · ${item.allocationMode === 'dra-shared' ? 'DRA' : 'Time-slicing'}` : ''}` : item.reason}
        </option>)}
      </select></Field>
      {!cpu && <Field label="GPUs"><select value={config.gpuCount} onChange={(event) => update({gpuCount: Number(event.target.value)})}>
        {(profile?.gpuCounts ?? [1]).map((count) => <option key={count} value={count} disabled={count > maxGpuCount}>{count} GPU{count === 1 ? `${shared ? ' · shared slot' : ''} · all stages` : 's · thinker / audio stages'}</option>)}
      </select></Field>}
    </div>
    {device && <div className="tag-list">{!cpu && <span className="tag">{device.gpuAllocationMode === 'shared-gtt' ? 'Shared GPU capacity' : 'VRAM per GPU'}: {device.gpuMemoryMi ? formatMi(device.gpuMemoryMi) : 'unknown'}</span>}<span className="tag">Allocatable RAM: {formatMi(device.systemMemoryMi)}</span></div>}
    {shared && <span className="tag" tabIndex={0} title="GPU memory and compute are shared with other models, without isolated VRAM limits. Set the GPU budget and context to leave room for other workloads; concurrent models can run out of memory or slow down.">Shared GPU · no VRAM isolation ⓘ</span>}
    {!devices.some((item) => item.supported && free(item) > 0) && <p className="notice notice-warn" role="status">No available compute slot. Check the device reason and GPU sharing in System → Hardware.</p>}
    {imageMissing && <p className="notice notice-warn" role="status">Choose a backend-compatible runtime image in Advanced Settings.</p>}
    <details className="stack compact"><summary><strong>Advanced Settings</strong></summary>
      <Field label="Runtime image (optional)"><input value={config.runtimeImage ?? ''} placeholder={profile?.image || 'registry/image:tag'}
        onChange={(event) => update({runtimeImage: event.target.value.trim() || undefined})} /></Field>
      <div className="form-grid">
        <Field label="Context Size"><input type="number" min="1" max="2147483647" value={context} onChange={(event) => setContext(Number(event.target.value))} /></Field>
        <Field label="Concurrent sessions"><input type="number" min="1" max="2147483647" value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></Field>
        <Field label="System RAM (MiB)"><input type="number" min="1" max={device?.systemMemoryMi} step="1" value={config.systemMemoryMi} onChange={(event) => update({systemMemoryMi: Number(event.target.value)})} /></Field>
        {!cpu && <Field label="Thinker CPU offload (GiB)"><input type="number" min="0" max={maxOffload} value={config.thinkerCpuOffloadGiB} onChange={(event) => update({thinkerCpuOffloadGiB: Number(event.target.value)})} /></Field>}
      </div>
      {!cpu && <Field label="GPU memory budget"><input type="range" min=".01" max="1" step=".01" value={config.gpuMemoryFraction} onChange={(event) => update({gpuMemoryFraction: Number(event.target.value)})} /></Field>}
      {!cpu && <span title="Split between thinker, talker and codec stages; a planning budget, not an isolated VRAM limit or a guarantee that the model fits." tabIndex={0}>{Math.round(config.gpuMemoryFraction * 100)}% per GPU ⓘ</span>}
    </details>
    {invalidResources && config.gpuNode && <p className="notice notice-warn" role="alert">Check available slots, positive numeric settings and the node's RAM capacity.</p>}
    {!invalidResources && config.systemMemoryMi < recommendedRam && <span className="tag" tabIndex={0}
      title={`Estimated RAM including offloading and shared GPU memory: ${formatMi(recommendedRam)}. This estimate does not block experimental deployment; insufficient RAM can cause OOM.`}>RAM below planning estimate ⓘ</span>}
    <ErrorNotice error={mutation.error} />
    <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary" disabled={mutation.isPending || invalid || !changed || !name.trim()}>{activation ? 'Save changes' : 'Add Realtime Model'}</Button></div>
  </form>;
};
