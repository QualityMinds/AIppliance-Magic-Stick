import {useEffect, useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import type {ManagedHost, NetworkInterface, NetworkSettings} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';
import {useHosts} from './HostManagement';

const terminal = new Set(['Succeeded', 'PreparedUnverified', 'Failed', 'Rejected', 'Interrupted', 'RolledBack']);
const busy = (host: ManagedHost) => Boolean(host.operation && !terminal.has(host.operation.phase));
const identity = (host: ManagedHost, action: 'configure-network' | 'scan-wifi', network: NetworkSettings) => ({
  action, nodeName: host.name, nodeUid: host.nodeUid, bootId: host.bootId,
  requestId: crypto.randomUUID().replaceAll('-', ''), planId: host.network?.id,
  confirmation: host.name, acknowledgeDisruption: true, allowExperimental: false, experimentMode: false, network,
});

const NetworkTrial = ({host}: {host: ManagedHost}) => {
  const client = useQueryClient();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer);}, []);
  const operation = host.operation;
  const confirmation = useMutation({mutationFn: () => api.confirmHostNetwork({nodeUid: host.nodeUid, requestId: operation!.requestId, confirmation: host.name}),
    retry: false, onSuccess: () => client.invalidateQueries({queryKey: ['host-management']})});
  if (!operation || !['configure-network', 'scan-wifi'].includes(operation.action)) return null;
  const remaining = operation.confirmationDeadline ? Math.max(0, Math.ceil((Date.parse(operation.confirmationDeadline) - now) / 1000)) : 0;
  return <div className={`notice ${terminal.has(operation.phase) ? '' : 'notice-warn'}`} role="status">
    <div className="section-title"><strong>{operation.action === 'scan-wifi' ? 'Wi-Fi scan' : 'Network change'} · {operation.phase}</strong><InfoPopover label={`Network operation on ${host.name}`}><p className="memory-info-note">{operation.message}</p></InfoPopover></div>
    {operation.phase === 'AwaitingConfirmation' && <><p>Check that the connection works. Automatic rollback in {remaining} seconds unless confirmed.</p>
      <Button disabled={!remaining || confirmation.isPending || confirmation.isSuccess} onClick={() => confirmation.mutate()}>Keep this network configuration</Button>
      {confirmation.isSuccess && <p>Confirmation sent. Waiting for the host to save the configuration.</p>}</>}
    <ErrorNotice error={confirmation.error} />
  </div>;
};

const NetworkEditor = ({host, device, disabled, onClose}: {host: ManagedHost; device: NetworkInterface; disabled: boolean; onClose: () => void}) => {
  const client = useQueryClient();
  const [mode, setMode] = useState<'dhcp' | 'static'>(device.configuredMode ?? 'dhcp');
  const [address, setAddress] = useState(device.configuredAddress ?? '');
  const [gateway, setGateway] = useState(device.configuredGateway ?? '');
  const [dns, setDns] = useState(device.dns?.join(', ') ?? '');
  const [metric, setMetric] = useState(String(device.metric ?? (device.kind === 'wifi' ? 600 : 100)));
  const [ssid, setSsid] = useState(device.configuredSsid ?? '');
  const [security, setSecurity] = useState<'open' | 'wpa-psk'>(device.security ?? 'wpa-psk');
  const [password, setPassword] = useState('');
  const [hidden, setHidden] = useState(device.hidden ?? false);
  const [review, setReview] = useState(false);
  const settings = (): NetworkSettings => ({interface: device.name, mode, ...(mode === 'static' ? {address, gateway} : {}),
    dns: dns.split(/[\s,]+/).filter(Boolean), metric: Number(metric),
    ...(device.kind === 'wifi' ? {ssid, security, password: security === 'open' ? '' : password, hidden} : {}),
  });
  const mutation = useMutation({mutationFn: () => api.requestHostOperation(identity(host, 'configure-network', settings())), retry: false,
    onSuccess: async () => {setReview(false); await client.invalidateQueries({queryKey: ['host-management']}); onClose();},
    onSettled: () => setPassword(''),
  });
  const scan = host.network?.scan;
  const networks = scan?.interface === device.name ? scan.networks : [];
  const description = `${host.name} · ${device.name}: ${mode === 'dhcp' ? 'DHCP' : address}, route metric ${metric}${device.kind === 'wifi' ? `, Wi-Fi ${ssid} (${security})` : ''}. Network access and running services may be interrupted. The host restores the previous Netplan configuration if you do not confirm the working connection within 3 minutes. Keep local console access available. This does not migrate the Kubernetes management address.${device.kind === 'wifi' && security === 'open' ? ' This Wi-Fi network is unencrypted.' : ''}`;
  return <form className="stack" aria-label={`Configure ${device.name}`} onSubmit={(event) => {event.preventDefault(); setReview(true);}}>
    <fieldset disabled={disabled || mutation.isPending} className="stack">
      <div className="form-grid">
        {device.kind === 'wifi' && <>
          <Field label="Wi-Fi network (SSID)"><input value={ssid} maxLength={32} required onChange={(event) => setSsid(event.target.value)} list={`networks-${device.name}`} /><datalist id={`networks-${device.name}`}>{networks.map((network) => <option key={network.ssid} value={network.ssid}>{network.signal ?? '?'} dBm · {network.security}</option>)}</datalist></Field>
          <Field label="Wi-Fi security"><select value={security} onChange={(event) => setSecurity(event.target.value as typeof security)}><option value="wpa-psk">WPA personal</option><option value="open">Open (unencrypted)</option></select></Field>
          {security === 'wpa-psk' && <Field label="Wi-Fi password"><input type="password" autoComplete="new-password" value={password} maxLength={64} required={!device.hasPassword || ssid !== device.configuredSsid} placeholder={device.hasPassword && ssid === device.configuredSsid ? 'Leave empty to keep saved password' : ''} onChange={(event) => setPassword(event.target.value)} /></Field>}
          <label className="check-field"><input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} /> Hidden network</label>
        </>}
        <Field label="IPv4 configuration"><select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="dhcp">Automatic (DHCP)</option><option value="static">Static IPv4</option></select></Field>
        <Field label="Route metric"><input type="number" min={1} max={65535} required value={metric} onChange={(event) => setMetric(event.target.value)} /></Field>
        {mode === 'static' && <><Field label="IPv4 address / prefix"><input required placeholder="198.51.100.10/24" value={address} onChange={(event) => setAddress(event.target.value)} /></Field><Field label="IPv4 gateway"><input placeholder="198.51.100.1" value={gateway} onChange={(event) => setGateway(event.target.value)} /></Field></>}
        <Field label="DNS servers"><input value={dns} placeholder="Automatic with DHCP; comma separated" onChange={(event) => setDns(event.target.value)} /></Field>
      </div>
      <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit">Review network change</Button></div>
    </fieldset>
    <ConfirmDialog open={review} title="Apply network trial" description={description} expectedValue={host.name} confirmLabel="Apply temporarily" busy={mutation.isPending} error={mutation.error} onClose={() => setReview(false)} onConfirm={() => {if (!disabled) mutation.mutate();}} />
  </form>;
};

const InterfaceCard = ({host, device, stale}: {host: ManagedHost; device: NetworkInterface; stale: boolean}) => {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const disabled = stale || !host.available || busy(host) || !host.network?.supported;
  const scan = useMutation({mutationFn: () => api.requestHostOperation(identity(host, 'scan-wifi', {interface: device.name})), retry: false,
    onSuccess: () => client.invalidateQueries({queryKey: ['host-management']})});
  const results = host.network?.scan;
  return <article className="operator-card stack compact" aria-label={`${device.kind === 'wifi' ? 'Wi-Fi' : 'Ethernet'} ${device.name}`}>
    <header><div className="inline-info"><strong>{device.kind === 'wifi' ? 'Wi-Fi' : 'Ethernet'} · {device.name}</strong><InfoPopover label={`Network interface ${device.name}`}><p className="memory-info-note">Lower route metrics are preferred. Only this interface's IPv4 and Wi-Fi settings are edited; IPv6 and the current backend are retained. Complex topologies require the local console. {device.clusterAddresses.length > 0 && 'This interface carries the Kubernetes management address; address migration and switching its SSID are blocked.'} {device.kind === 'wifi' && 'The selected SSID replaces this interface’s configured access-point list. Enterprise Wi-Fi authentication requires local configuration.'}</p></InfoPopover></div><StatusBadge phase={device.state === 'UP' ? 'Ready' : device.state} /></header>
    <dl className="facts"><div><dt>Addresses</dt><dd>{device.addresses.join(', ') || 'No address'}</dd></div><div><dt>MAC address</dt><dd>{device.mac}</dd></div><div><dt>IPv4</dt><dd>{device.configuredMode === 'static' ? 'Static' : 'DHCP'} · Metric {device.metric ?? '—'}</dd></div><div><dt>Gateway</dt><dd>{device.gateway || '—'}</dd></div>{device.kind === 'wifi' && <><div><dt>Connected Wi-Fi</dt><dd>{device.connectedSsid || 'Not connected'}</dd></div><div><dt>Configured Wi-Fi</dt><dd>{device.configuredSsid || 'Not configured'}</dd></div></>}</dl>
    <div className="form-actions">{device.kind === 'wifi' && <Button variant="ghost" disabled={disabled || !device.scanSupported || scan.isPending} onClick={() => scan.mutate()}>Scan Wi-Fi</Button>}<Button disabled={disabled || !device.editable} onClick={() => setEditing(!editing)}>{editing ? 'Close configuration' : 'Configure'}</Button></div>
    <ErrorNotice error={scan.error} />
    {device.kind === 'wifi' && results?.interface === device.name && <details><summary>{results.networks.length} Wi-Fi networks · {new Date(results.observedAt).toLocaleTimeString()}</summary><div className="list">{results.networks.map((network) => <div className="list-row" key={network.ssid}><span>{network.ssid}</span><span>{network.signal ?? '?'} dBm · {network.security}</span></div>)}</div></details>}
    {editing && <NetworkEditor key={`${host.bootId}:${host.network?.id}`} host={host} device={device} disabled={disabled} onClose={() => setEditing(false)} />}
  </article>;
};

export const NetworkPage = () => {
  const hosts = useHosts();
  return <div className="stack"><div className="section-title"><div className="inline-info"><h2>Network</h2><InfoPopover label="Network configuration"><p className="memory-info-note">Ethernet and Wi-Fi use Ubuntu's existing Netplan backend. Changes require exact-host confirmation and a second confirmation after applying. Passwords are never returned by the API. A local rollback service does not depend on dashboard connectivity; retain console access for recovery.</p></InfoPopover></div><Button variant="ghost" onClick={() => hosts.refetch()}>Refresh network</Button></div>
    <ErrorNotice error={hosts.error} />{hosts.isPending && <Loading />}
    {hosts.data?.nodes.map((host) => <Panel key={host.nodeUid} title={host.name}><NetworkTrial host={host} />
      {!host.network?.supported && <Empty>{host.network?.message ?? 'Network management requires the updated host worker.'}</Empty>}
      <div className="stack">{host.network?.interfaces.map((device) => <InterfaceCard key={device.name} host={host} device={device} stale={Boolean(hosts.error)} />)}</div>
      {host.network?.supported && !host.network.interfaces.length && <Empty>No physical Ethernet or Wi-Fi interfaces detected.</Empty>}
    </Panel>)}
    {!hosts.isPending && !hosts.data?.nodes.length && <Empty>No manageable computers reported.</Empty>}
  </div>;
};
