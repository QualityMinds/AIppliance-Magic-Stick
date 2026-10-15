import {useQuery} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, Empty, ErrorNotice, Loading, Panel, StatusBadge} from '../components';
import {ModelCachePage} from './ModelCachePage';
import {RegressionPage} from './RegressionPage';

export type StatusSectionId = 'overview' | 'gpu-operators' | 'flux' | 'network' | 'model-cache' | 'regression';
type ResourceSectionId = Exclude<StatusSectionId, 'model-cache' | 'regression'>;

const sections: Array<{id: StatusSectionId; label: string; admin?: boolean}> = [
  {id: 'overview', label: 'Overview'},
  {id: 'gpu-operators', label: 'GPU Operators'},
  {id: 'flux', label: 'Flux'},
  {id: 'network', label: 'Network & routes'},
  {id: 'model-cache', label: 'Model cache', admin: true},
  {id: 'regression', label: 'Regression tests', admin: true},
];

export const isStatusSection = (value: string): value is StatusSectionId => sections.some((section) => section.id === value);
export const allowedStatusSections = (session: Session) => sections.filter((section) => !section.admin || canAdminister(session));

export const SystemPage = ({session, section, onSectionChange}: {
  session: Session;
  section: StatusSectionId;
  onSectionChange: (section: StatusSectionId) => void;
}) => {
  const allowed = allowedStatusSections(session);
  const active = allowed.some((item) => item.id === section) ? section : 'overview';
  return <div className="stack">
    <div className="section-title"><div><h2>System Status</h2><p>System health, resource details and maintenance tools.</p></div></div>
    <div className="filter-bar" role="tablist" aria-label="System Status sections">
      {allowed.map((item, index) => <Button
        key={item.id}
        id={`system-status-tab-${item.id}`}
        type="button"
        role="tab"
        aria-selected={active === item.id}
        aria-controls="system-status-panel"
        tabIndex={active === item.id ? 0 : -1}
        variant={active === item.id ? 'primary' : 'ghost'}
        onClick={() => onSectionChange(item.id)}
        onKeyDown={(event) => {
          const next = event.key === 'ArrowRight' ? (index + 1) % allowed.length
            : event.key === 'ArrowLeft' ? (index + allowed.length - 1) % allowed.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? allowed.length - 1 : undefined;
          if (next === undefined) return;
          event.preventDefault();
          onSectionChange(allowed[next]!.id);
          event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >{item.label}</Button>)}
    </div>
    <div id="system-status-panel" role="tabpanel" aria-labelledby={`system-status-tab-${active}`}>
      {active === 'model-cache' ? <ModelCachePage /> : active === 'regression' ? <RegressionPage /> : <ResourceStatus section={active} />}
    </div>
  </div>;
};

const ResourceStatus = ({section}: {section: ResourceSectionId}) => {
  const query = useQuery({queryKey: ['status'], queryFn: () => api.status()});
  if (query.error) return <div className="stack"><ErrorNotice error={query.error} /><Button type="button" onClick={() => query.refetch()}>Retry status</Button></div>;
  if (query.isPending || !query.data) return <Loading />;
  const status = query.data;
  const operators = Object.entries(status.hardwareOperators ?? {}).sort(([, left], [, right]) => String(left.displayName ?? left.module ?? '').localeCompare(String(right.displayName ?? right.module ?? '')));
  const activeOperators = operators.filter(([, operator]) => operator.operatorActive).length;
  const readyOperators = operators.filter(([, operator]) => String(operator.phase).toLowerCase() === 'ready').length;
  const runningPods = (status.pods ?? []).filter((pod) => pod.phase === 'Running').length;
  const readyFlux = (status.fluxKustomizations ?? []).filter((item) => item.conditions?.some((condition) => condition.type === 'Ready' && condition.status === 'True')).length;
  const acceptedRoutes = (status.httpRoutes ?? []).filter((route) => route.accepted).length;
  return <div className="stack">
    <div className="form-actions"><Button type="button" variant="ghost" onClick={() => query.refetch()}>Refresh status</Button></div>
    {section === 'overview' && <>
      <div className="metric-grid" aria-label="Kubernetes resource counts"><article className="metric"><span>Pods</span><strong>{runningPods}/{status.pods?.length ?? 0}</strong><small>running</small></article><article className="metric"><span>Services</span><strong>{status.services?.length ?? 0}</strong><small>discovered</small></article><article className="metric"><span>Ingresses</span><strong>{status.ingresses?.length ?? 0}</strong><small>discovered</small></article><article className="metric"><span>Gateway Routes</span><strong>{status.httpRoutes?.length ?? 0}</strong><small>discovered</small></article></div>
      <Panel title="Status summary">
        <dl className="facts">
          <div><dt>GPU operators</dt><dd>{readyOperators} ready / {activeOperators} active / {operators.length} known</dd></div>
          <div><dt>Flux</dt><dd>{readyFlux} / {status.fluxKustomizations?.length ?? 0} ready</dd></div>
          <div><dt>Gateway routes</dt><dd>{acceptedRoutes} / {status.httpRoutes?.length ?? 0} accepted</dd></div>
        </dl>
        <p className="muted">Open the corresponding tab for component details and reported failure reasons.</p>
      </Panel>
    </>}
    {section === 'gpu-operators' && <Panel title="GPU Operators" meta={`${readyOperators} ready / ${activeOperators} active / ${operators.length} known`}>
      <p className="muted">Operators activate only when shared hardware discovery finds a matching GPU.</p>
      {operators.length ? <div className="card-grid">{operators.map(([id, operator]) => <article className="operator-card" key={id}><header><strong>{operator.displayName ?? id}</strong><StatusBadge phase={operator.phase} /></header><dl className="facts"><div><dt>Version</dt><dd>{operator.operatorVersion ?? 'unknown'}</dd></div><div><dt>Driver mode</dt><dd>{operator.driverMode ?? 'unknown'}</dd></div><div><dt>Detected / compatible</dt><dd>{operator.detectedNodes?.length ?? 0} / {operator.compatibleNodes?.length ?? 0} nodes</dd></div><div><dt>Allocatable</dt><dd>{operator.allocatableResources ?? 0} resource(s)</dd></div><div><dt>Managed by</dt><dd>{operator.managedBy ?? 'none'}</dd></div><div><dt>Needed</dt><dd>{operator.needed ? 'yes' : 'no'}</dd></div></dl><p className="muted">{operator.message ?? 'No status message.'}</p></article>)}</div> : <Empty>Hardware operator status has not been reported yet.</Empty>}
    </Panel>}
    {section === 'flux' && <Panel title="Flux" meta={`${status.fluxKustomizations?.length ?? 0} Kustomization${status.fluxKustomizations?.length === 1 ? '' : 's'}`}>
      {(status.fluxKustomizations?.length ?? 0) > 0 ? <div className="list">{status.fluxKustomizations?.map((item) => { const ready = item.conditions?.find((condition) => condition.type === 'Ready'); const phase = ready?.status === 'True' ? 'Ready' : item.phase || 'Reconciling'; return <article className="list-row" key={`${item.namespace}-${item.name}`}><div><strong>{item.namespace}/{item.name}</strong>{ready?.reason && <p>{ready.reason}</p>}{ready?.message && ready.message !== ready.reason && <p className="muted">{ready.message}</p>}</div><StatusBadge phase={phase} /></article>; })}</div> : <Empty>No Flux objects returned.</Empty>}
    </Panel>}
    {section === 'network' && <Panel title="Gateway Routes" meta={`${acceptedRoutes} accepted`}>
      {(status.httpRoutes?.length ?? 0) > 0 ? <div className="list">{status.httpRoutes?.map((route) => <article className="list-row" key={`${route.namespace}-${route.name}`}><div><strong>{route.namespace}/{route.name}</strong><div className="tag-list">{route.hostnames?.map((hostname) => <a className="tag" key={hostname} href={`https://${hostname}/`} target="_blank" rel="noreferrer">{hostname}</a>)}</div></div><StatusBadge phase={route.accepted ? 'Accepted' : 'Pending'} /></article>)}</div> : <Empty>No Gateway API routes returned.</Empty>}
    </Panel>}
  </div>;
};
