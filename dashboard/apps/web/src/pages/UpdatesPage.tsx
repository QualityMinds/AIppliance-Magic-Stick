import {useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import type {HostOperationRequest, HostUpdatePolicy, ManagedHost} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';
import {useHosts} from './HostManagement';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted', 'RolledBack']);
const date = (value?: string) => value ? new Date(value).toLocaleString() : 'Not yet';

const HostUpdateEditor = ({host, stale}: {host: ManagedHost; stale: boolean}) => {
  const updates = host.updates!;
  const client = useQueryClient();
  const [draft, setDraft] = useState<HostUpdatePolicy>(updates.policy);
  const [pending, setPending] = useState<HostOperationRequest | null>(null);
  const operation = host.operation;
  const active = Boolean(operation && !terminal.has(operation.phase));
  const mutation = useMutation({mutationFn: (payload: HostOperationRequest) => api.requestHostOperation(payload), retry: false,
    onSuccess: async () => {setPending(null); await client.invalidateQueries({queryKey: ['host-management']});}});
  const disabled = stale || !host.available || updates.busy || active || mutation.isPending;
  const payload = (action: HostOperationRequest['action'], extra = {}): HostOperationRequest => ({
    action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId, planId: updates.id,
    requestId: crypto.randomUUID().replaceAll('-', ''), confirmation: host.name,
    acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, ...extra,
  });
  const edit = <K extends keyof HostUpdatePolicy>(key: K, value: HostUpdatePolicy[K]) => setDraft((current) => ({...current, [key]: value}));
  const changed = JSON.stringify(draft) !== JSON.stringify(updates.policy);
  const policyValid = /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(draft.windowStart)
    && Number.isInteger(draft.windowMinutes) && draft.windowMinutes >= 15 && draft.windowMinutes <= 360;
  const saving = pending?.action === 'configure-updates';
  return <div className="stack">
    <div className="section-title"><StatusBadge phase={updates.busy ? 'Updating' : updates.phase ?? 'Ready'} />
      <Button variant="ghost" disabled={disabled} onClick={() => mutation.mutate(payload('check-updates'))}>Check for updates</Button></div>
    {updates.message && <div className="inline-info"><span>{updates.busy ? 'Ubuntu updates running' : updates.phase === 'Failed' || updates.phase === 'Interrupted' ? 'Update needs attention' : 'Update status'}</span><InfoPopover label={`Update status on ${host.name}`}><p className="memory-info-note">{updates.message}</p></InfoPopover></div>}
    <dl className="facts">
      <div><dt>Available updates</dt><dd>{updates.pendingCount ?? '—'}</dd></div>
      <div><dt>Security updates</dt><dd>{updates.securityCount ?? '—'}</dd></div>
      <div><dt>Held / hardware updates</dt><dd>{updates.blockedCount ?? '—'}</dd></div>
      <div><dt>Last check</dt><dd>{date(updates.checkedAt)}</dd></div>
      <div><dt>Last successful installation</dt><dd>{date(updates.lastSuccessAt)}</dd></div>
    </dl>
    {updates.rebootRequired && <div className="notice notice-warn" role="status">Restart required <a href="#/system/power">Computer power</a></div>}
    <form className="stack" onSubmit={(event) => {event.preventDefault(); setPending(payload('configure-updates', {updatePolicy: draft}));}}>
      <fieldset disabled={disabled} className="form-grid">
        <Field label="Automatic updates"><select value={draft.mode} onChange={(event) => edit('mode', event.target.value as HostUpdatePolicy['mode'])}>
          <option value="security">Security updates</option><option value="all">Security and regular Ubuntu updates</option><option value="manual">Manual installation</option>
        </select></Field>
        <Field label="Maintenance start (UTC)"><input type="time" required value={draft.windowStart} onChange={(event) => edit('windowStart', event.target.value)} /></Field>
        <Field label="Window duration (minutes)"><input type="number" required min={15} max={360} value={draft.windowMinutes} onChange={(event) => edit('windowMinutes', Number(event.target.value))} /></Field>
        <label className="check-field"><input type="checkbox" checked={draft.automaticReboot} onChange={(event) => edit('automaticReboot', event.target.checked)} /> Allow automatic restart in this window</label>
      </fieldset>
      <div className="form-actions"><Button type="submit" disabled={disabled || !changed || !policyValid}>Save update settings</Button></div>
    </form>
    <div className="form-actions">
      <Button disabled={disabled || !updates.securityCount} onClick={() => setPending(payload('install-updates', {updateScope: 'security'}))}>Install security updates</Button>
      <Button variant="ghost" disabled={disabled || !updates.pendingCount} onClick={() => setPending(payload('install-updates', {updateScope: 'all'}))}>Install Ubuntu updates</Button>
    </div>
    {operation && operation.action.includes('updates') && <div className="notice" role="status"><strong>{operation.action} · {operation.phase}</strong><InfoPopover label={`Update operation on ${host.name}`}><p className="memory-info-note">{operation.message ?? 'Waiting for the host worker.'}</p></InfoPopover></div>}
    <ErrorNotice error={mutation.error} />
    {Boolean(updates.packages?.length) && <details><summary>Available packages ({updates.pendingCount})</summary><div className="table-wrap"><table>
      <thead><tr><th>Package</th><th>Installed</th><th>Available</th><th>Status</th></tr></thead>
      <tbody>{updates.packages!.map((item) => <tr key={item.name}><td>{item.name}</td><td>{item.installed}</td><td>{item.candidate}</td><td>{item.security ? 'Security · ' : ''}{item.blocked || 'Eligible'}</td></tr>)}</tbody>
    </table></div>{updates.truncated && <p className="muted">Showing the first {updates.packages!.length} packages.</p>}</details>}
    <ConfirmDialog open={Boolean(pending)} title={saving ? 'Save update settings' : 'Install Ubuntu updates'}
      description={saving
        ? `${host.name}: ${draft.mode === 'manual' ? 'Manual package installation' : `Automatic ${draft.mode === 'security' ? 'security' : 'Ubuntu'} updates daily from ${draft.windowStart} UTC for ${draft.windowMinutes} minutes`}. ${draft.automaticReboot && draft.mode !== 'manual' ? 'Automatic computer restarts are enabled within the window.' : 'Computer restarts remain manual.'} Package updates can restart services. Running installations finish even if the window ends.`
        : `${host.name}: install ${pending?.updateScope === 'security' ? 'security' : 'eligible Ubuntu'} updates now. Services and models may be interrupted. Kernel, GPU and held packages remain excluded. This manual action does not restart the computer automatically.`}
      confirmLabel={saving ? 'Save settings' : 'Install updates'} expectedValue={host.name} busy={mutation.isPending} error={mutation.error}
      onClose={() => {if (!mutation.isPending) setPending(null);}} onConfirm={() => {if (pending) mutation.mutate(pending);}} />
  </div>;
};

export const UpdatesPage = () => {
  const hosts = useHosts();
  return <div className="stack"><div className="section-title"><div className="inline-info"><h2>Updates</h2><InfoPopover label="Ubuntu updates"><p className="memory-info-note">Updates use the configured Ubuntu APT mirrors. Automatic installations start in the UTC maintenance window; busy hosts retry inside that window. Running package transactions may finish later. Kernel, GPU driver and firmware updates remain in Hardware preparation. K3s, operators and container images use the Magic Stick release workflow. Services may restart during package installation.</p></InfoPopover></div></div>
    <ErrorNotice error={hosts.error} />{hosts.isPending && <Loading />}
    {hosts.data?.nodes.map((host) => <Panel key={host.nodeUid} title={host.name}>
      {host.updates?.supported ? <HostUpdateEditor key={`${host.bootId}:${host.updates.id}`} host={host} stale={Boolean(hosts.error)} /> : <Empty>Update management requires the current host worker.</Empty>}
    </Panel>)}
    {!hosts.isPending && !hosts.data?.nodes.length && <Empty>No manageable computers reported.</Empty>}
  </div>;
};
