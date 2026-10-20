import {useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction} from 'react';
import {formatBytes, matchingVariants, normalizeHuggingFaceReference, safeModelName, selectedArtifact} from '@magicstick/dashboard-core';
import type {DiscoveryItem, LocalModelConfigurationPolicy, LocalModelDraft, ModelArtifact, ModelVariant, ModelsPayload} from '@magicstick/dashboard-contracts';
import {api} from './api';
import {Button, ErrorNotice, Field, Panel} from './components';
import {DiscoveryMetadata} from './ModelMemorySettings';

export const useModelDiscovery = (models: ModelsPayload, draft: LocalModelDraft, setDraft: Dispatch<SetStateAction<LocalModelDraft>>,
  policy: LocalModelConfigurationPolicy, computeTarget: string, editing: boolean, onName: (name: string) => void) => {
  const repository = policy.discovery === 'repository';
  const profileId = draft.kind === 'omni' ? draft.realtime.profile : '';
  const provider = models.computeTargets.engineCatalog?.[draft.engine]?.urlScheme === 'ollama://' || draft.engine === 'OLlama' ? 'ollama' : 'huggingface';
  const [search, setSearch] = useState(repository ? 'Qwen3-Omni' : 'Qwen');
  const [popular, setPopular] = useState<DiscoveryItem[]>([]);
  const [results, setResults] = useState<DiscoveryItem[]>([]);
  const [artifacts, setArtifacts] = useState<DiscoveryItem[]>([]);
  const [repo, setRepo] = useState('');
  const [artifactId, setArtifactId] = useState('');
  const [baseModel, setBaseModel] = useState<DiscoveryItem>();
  const [cursor, setCursor] = useState<string | null>(null);
  const [artifactCursor, setArtifactCursor] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const epoch = useRef(0), searchRequest = useRef(0), artifactRequest = useRef(0), lastSearch = useRef('');
  useEffect(() => {
    epoch.current += 1; searchRequest.current += 1; artifactRequest.current += 1;
    setResults([]); setArtifacts([]); setRepo(''); setArtifactId(''); setBaseModel(undefined);
    setCursor(null); setArtifactCursor(null); setSearched(false); setError(null); setSearching(false); setLoadingArtifacts(false);
    return () => {epoch.current += 1; searchRequest.current += 1; artifactRequest.current += 1;};
  }, [draft.engine, computeTarget, profileId]);
  useEffect(() => {
    if (editing || repository) return;
    let cancelled = false;
    api.popularModels(new URLSearchParams({provider, engine: draft.engine, computeTarget, modelType: '', limit: '8'}))
      .then((response) => {if (!cancelled) setPopular(response.results);}).catch(() => {if (!cancelled) setPopular([]);});
    return () => {cancelled = true;};
  }, [provider, draft.engine, computeTarget, editing, repository]);
  const presets = useMemo(() => Object.entries(models.presets).flatMap(([id, preset]) => matchingVariants(preset.variants, draft.engine, computeTarget)
    .map((variant) => ({id, label: preset.displayName ?? id, variant, modelType: String(variant.modelType ?? preset.type ?? '')}))), [models.presets, draft.engine, computeTarget]);
  const preset = presets.find((item) => item.id === draft.presetId);
  const presetTask = draft.source === 'preset' && ['chat', 'embedding'].includes(preset?.modelType ?? '') ? preset!.modelType : '';
  const applyModel = (url: string, artifact?: ModelArtifact, variant?: ModelVariant, base?: DiscoveryItem) => {
    const context = [artifact?.modelMaxContext, variant?.contextWindow, base?.modelMaxContext].map((value) => Number(value ?? 0))
      .find((value) => Number.isFinite(value) && value > 0);
    setDraft((current) => ({...current, url, name: current.name || safeModelName(url),
      ...(context ? {contextWindow: context} : {}), ...(variant?.maxNumSeqs ? {maxNumSeqs: variant.maxNumSeqs} : {})}));
    if (!draft.name) onName(safeModelName(url));
  };
  const params = (query: string, nextCursor?: string | null) => new URLSearchParams({provider, engine: draft.engine, computeTarget,
    modelType: repository ? 'chat' : '', ...(profileId ? {realtimeProfile: profileId} : {}), ...{q: query}, limit: '20', ...(nextCursor ? {cursor: nextCursor} : {})});
  const loadArtifacts = async (nextRepo: string, append = false, base?: DiscoveryItem) => {
    const request = ++artifactRequest.current, currentEpoch = epoch.current;
    setRepo(nextRepo); setError(null); setLoadingArtifacts(true);
    try {
      const query = params(''); query.delete('q'); query.set('repo', nextRepo); if (append && artifactCursor) query.set('cursor', artifactCursor);
      const response = await api.modelArtifacts(query);
      if (request !== artifactRequest.current || currentEpoch !== epoch.current) return;
      setArtifacts((previous) => append ? [...previous, ...response.artifacts] : response.artifacts);
      setArtifactCursor(response.nextCursor ?? null);
      if (!append) {
        setBaseModel(response.baseModel ?? base);
        const first = response.artifacts.find((item) => item.compatibility !== 'incompatible') ?? response.artifacts[0];
        setArtifactId(first?.id ?? ''); if (first?.url) applyModel(first.url, first, undefined, response.baseModel ?? base);
      }
    } catch (reason) {if (request === artifactRequest.current && currentEpoch === epoch.current) setError(reason);}
    finally {if (request === artifactRequest.current && currentEpoch === epoch.current) setLoadingArtifacts(false);}
  };
  const runSearch = async (query = search, append = false) => {
    const request = ++searchRequest.current, currentEpoch = epoch.current;
    artifactRequest.current += 1;
    const submitted = append ? lastSearch.current : query.trim();
    setSearching(true); setError(null); if (!append) {lastSearch.current = submitted; setArtifacts([]); setArtifactId('');}
    try {
      const response = await api.searchModels(params(submitted, append ? cursor : null));
      if (request !== searchRequest.current || currentEpoch !== epoch.current) return;
      setResults((previous) => append ? [...previous, ...response.results.filter((item) => !previous.some((entry) => entry.repo === item.repo))] : response.results);
      setCursor(response.nextCursor ?? null); setSearched(true);
      if (!append && !repository) {
        const first = response.results[0]; setRepo(first?.repo ?? ''); if (first) await loadArtifacts(first.repo, false, first);
      }
    } catch (reason) {if (request === searchRequest.current && currentEpoch === epoch.current) setError(reason);}
    finally {if (request === searchRequest.current && currentEpoch === epoch.current) setSearching(false);}
  };
  const selectPreset = (id: string, selectedId = '') => {
    const next = presets.find((item) => item.id === id), artifact = selectedArtifact(next?.variant, selectedId);
    setDraft((current) => ({...current, presetId: id, artifactId: selectedId}));
    if (next) applyModel(artifact?.url ?? next.variant.url ?? '', artifact, next.variant);
  };
  return {provider, repository, search, setSearch, popular, results, artifacts, repo, artifactId, setArtifactId, baseModel,
    cursor, artifactCursor, searching, loadingArtifacts, searched, error, runSearch, loadArtifacts, applyModel, presets, preset, presetTask, selectPreset};
};

export const ModelSourceSettings = ({draft, setDraft, policy, discovery, editing, onSource, onName, defaultUrl}: {
  draft: LocalModelDraft; setDraft: Dispatch<SetStateAction<LocalModelDraft>>; policy: LocalModelConfigurationPolicy;
  discovery: ReturnType<typeof useModelDiscovery>; editing: boolean; onSource: (source: LocalModelDraft['source']) => void; onName: (name: string) => void; defaultUrl?: string;
}) => {
  const d = discovery, canonical = draft.kind === 'omni' ? normalizeHuggingFaceReference(draft.url) : draft.url;
  return <section className="stack compact" aria-label="Model reference settings">
    {!editing && <>
      <Field label="Model source"><select value={draft.source} onChange={(event) => {const source = event.target.value as LocalModelDraft['source']; setDraft((current) => ({...current, source})); onSource(source);}}>
        {policy.sources.includes('search') && <option value="search">{d.provider === 'ollama' ? 'Ollama Library' : 'Hugging Face search'}</option>}
        {policy.sources.includes('preset') && <option value="preset">Tested preset</option>}
        {policy.sources.includes('direct') && <option value="direct">Direct reference</option>}
      </select></Field>
      {draft.source === 'search' && <Panel title={d.provider === 'ollama' ? 'Ollama Library' : 'Hugging Face'} className="nested-panel">
        <div className="search-row"><input aria-label={d.provider === 'ollama' ? 'Search Ollama Library' : 'Search Hugging Face'} value={d.search} placeholder={d.repository ? 'Qwen3-Omni…' : 'Qwen, GLM, DeepSeek…'}
          onChange={(event) => d.setSearch(event.target.value)} onKeyDown={(event) => {if (event.key === 'Enter') {event.preventDefault(); if (!d.searching && d.search.trim().length >= 2) void d.runSearch();}}} />
          <Button type="button" variant="primary" disabled={d.searching || d.search.trim().length < 2} onClick={() => void d.runSearch()}>{d.searching ? 'Searching…' : 'Search'}</Button></div>
        {!d.repository && <div className="quick-list"><span className="muted">Model families</span>{['Qwen', 'DeepSeek', 'GLM', 'Llama', 'Gemma', 'Mistral'].map((item) => <Button key={item} type="button" variant="ghost" onClick={() => {d.setSearch(item); void d.runSearch(item);}}>{item}</Button>)}</div>}
        {d.popular.length > 0 && <div className="quick-list"><span className="muted">{d.provider === 'ollama' ? 'Popular on Ollama' : 'Trending on Hugging Face'}</span>{d.popular.slice(0, 8).map((item) => <Button key={item.repo} type="button" variant="ghost" onClick={() => {d.setSearch(item.repo); void d.runSearch(item.repo);}}>{item.name ?? item.repo}</Button>)}</div>}
        <ErrorNotice error={d.error} />
        {d.results.length > 0 && <Field label="Matching model"><select value={d.repository ? d.results.some((item) => item.url === canonical) ? canonical : '' : d.repo}
          onChange={(event) => d.repository ? setDraft((current) => ({...current, url: event.target.value})) : void d.loadArtifacts(event.target.value, false, d.results.find((item) => item.repo === event.target.value))}>
          {d.repository && <option value="" disabled>Select a model</option>}
          {d.results.map((item) => <option key={item.repo} value={d.repository ? item.url : item.repo}>{item.repo}{item.pulls ? ` · ${item.pulls.toLocaleString()} pulls` : ''}</option>)}
        </select></Field>}
        {d.cursor && <Button type="button" variant="ghost" disabled={d.searching} onClick={() => void d.runSearch(d.search, true)}>Load more models</Button>}
        {!d.repository && d.results.length > 0 && <>
          <Field label={d.provider === 'ollama' ? 'Tag / quantization' : 'Quantization / artifact'}><select value={d.artifactId} disabled={d.loadingArtifacts} onChange={(event) => {
            d.setArtifactId(event.target.value); const item = d.artifacts.find((artifact) => artifact.id === event.target.value); if (item?.url) d.applyModel(item.url, item, undefined, d.baseModel);
          }}>{d.artifacts.map((item) => <option key={item.id} value={item.id}>{item.label ?? item.repo}{item.sizeLabel ? ` · ${item.sizeLabel}` : item.downloadBytes ? ` · ${formatBytes(item.downloadBytes)}` : ''}</option>)}</select></Field>
          {d.artifactCursor && <Button type="button" variant="ghost" disabled={d.loadingArtifacts} onClick={() => void d.loadArtifacts(d.repo, true)}>Load more {d.provider === 'ollama' ? 'tags' : 'quantizations'}</Button>}
          <DiscoveryMetadata item={d.artifacts.find((item) => item.id === d.artifactId)} />
        </>}
        {!d.searching && !d.results.length && <p className="muted" role="status">{d.searched ? 'No matching public models found.' : 'Enter at least two characters or choose a model family or popular model.'}</p>}
      </Panel>}
      {draft.source === 'preset' && <div className="stack compact discovery-selects">
        <Field label="Preset"><select value={draft.presetId} onChange={(event) => d.selectPreset(event.target.value)}><option value="">Select a tested preset</option>{d.presets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></Field>
        <Field label="Precision / Quantization"><select value={draft.artifactId} disabled={!d.preset} onChange={(event) => d.selectPreset(draft.presetId, event.target.value)}><option value="">Default artifact</option>{d.preset?.variant.artifacts?.map((item) => <option key={item.id} value={item.id}>{item.title ?? item.id}</option>)}</select></Field>
      </div>}
      {draft.source === 'direct' && <Field label={d.provider === 'ollama' ? 'Ollama model reference' : 'Hugging Face URL'}><input value={draft.url} required placeholder={defaultUrl ?? (d.provider === 'ollama' ? 'ollama://qwen3.5:9b' : 'hf://Qwen/Qwen3.6-27B')}
        onChange={(event) => {const url = event.target.value; setDraft((current) => ({...current, url, name: current.name || (url ? safeModelName(url) : '')})); if (!draft.name && url) onName(safeModelName(url));}} /></Field>}
      {defaultUrl && canonical !== defaultUrl && <Button type="button" variant="ghost" onClick={() => setDraft((current) => ({...current, url: defaultUrl}))}>Use profile default</Button>}
    </>}
    <Field label="Selected URL"><input readOnly value={canonical || draft.url} /></Field>
  </section>;
};
