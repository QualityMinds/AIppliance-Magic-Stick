// Models page and its actions (apps/web/src/pages/ModelsPage.tsx): compute memory,
// installed and registered models, create/edit dialogs, lifecycle, runtime logs and
// removal of the automatically installed local runtime.
import {
  canAdminister, canMutateRuntime, formatMi, modelEditRevision, modelNameError, parseMemoryMi,
} from '@magicstick/dashboard-core';
import type {ComputeTarget, ModelActivation, ModelLogsPayload, NvidiaGpuSelection} from '@magicstick/dashboard-contracts';
import type {DashboardSnapshot} from './snapshot';
import type {AreaModule, TuiContext} from './tui-context';
import {capitalize, type DialogItem, type DialogSpec, type ViewerLine} from './tui-dialogs';
import {localModelForm, type LocalModelForm} from './tui-model-form';
import {computeMemoryRows, quantizationText} from './tui-model-memory';
import type {PageState, PageView} from './tui-state';
import {badge, button, fit, gap, joinSpans, panel, prose, span, type Row} from './tui-screen';
import {blank, heading, plural, progressRows, sectionLabel, statusBadge, tags, text} from './tui-widgets';

export interface LocalModelInput {
  name: string;
  modelType: string;
  engine: string;
  computeTarget: string;
  reference: string;
  contextWindow: number;
  maxNumSeqs: number;
  kvCacheType?: string;
  reservationMi: number;
  cpuOffloading?: boolean;
  hostMemoryMi?: number;
}

/** A minimal local model request from a direct reference (used by CLI callers and tests). */
export const buildLocalModelPayload = (input: LocalModelInput, target: ComputeTarget) => {
  const local: Record<string, unknown> = {
    modelType: input.modelType,
    computeTarget: input.computeTarget,
    engine: input.engine,
    contextWindow: input.contextWindow,
    maxNumSeqs: input.maxNumSeqs,
    kvCacheType: input.kvCacheType ?? (input.engine === 'OLlama' ? 'f16' : 'auto'),
    url: input.reference,
  };
  if (target.kind === 'cpu' || input.computeTarget === 'cpu') local.memoryRequiredMi = input.reservationMi;
  else local.vram = `${input.reservationMi}Mi`;
  if (input.cpuOffloading !== undefined) {
    if (input.cpuOffloading && input.computeTarget !== 'nvidia-gpu') throw new Error('CPU offloading currently supports NVIDIA GPU models only.');
    if (input.computeTarget === 'nvidia-gpu') local.cpuOffloading = input.cpuOffloading;
    if (input.cpuOffloading) {
      if (!Number.isInteger(input.hostMemoryMi) || Number(input.hostMemoryMi) < 100) throw new Error('A separate host RAM reservation is required for CPU offloading.');
      local.memoryRequiredMi = input.hostMemoryMi;
    }
  }
  return {name: input.name, enabled: true, targetNamespace: 'ai', local};
};

const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const UNSUPPORTED_ENGINE = 'This engine is no longer supported. Remove this definition and create a model with a supported engine.';

// Expanded details of the Models page use the shared `expand:` toggles of the view state.
const expander = (state: PageState, key: string, label: string): Row => {
  const open = state.expanded[key] ?? false;
  return [{text: `${open ? '▼' : '►'} ${label}`, action: {id: `expand:${key}`, label: open ? 'Collapse' : 'Expand'}}];
};
const isOpen = (state: PageState, key: string) => state.expanded[key] ?? false;

const modelPhase = (activation: ModelActivation) => activation.metadata?.deletionTimestamp ? 'Removing'
  : activation.status?.phase ?? (activation.spec?.enabled === false ? 'Disabled' : 'Requested');
const unsupportedEngine = (activation: ModelActivation) => {
  const local = activation.spec?.local as Record<string, unknown> | undefined;
  return Boolean(local && !['VLLM', 'OLLAMA'].includes(String(local.engine ?? activation.status?.engine ?? 'VLLM').toUpperCase()));
};

/** Tags of one installed model, as the browser lists them. */
const modelTags = (activation: ModelActivation) => {
  const local = activation.spec?.local as Record<string, unknown> | undefined;
  const external = activation.spec?.external as Record<string, unknown> | undefined;
  const status = activation.status ?? {};
  const target = String(status.computeTarget ?? local?.computeTarget ?? (local ? 'nvidia-gpu' : 'external'));
  const isCpu = target === 'cpu';
  const engine = local?.realtime ? 'vLLM-Omni' : String(status.engine ?? local?.engine ?? 'VLLM');
  const values: string[] = [];
  if (local) {
    values.push(`Compute: ${target}`, `Engine: ${engine}`);
    if (status.artifact || local.artifact) values.push(`Artifact: ${String(status.artifact ?? local.artifact)}`);
    if (status.format || local.format) values.push(`Format: ${String(status.format ?? local.format)}`);
    if (status.quantization || local.quantization) values.push(`Quantization: ${quantizationText(status.quantization ?? local.quantization)}`);
    if (local.realtime) {
      const realtime = asRecord(local.realtime);
      values.push('Profile: vLLM-Omni Realtime', `Compute node: ${String(realtime.gpuNode ?? 'pending')}`,
        ...(!isCpu ? [`GPUs: ${String(realtime.gpuCount ?? 1)}`] : []), `Context: ${String(local.contextWindow ?? 8192)}`,
        `System RAM: ${formatMi(Number(realtime.systemMemoryMi ?? 16384))}`);
    } else {
      values.push(
        `KV requested: ${String(status.requestedKvCacheType ?? local.kvCacheType ?? (String(local.engine ?? 'VLLM') === 'OLlama' ? 'f16' : 'auto'))}`,
        `KV active: ${String(status.effectiveKvCacheType || 'pending confirmation')}`,
        `${isCpu ? 'RAM' : 'VRAM'}: ${isCpu ? formatMi(Number(status.memoryRequiredMi ?? local.memoryRequiredMi)) : status.vramRequiredMi ? formatMi(Number(status.vramRequiredMi)) : String(local.vram ?? 'default')}`,
        `Context: ${String(local.contextWindow ?? 'default')}`, `Max seqs: ${String(local.maxNumSeqs ?? 'default')}`,
      );
    }
    values.push(`Target: ${String(activation.spec?.targetNamespace ?? 'ai')}`);
  }
  if (external) values.push(`Provider: ${String(external.model ?? 'external')}`, `Context: ${String(external.contextWindow ?? 'default')}`);
  return values;
};

const modelCard = (snapshot: DashboardSnapshot, activation: ModelActivation, width: number, state: PageState): Row[] => {
  const inner = width - 4;
  const mutable = canMutateRuntime(snapshot.session);
  const admin = canAdminister(snapshot.session);
  const name = activation.metadata?.name ?? 'unnamed';
  const local = activation.spec?.local as Record<string, unknown> | undefined;
  const external = activation.spec?.external as Record<string, unknown> | undefined;
  const status = activation.status ?? {};
  const phase = modelPhase(activation);
  const phaseName = phase.toLowerCase();
  const stopped = activation.spec?.enabled === false;
  const stopping = stopped && !['disabled', 'stopped'].includes(phaseName);
  const removing = Boolean(activation.metadata?.deletionTimestamp);
  const unsupported = unsupportedEngine(activation);
  const lifecycleControls = mutable && Boolean(local || external) && !removing;
  // Same rules as the browser: no lifecycle change while stopping or removing, or without a saved revision.
  const blocked = stopping ? 'Waiting for this model to finish stopping.'
    : phaseName === 'removing' ? 'This model is being removed.'
      : modelEditRevision(activation) ? undefined : 'The model has no saved revision yet. Reload and try again.';
  const editBlocked = unsupported ? UNSUPPORTED_ENGINE : stopping ? 'Waiting for this model to finish stopping.' : phaseName === 'removing' ? 'This model is being removed.' : undefined;
  const actions: Row = joinSpans([
    ...(mutable ? [button(`model:edit:${name}`, 'Edit', 'ghost', editBlocked)] : []),
    ...(lifecycleControls && !stopped && local && local.realtime ? [button(`model:restart:${name}`, 'Restart', 'ghost', blocked)] : []),
    ...(lifecycleControls ? [stopped
      ? button(`model:start:${name}`, stopping ? 'Stopping…' : 'Start', 'primary', blocked ?? (unsupported ? UNSUPPORTED_ENGINE : undefined))
      : button(`model:stop:${name}`, 'Stop', 'ghost', blocked)] : []),
    ...(admin && local ? [button(`model:logs:${name}`, 'Logs')] : []),
    ...(mutable ? [button(`model:remove:${name}`, phaseName === 'removing' ? 'Removing' : 'Remove', 'danger', phaseName === 'removing' ? 'This model is being removed.' : undefined)] : []),
  ]);
  const kv = !local || local.realtime ? '' : ` · KV ${String(status.effectiveKvCacheType || status.requestedKvCacheType || local.kvCacheType || 'default')}${status.requestedKvCacheType && !status.effectiveKvCacheType ? ' (pending)' : ''}`;
  const meta = `${activation.spec?.type ?? (local ? 'local' : 'external')} · ${String(local?.modelType ?? external?.modelType ?? 'chat')}${kv}`;

  const rows: Row[] = [];
  // Multi-GPU group and model copies.
  const group = (local?.gpuDevices ?? status.gpuSharing?.devices ?? []) as NvidiaGpuSelection[];
  const replicated = local?.gpuDeployment === 'replicated';
  const replication = status.replication;
  if (group.length > 1) {
    const engine = local?.realtime ? 'vLLM-Omni' : String(status.engine ?? local?.engine ?? 'VLLM');
    rows.push(fit(inner, [span(replicated ? `${group.length} model copies · one API name · ${replication?.ready ?? 0}/${group.length} ready` : `${group.length} GPUs · one model`, undefined, true)]));
    rows.push(...prose(inner, `VRAM per GPU: ${formatMi(parseMemoryMi(local?.vramMi ?? local?.vram ?? status.vramRequiredMi))} · System RAM${replicated ? ' per copy' : ''}: ${formatMi(parseMemoryMi(local?.memoryRequiredMi))} · ${replicated ? 'Load-balanced requests' : engine === 'VLLM' ? `Parallelism: ${String(asRecord(local?.vllm).parallelism ?? 'auto')}` : 'Ollama spread'}`));
    rows.push(expander(state, `model-gpus:${name}`, 'Selected GPU identities'));
    if (isOpen(state, `model-gpus:${name}`)) rows.push(...group.map((device) => [gap(2), span(`• ${device.nodeName} · ${device.uuid}`, 'dim')] as Row));
    if (replicated) {
      rows.push(expander(state, `model-copies:${name}`, 'Model copies'));
      if (isOpen(state, `model-copies:${name}`)) {
        for (const device of group) {
          const instance = replication?.instances.find((item) => item.uuid === device.uuid);
          rows.push(fit(inner, [gap(2), span(`${device.nodeName} · ${device.uuid}`)], [statusBadge(stopped ? phase : instance?.phase ?? 'Requested')]));
          rows.push(...prose(inner - 4, String(stopped ? status.message ?? '' : instance?.message ?? 'Waiting for replica reconciliation.'), 'dim').map((row) => [gap(4), ...row]));
        }
      }
    }
  }
  rows.push(...tags(inner, modelTags(activation)));
  if (unsupported) rows.push(...prose(inner, UNSUPPORTED_ENGINE, 'warn'));
  rows.push(...progressRows(phase, activation.spec?.enabled !== false, status.message));
  const sharing = status.gpuSharing;
  if (sharing) {
    rows.push(...tags(inner, [
      `GPU allocation: ${sharing.mode === 'dra-shared' ? 'Shared · DRA' : sharing.mode === 'time-slicing' ? 'Shared · Time-slicing' : 'Exclusive'}`,
      `GPU node: ${sharing.node}${sharing.device ? ` · ${sharing.device}` : ''}`,
    ]));
    if (sharing.mode !== 'exclusive') rows.push(...prose(inner, `Shared GPU access; no isolated GPU memory limit.${sharing.claimName ? ` Claim: ${sharing.claimName}` : ''}`, 'dim'));
  }
  if (local?.cpuOffloading) {
    const usage = status.memoryUsage as {ramMi?: number; vramMi?: number; source?: string} | undefined;
    const ramBudget = Number(status.memoryRequiredMi ?? local.memoryRequiredMi ?? 0);
    const vramBudget = Number(status.vramRequiredMi ?? local.vramMi ?? 0);
    const exceeds = usage && ((ramBudget > 0 && Number(usage.ramMi) > ramBudget) || (vramBudget > 0 && Number(usage.vramMi) > vramBudget));
    rows.push(...tags(inner, ['CPU offloading enabled', `Host RAM reserved: ${formatMi(Number(status.memoryRequiredMi ?? local.memoryRequiredMi))}`]));
    rows.push(...prose(inner, usage
      ? `Engine-reported buffers: ${formatMi(usage.ramMi)} RAM · ${formatMi(usage.vramMi)} VRAM. Source: ${usage.source}. These are not reservations or total process memory.`
      : 'Actual RAM / VRAM split is not currently reported. The values above are reservations, not measured usage.', 'dim'));
    if (exceeds) rows.push(...prose(inner, 'The engine reports more memory than the planned budget. Increase the allocation or reduce model size/context; the Ollama layer split is not a byte-exact VRAM limit.', 'warn'));
  }
  rows.push(...prose(inner, String(status.message ?? status.modelRef ?? 'Waiting for catalog registration.'), 'dim'));
  if (actions.length) rows.push(fit(inner, [], actions));
  return panel(width, {title: name, meta, status: statusBadge(phase)}, rows);
};

const runtimeRemovalVisible = (snapshot: DashboardSnapshot) => {
  const activations = snapshot.models.activations ?? [];
  const localModels = activations.filter((activation) => activation.spec?.type === 'local'
    && (activation.spec?.enabled !== false || activation.metadata?.deletionTimestamp || activation.status?.phase === 'Removing'));
  const modules = snapshot.models.modules as Record<string, {enabled?: boolean; autoEnabled?: boolean}> | undefined;
  return canMutateRuntime(snapshot.session) && localModels.length === 0 && ['gpu', 'kubeai'].some((id) => modules?.[id]?.enabled && modules[id]?.autoEnabled);
};

export const modelsPage = (snapshot: DashboardSnapshot, width: number, state: PageState): PageView => {
  const mutable = canMutateRuntime(snapshot.session);
  const activations = (snapshot.models.activations ?? []).filter((item) => Boolean(item.metadata?.name));
  const names = new Set(activations.map((item) => item.metadata?.name));
  const registered = (snapshot.models.models ?? []).filter((model) => !names.has(model.id) && !names.has(model.name));
  const inner = width - 4;
  const total = activations.length + registered.length;
  return {hotkeys: mutable ? [{key: 'a', label: 'Add model', actionId: 'model:add'}] : [], rows: [
    ...heading(width, 'Models', 'Local inference and external OpenAI-compatible providers.', mutable ? [button('model:add', 'Add Model', 'primary')] : []),
    ...panel(width, {title: 'Compute memory'}, computeMemoryRows(snapshot.models.computeMemory, inner, state.expanded)),
    blank,
    sectionLabel(width, 'Installed Models', plural(total, 'model')),
    ...activations.flatMap((activation) => modelCard(snapshot, activation, width, state)),
    ...(registered.length ? panel(width, {title: 'Registered Models', meta: `${registered.length} catalog entr${registered.length === 1 ? 'y' : 'ies'}`}, registered.map((model) =>
      fit(inner, [span(String(model.id ?? model.name ?? 'unnamed'), undefined, true), span(`  ${model.modelRef ?? 'catalog'} · ${model.provider ?? model.source ?? 'registered'}`, 'dim')], [badge('Registered', 'good')]))) : []),
    ...(!activations.length && !registered.length ? [text(width, 'No models registered yet.', 'dim')] : []),
    ...(runtimeRemovalVisible(snapshot) ? [blank, fit(width, [button('model:remove-runtime:', 'Remove Local Inference Runtime', 'danger')])] : []),
  ]};
};

// ---------------------------------------------------------------- dialogs

/** Whether the dialog built from `spec` is still open (also below a stacked confirmation or list). */
const dialogOpen = (ctx: TuiContext, spec: DialogSpec) => () => {
  for (let overlay = ctx.current(); overlay; overlay = overlay.back) if (overlay.kind === 'dialog' && overlay.spec === spec) return true;
  return false;
};

const nameItems = (value: string, error: string | undefined, onChange: (value: string) => void, id = 'name'): DialogItem[] => [
  {kind: 'text', id, label: 'Name', value, required: true, onChange},
  {kind: 'note', text: '1–63 lowercase letters, numbers or hyphens; start and end with a letter or number.'},
  ...(error && value ? [{kind: 'note', tone: 'bad', text: error} as DialogItem] : []),
];
const validUrl = (value: string) => {
  try { return ['http:', 'https:'].includes(new URL(value.trim()).protocol); } catch { return false; }
};

/** ExternalModelForm: register an OpenAI-compatible provider endpoint. */
const externalCreateForm = (ctx: TuiContext): LocalModelForm => {
  const values = {name: '', model: 'openai/gpt-4o-mini', apiBase: 'https://api.openai.com/v1', apiKey: '', modelType: 'chat', contextWindow: '128000'};
  const nameError = () => modelNameError(values.name, ctx.snapshot().models.activations.map((item) => item.metadata?.name ?? ''));
  const disabled = () => nameError()
    ?? (!values.model.trim() ? 'Enter the provider model.' : undefined)
    ?? (!validUrl(values.apiBase) ? 'Enter a valid http(s) API base URL.' : undefined)
    ?? (!Number.isInteger(Number(values.contextWindow)) || Number(values.contextWindow) < 1 ? 'The context size must be a positive whole number.' : undefined);
  return {
    items: () => [
      ...nameItems(values.name, nameError(), (value) => { values.name = value; }, 'external-name'),
      {kind: 'text', id: 'external-model', label: 'Provider Model', value: values.model, required: true, onChange: (value) => { values.model = value; }},
      {kind: 'text', id: 'external-base', label: 'API Base', value: values.apiBase, required: true, onChange: (value) => { values.apiBase = value; }},
      {kind: 'choice', id: 'external-type', label: 'Type', value: values.modelType, choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}], onChange: (value) => { values.modelType = value; }},
      {kind: 'number', id: 'external-context', label: 'Context Size', value: values.contextWindow, min: 1, step: 1024, onChange: (value) => { values.contextWindow = value; }},
      {kind: 'text', id: 'external-key', label: 'API Key', value: values.apiKey, secret: true, hint: 'Optional when supplied elsewhere', onChange: (value) => { values.apiKey = value; }},
    ],
    submit: {label: 'Add External Model', tone: 'primary', disabled, run: async () => {
      const reason = disabled();
      if (reason) throw new Error(reason);
      const name = values.name.trim();
      await ctx.perform(`Create model ${name}`, async () => {
        await ctx.api.createExternalModel({name, enabled: true, targetNamespace: 'ai',
          external: {model: values.model, apiBase: values.apiBase, modelType: values.modelType, contextWindow: Number(values.contextWindow)},
          ...(values.apiKey ? {apiKey: values.apiKey} : {})});
        return {lines: [`${name} was registered as an external model.`]};
      });
    }},
  };
};

/** ExternalModelEditForm: provider settings of an existing external model, sending only the changes. */
const externalEditForm = (ctx: TuiContext, activation: ModelActivation): LocalModelForm => {
  const name = String(activation.metadata?.name ?? '');
  const external = (activation.spec?.external ?? {}) as Record<string, unknown>;
  const initial = {
    revision: modelEditRevision(activation), model: String(external.model ?? ''), apiBase: String(external.apiBase ?? ''),
    modelType: String(external.modelType ?? 'chat'), apiVersion: String(external.apiVersion ?? ''), customLlmProvider: String(external.customLlmProvider ?? ''),
    tpm: external.tpm ? String(external.tpm) : '', rpm: external.rpm ? String(external.rpm) : '',
    contextWindow: external.contextWindow ? String(external.contextWindow) : '', maxOutputTokens: external.maxOutputTokens ? String(external.maxOutputTokens) : '',
  };
  const current = {...initial, apiKey: ''};
  const changes = () => Object.fromEntries((['model', 'apiBase', 'modelType', 'apiVersion', 'customLlmProvider', 'tpm', 'rpm', 'contextWindow', 'maxOutputTokens'] as const)
    .filter((key) => current[key] !== initial[key]).map((key) => [key,
      ['tpm', 'rpm', 'contextWindow', 'maxOutputTokens'].includes(key) ? current[key] ? Number(current[key]) : null
        : ['apiBase', 'apiVersion', 'customLlmProvider'].includes(key) ? current[key] || null : current[key],
    ]));
  const disabled = () => {
    if (!initial.revision) return 'The model has no saved revision yet. Reload and try again.';
    if (!current.model.trim()) return 'Enter the provider model.';
    if ([current.tpm, current.rpm, current.contextWindow, current.maxOutputTokens].filter(Boolean).map(Number).some((value) => !Number.isInteger(value) || value < 1)) return 'Numeric limits must be positive whole numbers or empty.';
    if (!Object.keys(changes()).length && !current.apiKey) return 'No changes to save.';
    return undefined;
  };
  const field = (id: keyof typeof current, label: string, hint?: string, kind: 'text' | 'number' = 'text'): DialogItem => kind === 'number'
    ? {kind: 'number', id: `external-${id}`, label, value: current[id], min: 1, step: id === 'contextWindow' ? 1024 : id === 'maxOutputTokens' ? 256 : 1, hint, onChange: (value) => { current[id] = value; }}
    : {kind: 'text', id: `external-${id}`, label, value: current[id], hint, onChange: (value) => { current[id] = value; }};
  return {
    items: () => [
      {kind: 'note', text: `[Model: ${name}] [External provider]`},
      {...field('model', 'Provider Model'), required: true} as DialogItem,
      field('apiBase', 'API Base', 'Provider default'),
      {kind: 'choice', id: 'external-modelType', label: 'Type', value: current.modelType, choices: [{value: 'chat', label: 'Chat'}, {value: 'embedding', label: 'Embedding'}], onChange: (value) => { current.modelType = value; }},
      field('customLlmProvider', 'Provider', 'Optional'),
      field('apiVersion', 'API Version', 'Optional'),
      field('contextWindow', 'Context Size', 'Provider default', 'number'),
      field('maxOutputTokens', 'Max Output Tokens', 'Provider default', 'number'),
      field('tpm', 'Tokens per minute', 'Unlimited', 'number'),
      field('rpm', 'Requests per minute', 'Unlimited', 'number'),
      {kind: 'text', id: 'external-apiKey', label: 'Replace API Key', value: current.apiKey, secret: true, hint: 'Leave blank to keep the current key', onChange: (value) => { current.apiKey = value; }},
      {kind: 'note', text: 'Saving reconciles the provider entry. A blank API key keeps the configured Secret unchanged.'},
    ],
    submit: {label: 'Save changes', tone: 'primary', disabled, run: async () => {
      const reason = disabled();
      if (reason) throw new Error(reason);
      await ctx.perform(`Update model ${name}`, async () => {
        await ctx.api.updateModel(name, {expectedRevision: initial.revision, external: changes(), ...(current.apiKey ? {apiKey: current.apiKey} : {})});
        return {lines: [`${name} was updated. The provider entry is reconciled.`]};
      });
    }},
  };
};

/** The browser's Create Model dialog: a location choice, then the local or external form. */
const createModel = (ctx: TuiContext) => {
  const state: {location: 'local' | 'external'; local?: LocalModelForm; external?: LocalModelForm} = {location: 'local'};
  const spec: DialogSpec = {
    title: 'Create Model',
    description: 'Choose local inference or an external model provider.',
    items: () => [
      {kind: 'choice', id: 'location', label: 'Location', value: state.location, choices: [{value: 'local', label: 'Local'}, {value: 'external', label: 'External'}],
        onChange: (value) => {
          state.location = value as typeof state.location;
          // Like the browser, switching the location starts that form from its defaults.
          state.local = undefined;
          state.external = undefined;
        }},
      ...form().items(),
    ],
    get submit() { return form().submit; },
  };
  const form = () => state.location === 'local'
    ? state.local ??= localModelForm(ctx, dialogOpen(ctx, spec))
    : state.external ??= externalCreateForm(ctx);
  ctx.dialog(spec);
};

const editModel = (ctx: TuiContext, activation: ModelActivation) => {
  const name = activation.metadata?.name ?? '';
  const localType = activation.spec?.type === 'local';
  let form: LocalModelForm | undefined;
  const spec: DialogSpec = {
    title: `Edit Model · ${name}`,
    description: localType ? 'Change runtime parameters without replacing the model source, engine, or hardware target.' : 'Change provider and runtime parameters without replacing the activation.',
    items: () => current().items(),
    get submit() { return current().submit; },
  };
  const current = () => form ??= localType ? localModelForm(ctx, dialogOpen(ctx, spec), activation) : externalEditForm(ctx, activation);
  ctx.dialog(spec);
};

// ---------------------------------------------------------------- runtime logs

/** Terminal control sequences in log output must never reach the screen. */
export const sanitizeLogText = (value: string) => value
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '')
  .replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f\x9b]/g, '');

export const logsCopyValue = (data?: ModelLogsPayload) => data?.pods.flatMap((pod) => pod.containers.flatMap((container) => container.logs.map((log) => [
  `# ${pod.name} · ${container.name} · ${log.previous ? 'previous' : 'current'}`,
  log.text || log.error || 'No output returned.',
].join('\n')))).join('\n\n') ?? '';

export const logLines = (data: ModelLogsPayload | undefined, replica: string): ViewerLine[] => {
  if (!data) return [{text: 'Loading current output…', tone: 'dim'}];
  const replicas = data.replicas ?? [];
  const lines: ViewerLine[] = [
    {text: `Updated ${new Date(data.generatedAt).toLocaleTimeString()} · latest ${data.tailLines} lines per container. Output may contain model input or other sensitive data.`, tone: 'dim'},
    ...(replicas.length ? [{text: `Model copy: ${replica ? replicas.find((item) => item.name === replica)?.uuid || replica : 'All copies · newest Pods'} (m switches between ${replicas.length} copies)`}] : []),
    {text: ''},
  ];
  if (!data.pods.length) lines.push({text: 'No runtime Pod exists for this model yet.', tone: 'dim'});
  for (const pod of data.pods) {
    lines.push({text: `■ ${pod.name} [${pod.phase}]${pod.node ? ` [Node: ${pod.node}]` : ''}${pod.deleting ? ' [Terminating]' : ''}`, bold: true, tone: 'accent'});
    for (const container of pod.containers) {
      lines.push({text: `▸ ${container.name} [${container.kind === 'init' ? 'Init container' : 'Container'}] [${container.state}${container.reason ? ` · ${container.reason}` : ''}]${container.restartCount > 0 ? ` [Restarts: ${container.restartCount}]` : ''}`, bold: true});
      for (const log of container.logs) {
        lines.push({text: `${log.previous ? 'Previous run' : 'Current run'}${log.truncated ? ' [Output limited]' : ''}`, tone: 'accent'});
        for (const line of sanitizeLogText(log.text || log.error || 'No output returned.').split('\n')) lines.push({text: line || ' ', tone: log.text ? undefined : 'dim'});
      }
      lines.push({text: ''});
    }
    if (!pod.containers.length) lines.push({text: 'This Pod has no declared containers yet.', tone: 'dim'});
    if (pod.omittedContainers) lines.push({text: `${pod.omittedContainers} additional container(s) omitted.`, tone: 'dim'});
  }
  if (data.omittedPods) lines.push({text: `${data.omittedPods} older Pod(s) omitted.`, tone: 'dim'});
  return lines;
};

const openLogs = (ctx: TuiContext, name: string) => {
  const state: {data?: ModelLogsPayload; replica: string; status: string; error?: string} = {replica: '', status: ''};
  const fetch = async () => {
    const replica = state.replica;
    const result = replica ? await ctx.api.modelLogs(name, 300, replica) : await ctx.api.modelLogs(name);
    if (replica === state.replica) {
      state.data = result;
      state.error = undefined;
    }
  };
  const reload = () => void fetch().catch((error) => { state.error = errorText(error); }).finally(() => ctx.draw());
  ctx.viewer({
    title: `Runtime logs · ${name}`,
    lines: () => [
      ...(state.status ? [{text: state.status, tone: 'good' as const}] : []),
      ...(state.error ? [{text: state.error, tone: 'bad' as const}] : []),
      ...logLines(state.data, state.replica),
    ],
    actions: [
      {key: 'r', label: 'Refresh', run: () => { state.status = ''; reload(); }},
      {key: 'c', label: 'Copy all', run: () => {
        const value = logsCopyValue(state.data);
        if (!value) { state.status = 'No output to copy yet.'; return; }
        ctx.copy(value);
        state.status = 'Copied to clipboard.';
      }},
      {key: 'm', label: 'Model copy', run: () => {
        const replicas = state.data?.replicas ?? [];
        if (!replicas.length) { state.status = 'This model has a single copy.'; return; }
        const order = ['', ...replicas.map((item) => item.name)];
        state.replica = order[(order.indexOf(state.replica) + 1) % order.length] ?? '';
        state.status = '';
        reload();
      }},
      {key: 's', label: 'Save to file', run: () => {
        const value = logsCopyValue(state.data);
        if (!value) { state.status = 'No output to save yet.'; return; }
        ctx.saveAs({
          title: 'Save runtime logs', defaultName: `${name}-logs.txt`, content: () => value, back: true,
          done: 'Runtime logs. The output may contain model input or other sensitive data.',
        });
      }},
    ],
    autoRefresh: {ms: 5000, run: fetch},
  });
  reload();
};

// ---------------------------------------------------------------- lifecycle and removal

const removeModel = (ctx: TuiContext, name: string) => ctx.confirm({
  title: 'Remove model', description: `Remove ${name}? The model runtime and generated catalog entry will be reconciled away.`, confirmLabel: 'remove', danger: true,
  onConfirm: () => ctx.perform(`Remove model ${name}`, async () => {
    await ctx.api.removeModel(name);
    return {lines: [`Removal of ${name} was requested.`]};
  }),
});

const removeRuntime = (ctx: TuiContext) => {
  if (!runtimeRemovalVisible(ctx.snapshot())) return ctx.message('Runtime still in use', 'The local inference runtime can be removed only after the last local model has gone, and only when it was installed automatically.');
  ctx.confirm({
    title: 'Remove local inference runtime', confirmLabel: 'remove runtime', danger: true,
    description: 'Remove automatically installed local inference runtime modules after the last local model has gone? Manually managed modules are preserved.',
    onConfirm: () => ctx.perform('Remove local inference runtime', async () => {
      await ctx.api.removeLocalRuntime();
      return {lines: ['Removal of the automatically installed local inference runtime was requested. Manually managed modules are preserved.']};
    }),
  });
};

const modelLifecycle = (ctx: TuiContext, activation: ModelActivation, action: 'start' | 'stop' | 'restart') => {
  const name = activation.metadata?.name ?? '';
  const external = activation.spec?.type === 'external';
  const run = async () => ctx.perform(`${capitalize(action)} ${name}`, async () => {
    await ctx.api.request(`/api/models/${encodeURIComponent(name)}/${action}`, {method: 'POST', body: JSON.stringify({expectedRevision: modelEditRevision(activation)})});
    return {lines: [action === 'start' ? `${name} is starting with its saved settings.` : action === 'stop' ? `Stop requested for ${name}. Its saved settings are kept.` : `Restart requested for ${name}.`]};
  });
  if (action === 'start') return void run();
  // The browser stops and restarts at once; the terminal asks first, since requests to the model fail meanwhile.
  ctx.confirm({
    title: `${capitalize(action)} ${name}`, confirmLabel: action, onConfirm: run,
    description: action === 'restart' ? 'The model runtime is restarted. Requests fail until it is ready again.'
      : external ? 'This provider route is stopped in Magic Stick. The remote provider itself is not shut down. Saved settings are kept.'
        : 'The model is stopped and its runtime resources are released. Requests to it fail until it is started again. Saved settings are kept.',
  });
};

export const modelsModule: AreaModule = {
  scopes: {model: 'runtime'},
  handle: (ctx, {verb, target}) => {
    if (verb === 'add') return createModel(ctx);
    if (verb === 'remove-runtime') return removeRuntime(ctx);
    const activation = (ctx.snapshot().models.activations ?? []).find((item) => item.metadata?.name === target);
    if (!activation) return ctx.missing();
    const phaseName = modelPhase(activation).toLowerCase();
    if (verb === 'logs') {
      if (!canAdminister(ctx.session())) return ctx.message('Administrator access required', 'Runtime logs are restricted to Magic Stick administrators.', 'error');
      if (activation.spec?.type === 'external' || !activation.spec?.local) return ctx.message('No runtime logs', 'External models have no local runtime.');
      return openLogs(ctx, target);
    }
    if (verb === 'edit') {
      const stopping = activation.spec?.enabled === false && !['disabled', 'stopped'].includes(phaseName);
      if (unsupportedEngine(activation)) return ctx.message('Not available', UNSUPPORTED_ENGINE);
      if (stopping || phaseName === 'removing') return ctx.message('Not available', stopping ? 'Waiting for this model to finish stopping.' : 'This model is being removed.');
      return editModel(ctx, activation);
    }
    if (verb === 'start' || verb === 'stop' || verb === 'restart') return modelLifecycle(ctx, activation, verb);
    if (verb === 'remove') return removeModel(ctx, target);
  },
};

