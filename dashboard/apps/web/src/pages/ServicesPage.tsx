import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  canMutateRuntime,
  effectiveModuleStatus,
  flattenInstances,
  instanceResourceLinks,
  missingApplicationModules,
  moduleResourceLinks,
  phaseInProgress,
  phaseNeedsAttention,
  titleFromKey,
  type FlatInstance,
} from '@magicstick/dashboard-core';
import type {
  ApplicationCatalogEntry,
  ModelsPayload,
  ModuleCatalogEntry,
  ModuleState,
  Session,
  SystemStatusPayload,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Dialog, Empty, ErrorNotice, Field, Loading, Panel, ProgressBar, ResourceLinks, StatusBadge} from '../components';

type ApplicationOption = {id: string; label: string; definition: ApplicationCatalogEntry; missing: string[]};
type Credentials = {title: string; entries: Array<{key: string; value: string}>};

const defaults: Record<string, {storage: string}> = {
  openclaw: {storage: '20Gi'}, hermes: {storage: '10Gi'}, paperclip: {storage: '5Gi'},
  odysseus: {storage: '20Gi'}, kubeopencode: {storage: '5Gi'},
};

const dnsPart = (value: string, fallback: string) => value.trim().toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/--+/g, '-') || fallback;

const instanceHost = (type: string, name: string, publicDomain: string) => {
  const cleanType = dnsPart(type, 'instance');
  let cleanName = dnsPart(name, 'default');
  if (cleanName.startsWith(`${cleanType}-`)) cleanName = cleanName.slice(cleanType.length + 1) || 'default';
  return `${cleanName}.${cleanType}.${publicDomain.replace(/^\.|\.$/g, '')}`;
};

const CreateInstanceDialog = ({open, initialType, applications, models, instances, publicDomain, onClose, onCreated}: {
  open: boolean;
  initialType?: string;
  applications: ApplicationOption[];
  models: string[];
  instances: FlatInstance[];
  publicDomain: string;
  onClose: () => void;
  onCreated: () => Promise<void>;
}) => {
  const firstAvailable = applications.find((item) => !item.missing.length)?.id ?? '';
  const [type, setType] = useState(initialType && applications.some((item) => item.id === initialType && !item.missing.length) ? initialType : firstAvailable);
  const [name, setName] = useState('default');
  const [model, setModel] = useState(models[0] ?? '');
  const [storage, setStorage] = useState(defaults[type]?.storage ?? '5Gi');
  const [authentication, setAuthentication] = useState('sso');
  const [role, setRole] = useState('user');
  const [exposure, setExposure] = useState('localAndPublic');
  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [postgresStorage, setPostgresStorage] = useState('10Gi');
  const [maxConcurrentAgents, setMaxConcurrentAgents] = useState(2);
  const [openCodeEnabled, setOpenCodeEnabled] = useState(true);
  const [openClawEnabled, setOpenClawEnabled] = useState(false);
  const [openClawInstanceRef, setOpenClawInstanceRef] = useState('');
  const [hermesEnabled, setHermesEnabled] = useState(false);
  const [hermesInstanceRef, setHermesInstanceRef] = useState('');
  const [template, setTemplate] = useState('default-coder');
  const [chromaStorage, setChromaStorage] = useState('5Gi');
  const [searxngStorage, setSearxngStorage] = useState('1Gi');
  const [ntfyStorage, setNtfyStorage] = useState('1Gi');
  const current = applications.find((item) => item.id === type);
  const modelRequired = ['openclaw', 'hermes', 'paperclip', 'kubeopencode', 'odysseus'].includes(type);
  const openClawInstances = instances.filter((item) => item.type === 'openclaw' && item.value.spec?.enabled !== false && String(item.value.status?.phase ?? '').toLowerCase() !== 'removing');
  const hermesInstances = instances.filter((item) => item.type === 'hermes' && item.value.spec?.enabled !== false && String(item.value.status?.phase ?? '').toLowerCase() !== 'removing');

  const mutation = useMutation({
    mutationFn: async () => {
      if (!type || current?.missing.length) throw new Error('Select an application whose required services are ready.');
      if (modelRequired && !model) throw new Error('Select a deployed chat model.');
      if (type === 'paperclip' && openClawEnabled && !openClawInstanceRef) throw new Error('Select an OpenClaw instance or disable its gateway.');
      if (type === 'paperclip' && hermesEnabled && !hermesInstanceRef) throw new Error('Select a Hermes instance or disable its gateway.');
      const host = instanceHost(type, name, publicDomain || 'magicstick.example.com');
      const base = {
        name, enabled: true, namespace: 'ai', model: model || 'CHANGEME_MODEL',
        access: {authentication, role, exposure},
      } as Record<string, unknown>;
      if (type === 'openclaw' || type === 'hermes') {
        base.storage = {size: storage}; base.ingress = {enabled: false, host};
      }
      if (type === 'paperclip') {
        base.storage = {size: storage};
        base.database = {managed: {storageSize: postgresStorage}};
        base.ingress = {enabled: false, host};
        base.admin = {email: adminEmail, name: 'Admin'};
        base.agentExecution = {
          defaultModel: `litellm/${model.replace(/^(litellm|openai)\//, '')}`,
          maxConcurrentAgents: Math.max(1, Math.min(10, Math.trunc(maxConcurrentAgents))),
          openCode: {enabled: openCodeEnabled},
          openClaw: {enabled: openClawEnabled, instanceRef: openClawInstanceRef},
          hermes: {enabled: hermesEnabled, instanceRef: hermesInstanceRef},
        };
      }
      if (type === 'kubeopencode') {
        base.server = {enabled: true, ingress: {enabled: false, host}};
        base.agentTemplates = [{name: template, description: 'Default coding agent template'}];
      }
      if (type === 'odysseus') {
        base.storage = {size: storage}; base.chroma = {storage: {size: chromaStorage}};
        base.searxng = {storage: {size: searxngStorage}}; base.ntfy = {storage: {size: ntfyStorage}};
        base.ingress = {enabled: false, host};
      }
      await api.createInstance(type, base);
    },
    onSuccess: async () => { await onCreated(); onClose(); },
  });

  return <Dialog open={open} title="Create Instance" description="Choose an application and configure only its supported values." onClose={onClose}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <Field label="Application"><select value={type} onChange={(event) => { const next = event.target.value; setType(next); setStorage(defaults[next]?.storage ?? '5Gi'); }} required>
        <option value="">Select an available application</option>
        {applications.map((item) => <option key={item.id} value={item.id} disabled={Boolean(item.missing.length)}>{item.label}{item.missing.length ? ' · unavailable' : ''}</option>)}
      </select></Field>
      {current?.missing.length ? <div className="notice notice-warn">Required services are not ready: {current.missing.map(titleFromKey).join(', ')}.</div> : null}
      {type && !current?.missing.length && <>
        <div className="form-grid three">
          <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?" /></Field>
          {modelRequired && <Field label={type === 'paperclip' ? 'Default Model' : 'Model'}><select value={model} onChange={(event) => setModel(event.target.value)} required><option value="">No deployed chat model selected</option>{models.map((item) => <option key={item} value={item}>{item}</option>)}</select></Field>}
          {type === 'paperclip' && <Field label="Admin Email"><input type="email" value={adminEmail} onChange={(event) => setAdminEmail(event.target.value)} required /></Field>}
          {type === 'kubeopencode' && <Field label="Template"><input value={template} onChange={(event) => setTemplate(event.target.value)} required /></Field>}
          <Field label="Access"><select value={authentication} onChange={(event) => setAuthentication(event.target.value)}><option value="sso">SSO protected</option><option value="none">Public without login</option></select></Field>
          <Field label="Minimum Role"><select value={role} onChange={(event) => setRole(event.target.value)}><option value="user">Authenticated user</option><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select></Field>
          <Field label="Exposure"><select value={exposure} onChange={(event) => setExposure(event.target.value)}><option value="localAndPublic">Local and public hosts</option><option value="local">Local host only</option></select></Field>
        </div>
        {type === 'paperclip' && <fieldset className="runtime-options"><legend>Agent runtimes</legend>
          <label className="check-field"><input type="checkbox" checked={openCodeEnabled} onChange={(event) => setOpenCodeEnabled(event.target.checked)} /> OpenCode</label>
          <label className="check-field"><input type="checkbox" checked={openClawEnabled} disabled={!openClawInstances.length} onChange={(event) => setOpenClawEnabled(event.target.checked)} /> OpenClaw Gateway</label>
          <Field label="OpenClaw Instance"><select value={openClawInstanceRef} disabled={!openClawEnabled} onChange={(event) => setOpenClawInstanceRef(event.target.value)}><option value="">Select instance</option>{openClawInstances.map((item) => <option key={item.name}>{item.name}</option>)}</select></Field>
          <label className="check-field"><input type="checkbox" checked={hermesEnabled} disabled={!hermesInstances.length} onChange={(event) => setHermesEnabled(event.target.checked)} /> Hermes Gateway</label>
          <Field label="Hermes Instance"><select value={hermesInstanceRef} disabled={!hermesEnabled} onChange={(event) => setHermesInstanceRef(event.target.value)}><option value="">Select instance</option>{hermesInstances.map((item) => <option key={item.name}>{item.name}</option>)}</select></Field>
        </fieldset>}
        {type !== 'kubeopencode' && <details className="details-panel form-details"><summary><span><strong>Configure</strong><small>Storage and runtime limits</small></span><span>Show</span></summary><div className="form-grid details-content">
          <Field label="Storage"><input value={storage} onChange={(event) => setStorage(event.target.value)} /></Field>
          {type === 'paperclip' && <><Field label="Postgres"><input value={postgresStorage} onChange={(event) => setPostgresStorage(event.target.value)} /></Field><Field label="Parallel Agents"><input type="number" min="1" max="10" value={maxConcurrentAgents} onChange={(event) => setMaxConcurrentAgents(Number(event.target.value))} /></Field></>}
          {type === 'odysseus' && <><Field label="Chroma"><input value={chromaStorage} onChange={(event) => setChromaStorage(event.target.value)} /></Field><Field label="SearXNG"><input value={searxngStorage} onChange={(event) => setSearxngStorage(event.target.value)} /></Field><Field label="ntfy"><input value={ntfyStorage} onChange={(event) => setNtfyStorage(event.target.value)} /></Field></>}
        </div></details>}
      </>}
      <ErrorNotice error={mutation.error} />
      <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!type || Boolean(current?.missing.length) || (modelRequired && !models.length) || mutation.isPending}>Create {current?.label ?? 'Instance'}</Button></div>
    </form>
  </Dialog>;
};

const ModuleParameters = ({catalog, values, onChange}: {catalog?: ModuleCatalogEntry; values: Record<string, string>; onChange: (values: Record<string, string>) => void}) => {
  if (!catalog?.parameters?.length) return null;
  return <details className="module-parameters"><summary>Configure</summary><div className="form-grid">{catalog.parameters.map((parameter) => <Field key={parameter.name} label={parameter.label ?? titleFromKey(parameter.name)}><input type={parameter.type ?? 'text'} placeholder={parameter.placeholder} value={values[parameter.name] ?? ''} onChange={(event) => onChange({...values, [parameter.name]: event.target.value})} /></Field>)}</div></details>;
};

export const ServicesPage = ({session}: {session: Session}) => {
  const queryClient = useQueryClient();
  const moduleQuery = useQuery({queryKey: ['modules'], queryFn: () => api.modules()});
  const instanceQuery = useQuery({queryKey: ['instances'], queryFn: () => api.instances()});
  const modelQuery = useQuery({queryKey: ['models'], queryFn: () => api.models()});
  const statusQuery = useQuery({queryKey: ['status'], queryFn: () => api.status()});
  const settingsQuery = useQuery({queryKey: ['settings'], queryFn: () => api.settings()});
  const [create, setCreate] = useState<{open: boolean; type?: string}>({open: false});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState<'all' | 'applications' | 'runtime' | 'platform'>('all');
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const [removeTarget, setRemoveTarget] = useState('');
  const [operationError, setOperationError] = useState<unknown>(null);
  const [parameters, setParameters] = useState<Record<string, Record<string, string>>>({});
  const mutable = canMutateRuntime(session);

  const refresh = async () => { await Promise.all([
    queryClient.invalidateQueries({queryKey: ['modules']}), queryClient.invalidateQueries({queryKey: ['instances']}),
    queryClient.invalidateQueries({queryKey: ['models']}), queryClient.invalidateQueries({queryKey: ['status']}),
  ]); };
  const moduleMutation = useMutation({
    mutationFn: ({name, enabled}: {name: string; enabled: boolean}) => enabled ? api.enableModule(name, parameters[name] ?? {}) : api.disableModule(name),
    onSuccess: refresh, onError: setOperationError,
  });
  const removeMutation = useMutation({mutationFn: (name: string) => api.removeInstance(name), onSuccess: async () => { setRemoveTarget(''); await refresh(); }, onError: setOperationError});

  const error = moduleQuery.error ?? instanceQuery.error ?? modelQuery.error ?? statusQuery.error ?? settingsQuery.error;
  if (error) return <ErrorNotice error={error} />;
  if ([moduleQuery, instanceQuery, modelQuery, statusQuery, settingsQuery].some((item) => item.isPending)) return <Loading />;

  const catalog = moduleQuery.data?.catalogJson?.modules ?? {};
  const moduleStates = moduleQuery.data?.modules ?? {};
  const definitions = moduleQuery.data?.catalogJson?.applications ?? {};
  const allInstances = flattenInstances(instanceQuery.data);
  const applications: ApplicationOption[] = Object.entries(definitions).map(([id, definition]) => ({
    id, label: definition.displayName ?? titleFromKey(id), definition,
    missing: missingApplicationModules(definition, moduleStates, catalog),
  })).sort((a, b) => a.label.localeCompare(b.label));
  const modelPayload = modelQuery.data as ModelsPayload;
  const deployedModels = [...new Set((modelPayload.models ?? []).filter((model) => String(model.type ?? '').toLowerCase() === 'chat').map((model) => model.id ?? model.name ?? '').filter(Boolean))].sort();
  const primaryModules = new Set(applications.map((item) => item.definition.requiredModules?.[0]).filter(Boolean));
  const moduleEntries = Object.entries(moduleStates).sort(([a], [b]) => (catalog[a]?.order ?? 9999) - (catalog[b]?.order ?? 9999));

  const hardwareState = (id: string, state: ModuleState) => effectiveModuleStatus(
    id,
    state,
    statusQuery.data,
    (modelPayload.vram as {available?: boolean} | undefined)?.available,
  );

  const moduleControls = (id: string, state: ModuleState, spec?: ModuleCatalogEntry, withStatus = true) => {
    const status = hardwareState(id, state);
    const phase = status.phase ?? (spec?.activationMode === 'static' && state.enabled ? 'Ready' : state.enabled ? 'Requested' : 'Disabled');
    const supportsCredentials = Boolean(spec?.credentials?.provider);
    const canToggle = mutable && (state.activationMode ?? spec?.activationMode) === 'moduleactivation';
    return <div className="actions">{withStatus && <StatusBadge phase={phase} />}
      {supportsCredentials && state.enabled && mutable && String(phase).toLowerCase() !== 'removing' && <Button variant="ghost" onClick={async () => { try { const result = await api.moduleCredentials(id); setCredentials({title: result.title ?? spec?.displayName ?? id, entries: result.credentials ?? []}); } catch (reason) { setOperationError(reason); } }}>Credentials</Button>}
      {canToggle && <Button variant={state.enabled ? 'danger' : 'primary'} disabled={moduleMutation.isPending || phaseInProgress(phase)} onClick={() => moduleMutation.mutate({name: id, enabled: !state.enabled})}>{state.enabled ? 'Disable' : 'Enable'}</Button>}
    </div>;
  };

  const moduleCard = ([id, state]: [string, ModuleState]) => {
    const spec = catalog[id]; const status = hardwareState(id, state);
    const phase = status.phase ?? (spec?.activationMode === 'static' && state.enabled ? 'Ready' : state.enabled ? 'Requested' : 'Disabled');
    const links = moduleResourceLinks(id, spec, statusQuery.data as SystemStatusPayload);
    const saved = Object.fromEntries(Object.entries((state.parameters ?? {}) as Record<string, unknown>).map(([key, value]) => [key, typeof value === 'object' && value ? String((value as Record<string, unknown>).size ?? (value as Record<string, unknown>).storageSize ?? '') : String(value ?? '')]));
    const parameterValues = parameters[id] ?? saved;
    return <Panel key={id} title={state.displayName ?? spec?.displayName ?? titleFromKey(id)} meta={id} actions={moduleControls(id, state, spec)}>
      {(status.message || spec?.description) && <p className="muted">{String(status.message || spec?.description)}</p>}
      {(phaseInProgress(phase) || phaseNeedsAttention(phase)) && <ProgressBar phase={phase} enabled={state.enabled} message={status.message} />}
      <ResourceLinks links={links} />
      {!state.enabled && <ModuleParameters catalog={spec} values={parameterValues} onChange={(value) => setParameters((current) => ({...current, [id]: value}))} />}
    </Panel>;
  };

  const instanceCard = (item: FlatInstance) => {
    const enabled = item.value.spec?.enabled !== false;
    const phase = item.value.status?.phase ?? (enabled ? 'Requested' : 'Suspended');
    const access = item.value.spec?.access?.authentication === 'none' ? 'public without login' : `SSO: ${item.value.spec?.access?.role ?? 'user'}`;
    const credentialsAvailable = ['openclaw', 'odysseus', 'paperclip'].includes(item.type) && String(phase).toLowerCase() !== 'removing';
    return <article className="service-instance" key={item.name}><div className="service-row"><div><strong>{item.name}</strong><small>{item.value.spec?.targetNamespace ?? 'ai'} · {access}</small></div><div className="actions"><StatusBadge phase={phase} />
      {credentialsAvailable && mutable && <Button variant="ghost" onClick={async () => { try { const result = await api.instanceCredentials(item.name); setCredentials({title: result.title ?? item.name, entries: result.credentials ?? []}); } catch (reason) { setOperationError(reason); } }}>Credentials</Button>}
      {mutable && String(phase).toLowerCase() !== 'removing' && <Button variant="danger" onClick={() => setRemoveTarget(item.name)}>Remove</Button>}
    </div></div>
      {(phaseInProgress(phase) || phaseNeedsAttention(phase)) && <ProgressBar phase={phase} enabled={enabled} message={item.value.status?.message} />}
      {item.value.status?.message && String(phase).toLowerCase() !== 'ready' && <p className="muted">{item.value.status.message}</p>}
      <ResourceLinks links={instanceResourceLinks(item.value, statusQuery.data)} />
    </article>;
  };

  const applicationCards = applications.map((application) => {
    const primaryId = application.definition.requiredModules?.[0] ?? '';
    const primary = moduleStates[primaryId]; const spec = catalog[primaryId];
    const items = allInstances.filter((item) => item.type === application.id);
    const isExpanded = expanded[application.id] ?? false;
    const ready = !application.missing.length;
    const stateStatus = primary ? hardwareState(primaryId, primary) : {};
    const phase = ready ? 'Ready' : stateStatus.phase ?? (primary?.enabled ? 'Waiting' : 'Disabled');
    const instanceUrls = new Set(items.flatMap((item) => instanceResourceLinks(item.value, statusQuery.data))
      .map((link) => link.url.replace(/\/$/, '')));
    const links = (primaryId ? moduleResourceLinks(primaryId, spec, statusQuery.data) : [])
      .filter((link) => !instanceUrls.has(link.url.replace(/\/$/, '')));
    return <Panel key={application.id} className="service-application" title={<span className="service-title"><span>{application.label}</span>{items.length > 0 && <Button variant="ghost" aria-expanded={isExpanded} onClick={() => setExpanded((current) => ({...current, [application.id]: !isExpanded}))}>{isExpanded ? '▾ Hide' : '▸ Show'}</Button>}</span>} meta={`Module · ${items.length} instance${items.length === 1 ? '' : 's'}`} actions={<><StatusBadge phase={phase} />{mutable && ready && deployedModels.length > 0 && <Button variant="primary" onClick={() => setCreate({open: true, type: application.id})}>New Instance</Button>}{primary && moduleControls(primaryId, primary, spec, false)}</>}>
      {application.missing.length > 0 && <p className="muted">Required services are not ready: {application.missing.map((id) => catalog[id]?.displayName ?? titleFromKey(id)).join(', ')}.</p>}
      {(phaseInProgress(phase) || phaseNeedsAttention(phase)) && <ProgressBar phase={phase} enabled={primary?.enabled} message={stateStatus.message} />}
      <ResourceLinks links={links} />
      {primary && !primary.enabled && <ModuleParameters catalog={spec} values={parameters[primaryId] ?? {}} onChange={(value) => setParameters((current) => ({...current, [primaryId]: value}))} />}
      {isExpanded && <div className="service-instance-list">{items.map(instanceCard)}</div>}
    </Panel>;
  });

  const standaloneApps = moduleEntries.filter(([id]) => !primaryModules.has(id) && catalog[id]?.group === 'apps');
  const runtime = moduleEntries.filter(([id]) => !primaryModules.has(id) && catalog[id]?.group === 'runtime');
  const platform = moduleEntries.filter(([id]) => !primaryModules.has(id) && !['apps', 'runtime'].includes(catalog[id]?.group ?? 'other'));
  const show = (section: typeof filter) => filter === 'all' || filter === section;

  return <div className="stack">
    <div className="section-title"><div><h2>Services</h2><p>{moduleEntries.filter(([, state]) => state.enabled).length} modules enabled · {allInstances.length} instance{allInstances.length === 1 ? '' : 's'}</p></div>{mutable && <Button variant="primary" disabled={!applications.some((item) => !item.missing.length) || !deployedModels.length} onClick={() => setCreate({open: true})}>Create Instance</Button>}</div>
    <div className="filter-bar" role="group" aria-label="Service category">{(['all', 'applications', 'runtime', 'platform'] as const).map((id) => <Button key={id} variant={filter === id ? 'primary' : 'ghost'} aria-pressed={filter === id} onClick={() => setFilter(id)}>{id === 'all' ? 'All' : id === 'runtime' ? 'AI Runtime' : titleFromKey(id)}</Button>)}</div>
    <ErrorNotice error={operationError} />
    {show('applications') && <section className="stack compact"><div className="section-title"><div><h2>Applications</h2><p>{applications.length + standaloneApps.length} services · {allInstances.length} instances</p></div></div>{applicationCards}{standaloneApps.map(moduleCard)}{!applications.length && !standaloneApps.length && <Empty>No application services are catalogued.</Empty>}</section>}
    {show('runtime') && <section className="stack compact"><div className="section-title"><div><h2>AI Runtime</h2><p>{runtime.length} module{runtime.length === 1 ? '' : 's'}</p></div></div>{runtime.map(moduleCard)}{!runtime.length && <Empty>No shared AI runtime modules are catalogued.</Empty>}</section>}
    {show('platform') && <details className="details-panel" open={filter === 'platform'}><summary><span><strong>Platform &amp; Operators</strong><small>{platform.length} technical module{platform.length === 1 ? '' : 's'}</small></span><span>Show</span></summary><div className="stack compact details-content">{platform.map(moduleCard)}</div></details>}
    <CreateInstanceDialog key={`${create.open}-${create.type ?? 'all'}`} open={create.open} initialType={create.type} applications={applications} models={deployedModels} instances={allInstances} publicDomain={settingsQuery.data?.publicDomain ?? 'magicstick.example.com'} onClose={() => setCreate({open: false})} onCreated={refresh} />
    <Dialog open={Boolean(credentials)} title={credentials?.title ?? 'Credentials'} description="Sensitive values are shown only on request." onClose={() => setCredentials(null)}><dl className="credential-list">{credentials?.entries.map((entry) => <div key={entry.key}><dt>{entry.key}</dt><dd><code>{entry.value}</code></dd></div>)}</dl></Dialog>
    <ConfirmDialog key={removeTarget} open={Boolean(removeTarget)} title="Remove instance" description={`Remove ${removeTarget}? Its reconciled application resources will be removed by the operator.`} confirmLabel="Remove" busy={removeMutation.isPending} error={removeMutation.error} onClose={() => setRemoveTarget('')} onConfirm={() => removeMutation.mutate(removeTarget)} />
  </div>;
};
