import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canAdminister, canMutateRuntime, formatMi, modelEditRevision, parseMemoryMi,
} from '@magicstick/dashboard-core';
import type {
  ModelActivation, ModelsPayload, NvidiaGpuSelection, Session,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, StatusBadge} from '../components';
import {ComputeMemory} from '../ComputeMemory';
import {LocalModelConfigurationForm} from '../LocalModelConfigurationForm';
import {nvidiaCardKey} from '../NvidiaGpuSelect';
import {quantizationText} from '../ModelMemorySettings';

type ModelLifecycleAction = 'start' | 'stop' | 'restart';

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const ExternalModelForm = ({onClose, onCreated}: {onClose: () => void; onCreated: () => Promise<void>}) => {
  const [name, setName] = useState(''); const [model, setModel] = useState('openai/gpt-4o-mini'); const [apiBase, setApiBase] = useState('https://api.openai.com/v1'); const [apiKey, setApiKey] = useState(''); const [modelType, setModelType] = useState('chat'); const [contextWindow, setContextWindow] = useState(128000);
  const mutation = useMutation({mutationFn: () => api.createExternalModel({name, enabled: true, targetNamespace: 'ai', external: {model, apiBase, modelType, contextWindow}, ...(apiKey ? {apiKey} : {})}), onSuccess: async () => { await onCreated(); onClose(); }});
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required /></Field><Field label="Provider Model"><input value={model} onChange={(event) => setModel(event.target.value)} required /></Field><Field label="API Base"><input value={apiBase} onChange={(event) => setApiBase(event.target.value)} type="url" required /></Field><Field label="Type"><select value={modelType} onChange={(event) => setModelType(event.target.value)}><option value="chat">Chat</option><option value="embedding">Embedding</option></select></Field><Field label="Context Size"><input type="number" min="1" value={contextWindow} onChange={(event) => setContextWindow(Number(event.target.value))} /></Field><Field label="API Key"><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Optional when supplied elsewhere" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Add External Model</Button></div></form>;
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
    ? <LocalModelConfigurationForm activation={activation} models={models} onClose={onClose} onSaved={onUpdated} />
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
      const unsupportedEngine = Boolean(local && !['VLLM', 'OLLAMA'].includes(String(local.engine ?? activation.status?.engine ?? 'VLLM').toUpperCase()));
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
    <Dialog open={createOpen} title="Create Model" description="Choose local inference or an external model provider." onClose={() => setCreateOpen(false)}><div className="stack"><Field label="Location"><select value={location} onChange={(event) => setLocation(event.target.value as typeof location)}><option value="local">Local</option><option value="external">External</option></select></Field>{location === 'local' ? <LocalModelConfigurationForm models={query.data} onClose={() => setCreateOpen(false)} onSaved={refresh} /> : <ExternalModelForm onClose={() => setCreateOpen(false)} onCreated={refresh} />}</div></Dialog>
    <EditModelDialog key={editTarget} activation={editActivation} models={query.data} onClose={() => setEditTarget('')} onUpdated={refresh} />
    <ModelLogsDialog name={logsTarget} onClose={() => setLogsTarget('')} />
    <ConfirmDialog key={removeTarget} open={Boolean(removeTarget)} title="Remove model" description={`Remove ${removeTarget}? The model runtime and generated catalog entry will be reconciled away.`} confirmLabel="Remove" busy={removeMutation.isPending} error={removeMutation.error} onClose={() => setRemoveTarget('')} onConfirm={() => removeMutation.mutate(removeTarget)} />
    <ConfirmDialog key={String(runtimeConfirm)} open={runtimeConfirm} title="Remove local inference runtime" description="Remove automatically installed local inference runtime modules after the last local model has gone? Manually managed modules are preserved." confirmLabel="Remove Runtime" busy={runtimeMutation.isPending} error={runtimeMutation.error} onClose={() => setRuntimeConfirm(false)} onConfirm={() => runtimeMutation.mutate()} />
  </div>;
};
