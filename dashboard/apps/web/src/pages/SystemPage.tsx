import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {Empty, ErrorNotice, Loading, Panel, StatusBadge} from '../components';

export const SystemPage = () => {
  const query = useQuery({queryKey: ['status'], queryFn: () => api.status()});
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;
  const status = query.data;
  const operators = Object.entries(status.hardwareOperators ?? {}).sort(([, left], [, right]) => String(left.displayName ?? left.module ?? '').localeCompare(String(right.displayName ?? right.module ?? '')));
  const activeOperators = operators.filter(([, operator]) => operator.operatorActive).length;
  const readyOperators = operators.filter(([, operator]) => String(operator.phase).toLowerCase() === 'ready').length;
  const runningPods = (status.pods ?? []).filter((pod) => pod.phase === 'Running').length;
  return <div className="stack">
    <div className="section-title"><div><h2>System Status</h2><p>Operators, reconciliation and Kubernetes resources.</p></div><button className="button button-ghost" onClick={() => query.refetch()}>Refresh</button></div>
    <Panel title="GPU Operators" meta={`${readyOperators} ready / ${activeOperators} active / ${operators.length} known`}>
      <p className="muted">Operators activate only when shared hardware discovery finds a matching GPU.</p>
      {operators.length ? <div className="card-grid">{operators.map(([id, operator]) => <article className="operator-card" key={id}><header><strong>{operator.displayName ?? id}</strong><StatusBadge phase={operator.phase} /></header><dl className="facts"><div><dt>Version</dt><dd>{operator.operatorVersion ?? 'unknown'}</dd></div><div><dt>Driver mode</dt><dd>{operator.driverMode ?? 'unknown'}</dd></div><div><dt>Detected / compatible</dt><dd>{operator.detectedNodes?.length ?? 0} / {operator.compatibleNodes?.length ?? 0} nodes</dd></div><div><dt>Allocatable</dt><dd>{operator.allocatableResources ?? 0} resource(s)</dd></div><div><dt>Managed by</dt><dd>{operator.managedBy ?? 'none'}</dd></div><div><dt>Needed</dt><dd>{operator.needed ? 'yes' : 'no'}</dd></div></dl><p className="muted">{operator.message ?? 'No status message.'}</p></article>)}</div> : <Empty>Hardware operator status has not been reported yet.</Empty>}
    </Panel>
    <Panel title="Flux" meta={`${status.fluxKustomizations?.length ?? 0} Kustomization${status.fluxKustomizations?.length === 1 ? '' : 's'}`}>
      {(status.fluxKustomizations?.length ?? 0) > 0 ? <div className="list">{status.fluxKustomizations?.map((item) => { const ready = item.conditions?.find((condition) => condition.type === 'Ready'); const phase = ready?.status === 'True' ? 'Ready' : item.phase || 'Reconciling'; return <article className="list-row" key={`${item.namespace}-${item.name}`}><div><strong>{item.namespace}/{item.name}</strong>{(ready?.reason || ready?.message) && <p>{ready.reason ?? ready.message}</p>}</div><StatusBadge phase={phase} /></article>; })}</div> : <Empty>No Flux objects returned.</Empty>}
    </Panel>
    <div className="metric-grid"><article className="metric"><span>Pods</span><strong>{runningPods}/{status.pods?.length ?? 0}</strong><small>running</small></article><article className="metric"><span>Services</span><strong>{status.services?.length ?? 0}</strong><small>discovered</small></article><article className="metric"><span>Ingresses</span><strong>{status.ingresses?.length ?? 0}</strong><small>discovered</small></article><article className="metric"><span>Gateway Routes</span><strong>{status.httpRoutes?.length ?? 0}</strong><small>discovered</small></article></div>
    <Panel title="Gateway Routes" meta={`${(status.httpRoutes ?? []).filter((route) => route.accepted).length} accepted`}>
      {(status.httpRoutes?.length ?? 0) > 0 ? <div className="list">{status.httpRoutes?.map((route) => <article className="list-row" key={`${route.namespace}-${route.name}`}><div><strong>{route.namespace}/{route.name}</strong><div className="tag-list">{route.hostnames?.map((hostname) => <a className="tag" key={hostname} href={`https://${hostname}/`} target="_blank" rel="noreferrer">{hostname}</a>)}</div></div><StatusBadge phase={route.accepted ? 'Accepted' : 'Pending'} /></article>)}</div> : <Empty>No Gateway API routes returned.</Empty>}
    </Panel>
  </div>;
};
