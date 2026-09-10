import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {HostAction, HostPreparationPlan, ManagedHost, Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {HostGpuMemoryPanel} from './HostGpuMemory';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted']);
const active = (host: ManagedHost) => Boolean(host.operation && !terminal.has(host.operation.phase));
const useHosts = () => useQuery({queryKey: ['host-management'], queryFn: () => api.hostManagement(), refetchInterval: 5_000, retry: false});

const Operation = ({host}: {host: ManagedHost}) => host.operation ? <div className="notice" role="status"><strong>{host.operation.action} · {host.operation.phase}</strong><p>{host.operation.message || 'Waiting for the local host worker.'}</p>{['RebootScheduled', 'PoweroffScheduled'].includes(host.operation.phase) && <p>The connection will be interrupted. A shutdown needs local power-on or separately configured remote power management to return. This page never repeats a power request automatically.</p>}</div> : null;

const useHostAction = () => {
  const client = useQueryClient();
  const [pending, setPending] = useState<{host: ManagedHost; action: HostAction; plan?: HostPreparationPlan; requestId: string} | null>(null);
  const [accepted, setAccepted] = useState(false);
  const mutation = useMutation({
    mutationFn: () => {
      if (!pending) throw new Error('No host operation selected.');
      return api.requestHostOperation({action: pending.action, nodeName: pending.host.name, nodeUid: pending.host.nodeUid,
        bootId: pending.host.bootId, requestId: pending.requestId, confirmation: pending.host.name, acknowledgeDisruption: true,
        allowExperimental: pending.plan?.experimental === true, experimentMode: pending.plan?.experimentMode === true,
        ...(pending.plan ? {planId: pending.plan.id} : {})});
    },
    retry: false,
    onSuccess: async () => {setPending(null); setAccepted(true); await client.invalidateQueries({queryKey: ['host-management']});},
  });
  const start = (host: ManagedHost, action: HostAction, plan?: HostPreparationPlan) => {
    mutation.reset(); setAccepted(false); setPending({host, action, plan, requestId: crypto.randomUUID().replaceAll('-', '')});
  };
  const label = pending?.action === 'reboot' ? 'Restart computer' : pending?.action === 'poweroff' ? 'Shut down computer' : pending?.plan?.experimentMode ? 'Start hardware experiment' : 'Prepare hardware';
  const details = pending?.action === 'prepare-gpu'
    ? `${pending.plan?.experimentMode ? 'This GPU combination is unreviewed. Other GPUs or network access may fail. Have local console access and the previous kernel available. ' : ''}Apply only the displayed host profile to ${pending.host.name}. ${pending.plan?.rebootRequired ? 'This authorizes package preparation and one orderly restart after preparation.' : 'No package change or restart is planned.'} ${pending.plan?.engineValidationAvailable === false ? 'Engine validation is unavailable for this multi-AMD layout; preparing the host does not enable these GPUs.' : 'Then enable the experimental AMD runtime profile and run both tiny-model GPU tests on matching cluster nodes; image downloads and GPU resources are required. Package and power changes apply only to the selected computer.'} Interruptions are possible; this is not general support certification.`
    : `${pending?.host.name}: ${pending?.action === 'reboot' ? 'Restart' : 'Power off'} this computer in about one minute after the local worker accepts the request. All services and workloads on this computer will be interrupted. ${pending?.action === 'poweroff' ? 'You must turn the computer back on locally or use separately configured remote power management. ' : ''}Save your work. There is no automatic migration of workloads.`;
  return {start, pending, accepted, dialog: <ConfirmDialog open={Boolean(pending)} title={label} description={details} confirmLabel={label}
    expectedValue={pending?.host.name} busy={mutation.isPending} error={mutation.error} onClose={() => {if (!mutation.isPending) setPending(null);}} onConfirm={() => mutation.mutate()} />};
};

export const HostPowerPanel = () => {
  const query = useHosts();
  const [selection, setSelection] = useState('');
  const action = useHostAction();
  const hosts = query.data?.nodes ?? [];
  const host = hosts.find((item) => item.name === selection) ?? hosts[0];
  return <Panel title="Computer power">
    <p className="muted">Administrator actions for the selected physical computer, not just the dashboard or a container.</p>
    {query.isPending ? <Loading /> : <>
      {query.error && action.accepted ? <div className="notice notice-warn" role="status">The request was accepted, but the computer is currently unreachable. Completion cannot be confirmed. No request will be repeated automatically.</div> : <ErrorNotice error={query.error} />}
      {hosts.length > 1 && <Field label="Computer"><select value={host?.name} onChange={(event) => setSelection(event.target.value)}>{hosts.map((item) => <option key={item.nodeUid}>{item.name}</option>)}</select></Field>}
      {host ? <div className="stack compact"><div className="section-title"><div><strong>{host.name}</strong><p className="muted">Kernel: {host.kernel} · {host.message}</p></div><div className="form-actions"><Button variant="ghost" disabled={!host.available || active(host) || Boolean(action.pending) || Boolean(query.error)} onClick={() => action.start(host, 'reboot')}>Restart computer</Button><Button variant="danger" disabled={!host.available || active(host) || Boolean(action.pending) || Boolean(query.error)} onClick={() => action.start(host, 'poweroff')}>Shut down computer</Button></div></div><Operation host={host} /></div> : !query.error && <Empty>No manageable computers reported yet.</Empty>}
      {action.accepted && !query.error && <p role="status">Request accepted. Waiting for the local host worker; this is not confirmation that the computer has restarted or powered off.</p>}
    </>}
    {action.dialog}
  </Panel>;
};

const Preparation = ({host, session, stale}: {host: ManagedHost; session: Session; stale: boolean}) => {
  const [experiment, setExperiment] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const action = useHostAction();
  const plan = experiment ? host.plan?.experiment : host.plan;
  const actionable = plan && ['available', 'ready'].includes(plan.state);
  return <article className="operator-card stack compact">
    <header><strong>{host.name}</strong><StatusBadge phase={host.available ? plan?.state ?? 'Unknown' : 'Unavailable'} /></header>
    <p>{experiment ? 'Automatic preparation remains blocked. You are reviewing a one-off experimental override below.' : host.plan?.message || host.message}</p>
    {canAdminister(session) && host.plan?.experiment && <label className="check-field"><input type="checkbox" checked={experiment} onChange={(event) => {setExperiment(event.target.checked); setAcknowledged(false);}} /> Experiment mode — test an unreviewed hardware combination</label>}
    {plan && <><dl className="facts"><div><dt>Detected GPU devices</dt><dd>{plan.displayGpus?.join(', ') || 'None'}</dd></div><div><dt>Host profile</dt><dd>{plan.profileId || 'No additional profile'}{plan.profileVersion ? ` · ${plan.profileVersion}` : ''}</dd></div><div><dt>Running kernel</dt><dd>{host.kernel}</dd></div><div><dt>Planned kernel</dt><dd>{plan.rebootRequired ? plan.targetKernel : 'Unchanged'}</dd></div></dl>
      {Object.keys(plan.packages).length > 0 && <div><strong>Exact package changes</strong><ul>{Object.entries(plan.packages).map(([name, version]) => <li key={name}>{name} = {version}</li>)}</ul></div>}
      {experiment && <div className="notice notice-warn"><strong>Unreviewed hardware experiment</strong><p>{plan.message}</p>{plan.engineValidationAvailable === false && <p>Engine validation is unavailable for this multi-AMD layout. Host preparation alone will not make the GPUs available to models.</p>}</div>}
      {canAdminister(session) && actionable && <><label className="check-field"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I accept the experimental profile{experiment ? ', the unreviewed GPU combination and local recovery risk' : ' and its limitations'}.</label><div className="form-actions"><Button disabled={!host.available || active(host) || !acknowledged || Boolean(action.pending)} onClick={() => action.start(host, 'prepare-gpu', plan)}>{experiment ? 'Review hardware experiment' : 'Review hardware preparation'}</Button></div></>}
    </>}
    <HostGpuMemoryPanel host={host} session={session} stale={stale} />
    <Operation host={host} />
    {action.accepted && <p role="status">Preparation requested. Progress continues on the computer even if this page is closed.</p>}
    {action.dialog}
  </article>;
};

export const HostPreparationPanel = ({session}: {session: Session}) => {
  const query = useHosts();
  return <Panel title="Host preparation"><p className="muted">The same post-install workflow prepares new and existing computers. Periodic inspection never installs packages or reboots without approval. Power controls are in System.</p>
    <ErrorNotice error={query.error} />
    {query.isPending ? <Loading /> : <div className="stack">{(query.data?.nodes ?? []).map((host) => <Preparation key={`${host.nodeUid}:${host.bootId}:${host.plan?.id}`} host={host} session={session} stale={Boolean(query.error)} />)}</div>}
  </Panel>;
};
