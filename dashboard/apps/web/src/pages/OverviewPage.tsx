import {useQuery} from '@tanstack/react-query';
import {
  flattenInstances,
  effectiveModuleStatus,
  instanceResourceLinks,
  moduleResourceLinks,
  phaseNeedsAttention,
  titleFromKey,
  type ResourceLink,
} from '@magicstick/dashboard-core';
import {api} from '../api';
import {Empty, ErrorNotice, Loading, Panel, ResourceLinks, StatusBadge} from '../components';

const instanceTitle = (type: string, name: string) => {
  const prefix = `${type}-`;
  const shortName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return `${titleFromKey(type)}${shortName && shortName !== type ? ` ${shortName}` : ''}`;
};

export const OverviewPage = () => {
  const appliance = useQuery({queryKey: ['appliance'], queryFn: () => api.appliance()});
  const modules = useQuery({queryKey: ['modules'], queryFn: () => api.modules()});
  const instances = useQuery({queryKey: ['instances'], queryFn: () => api.instances()});
  const models = useQuery({queryKey: ['models'], queryFn: () => api.models()});
  const status = useQuery({queryKey: ['status'], queryFn: () => api.status()});

  const error = appliance.error ?? modules.error ?? instances.error ?? models.error ?? status.error;
  if (error) return <ErrorNotice error={error} />;
  if ([appliance, modules, instances, models, status].some((query) => query.isPending)) return <Loading />;

  const moduleEntries = Object.entries(modules.data?.modules ?? {});
  const instanceValues = flattenInstances(instances.data);
  const activations = models.data?.activations ?? [];
  const activationNames = new Set(activations.map((item) => item.metadata?.name).filter(Boolean));
  const registered = (models.data?.models ?? []).filter((model) => !activationNames.has(model.id));
  const catalog = modules.data?.catalogJson?.modules ?? {};
  const nvidiaTelemetryAvailable = (models.data?.vram as {available?: boolean} | undefined)?.available;
  const moduleStatus = (id: string, module: (typeof moduleEntries)[number][1]) => effectiveModuleStatus(id, module, status.data, nvidiaTelemetryAvailable);
  const resources: Array<{id: string; title: string; subtitle: string; phase: string; links: ResourceLink[]}> = [];

  instanceValues.forEach((item) => {
    const enabled = item.value.spec?.enabled !== false;
    resources.push({
      id: `instance-${item.name}`,
      title: instanceTitle(item.type, item.name),
      subtitle: 'Instance',
      phase: item.value.status?.phase ?? (enabled ? 'Requested' : 'Suspended'),
      links: instanceResourceLinks(item.value, status.data),
    });
  });
  moduleEntries.forEach(([id, module]) => {
    const activationMode = module.activationMode ?? catalog[id]?.activationMode;
    const effectiveStatus = moduleStatus(id, module);
    resources.push({
      id: `module-${id}`,
      title: module.displayName ?? catalog[id]?.displayName ?? titleFromKey(id),
      subtitle: 'Module',
      phase: effectiveStatus.phase ?? (activationMode === 'static' && module.enabled ? 'Ready' : module.enabled ? 'Requested' : 'Disabled'),
      links: moduleResourceLinks(id, catalog[id], status.data),
    });
  });
  const linkedResources = resources.filter((item) => item.links.length);
  const urlCount = new Set(linkedResources.flatMap((item) => item.links.map((link) => link.url.replace(/\/$/, '')))).size;

  const attention: Array<{id: string; title: string; detail: string; phase: string}> = [];
  const applianceConditions = Array.isArray(appliance.data?.status?.conditions) ? appliance.data.status.conditions as Array<Record<string, unknown>> : [];
  applianceConditions.forEach((condition, index) => {
    if (condition.status && condition.status !== 'True') attention.push({id: `appliance-${index}`, title: `Appliance ${String(condition.type ?? 'Condition')}`, detail: String(condition.reason ?? condition.message ?? condition.status), phase: 'Degraded'});
  });
  moduleEntries.forEach(([id, module]) => {
    const effectiveStatus = moduleStatus(id, module);
    const phase = effectiveStatus.phase ?? (module.enabled ? 'Requested' : 'Disabled');
    if (phaseNeedsAttention(phase)) attention.push({id: `module-${id}`, title: `Module ${module.displayName ?? catalog[id]?.displayName ?? titleFromKey(id)}`, detail: effectiveStatus.message ?? phase, phase});
  });
  instanceValues.forEach((item) => {
    const phase = item.value.status?.phase ?? (item.value.spec?.enabled === false ? 'Suspended' : 'Requested');
    if (phaseNeedsAttention(phase)) attention.push({id: `instance-${item.name}`, title: `Instance ${instanceTitle(item.type, item.name)}`, detail: item.value.status?.message ?? phase, phase});
  });
  activations.forEach((activation) => {
    const phase = activation.status?.phase ?? (activation.spec?.enabled === false ? 'Disabled' : 'Requested');
    if (phaseNeedsAttention(phase) || activation.metadata?.deletionTimestamp) attention.push({id: `model-${activation.metadata?.name}`, title: `Model ${activation.metadata?.name ?? 'unnamed'}`, detail: activation.status?.message ?? (activation.metadata?.deletionTimestamp ? 'Removing' : phase), phase: activation.metadata?.deletionTimestamp ? 'Removing' : phase});
  });
  (status.data?.fluxKustomizations ?? []).forEach((item) => {
    const ready = item.conditions?.find((condition) => condition.type === 'Ready');
    if (ready?.status && ready.status !== 'True') attention.push({id: `flux-${item.namespace}-${item.name}`, title: `Flux ${item.name ?? 'Kustomization'}`, detail: ready.reason ?? ready.message ?? ready.status, phase: 'Reconciling'});
  });

  return (
    <div className="stack">
      <div className="section-title"><div><h2>Overview</h2><p>Live state from the shared appliance control plane.</p></div></div>
      <div className="metric-grid">
        <article className="metric"><span>Appliance</span><strong>{appliance.data?.metadata?.name ?? 'local'}</strong><StatusBadge phase={appliance.data?.status?.phase} /></article>
        <article className="metric"><span>Modules</span><strong>{moduleEntries.filter(([, item]) => item.enabled).length}</strong><small>enabled</small></article>
        <article className="metric"><span>Instances</span><strong>{instanceValues.length}</strong><small>configured</small></article>
        <article className="metric"><span>Models</span><strong>{activations.length + registered.length}</strong><small>installed or registered</small></article>
      </div>
      <Panel title="Available URLs" meta={`${urlCount} URL${urlCount === 1 ? '' : 's'} from modules and instances.`}>
        {linkedResources.length ? <div className="overview-resources">{linkedResources.map((item) => <article className="overview-resource" key={item.id}><div><strong>{item.title}</strong><small>{item.subtitle} · {item.phase}</small></div><ResourceLinks links={item.links} /></article>)}</div> : <Empty>No module or instance URLs discovered yet.</Empty>}
      </Panel>
      <Panel title="Attention" meta={attention.length ? `${attention.length} item${attention.length === 1 ? '' : 's'}` : 'No issues'}>
        <div className="list">
          {attention.map((item) => <article className="list-row" key={item.id}><div><strong>{item.title}</strong><p>{item.detail}</p></div><StatusBadge phase={item.phase} /></article>)}
          {!attention.length && <Empty>No issues detected.</Empty>}
        </div>
      </Panel>
    </div>
  );
};
