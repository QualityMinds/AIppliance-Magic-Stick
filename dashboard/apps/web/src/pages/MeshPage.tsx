import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {MeshInvite, MeshRelay, MeshShare, MeshStatus} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';
import {InfoPopover} from '../InfoPopover';

const defaults: MeshShare = {enabled: false, maxConcurrent: 2, rpm: 10, tpm: 64000, maxContext: 32768, maxOutput: 2048, priority: 'low'};
const phases: Record<string, string> = {connected: 'Connected', disconnected: 'Disconnected', connecting: 'Connecting', relay: 'Relay connection',
  mesh_unavailable: 'Mesh unavailable', litellm_unavailable: 'LiteLLM unavailable', model_unavailable: 'Model unavailable',
  authentication_failed: 'Authentication failed', configuration_error: 'Configuration error'};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleString();
const typeLabel = (type: string) => type === 'client' ? 'Employee laptop' : 'Magic Stick';
const enabledShares = (status: MeshStatus) => Object.values(status.shares ?? {}).filter((item) => item.enabled).length;
const nodeNamePattern = '[a-z0-9](?:[a-z0-9\\-]{0,61}[a-z0-9])?';
const validNodeName = (name: string) => new RegExp(`^${nodeNamePattern}$`).test(name);

const RelayFields = ({value, onChange}: {value: MeshRelay; onChange: (value: MeshRelay) => void}) => <>
  <Field label="Relay mode"><select value={value.mode} onChange={(event) => onChange({mode: event.target.value as MeshRelay['mode'], url: value.url})}>
    <option value="auto">Auto</option><option value="public">Public relay</option><option value="custom">Custom relay</option>
  </select></Field>
  {value.mode === 'custom' && <Field label="Relay URL"><input type="url" value={value.url} required placeholder="https://relay.example.com" onChange={(event) => onChange({...value, url: event.target.value})} /></Field>}
  <div className="inline-info"><span>Direct connections preferred</span><InfoPopover label="Mesh relay"><p>Iroh uses a relay when a direct connection is unavailable. Auto and Public relay use the built-in public relay set. A relay never grants mesh membership. The creator's HTTPS address must remain reachable by every member for enrollment and authorization renewal; the inference relay does not forward this control connection.</p></InfoPopover></div>
</>;

const ShareEditor = ({name, saved, ready}: {name: string; saved?: MeshShare; ready: boolean}) => {
  const client = useQueryClient();
  const [draft, setDraft] = useState<MeshShare>(saved ?? defaults);
  const mutation = useMutation({mutationFn: () => draft.enabled ? api.meshCommand('share', {model: name, settings: draft}) : api.meshCommand('unshare', {model: name}),
    onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  const changed = JSON.stringify(draft) !== JSON.stringify(saved ?? defaults);
  return <details className="details-panel">
    <summary><strong>{name}</strong><span className="tag">{saved?.enabled ? 'Shared' : 'Local only'}</span></summary>
    <div className="details-content stack">
      <div className="inline-info"><span>{ready ? 'Available locally' : 'Local model unavailable'}</span><InfoPopover label={`Local availability of ${name}`}><p>Local availability is managed in Models. Sharing creates an alias for this same backend, without loading a second copy.</p></InfoPopover></div>
      <label className="checkbox-row"><input type="checkbox" checked={draft.enabled} disabled={!ready && !draft.enabled} onChange={(event) => setDraft({...draft, enabled: event.target.checked})} />Share with private mesh</label>
      {draft.enabled && <div className="form-grid">
        {([['maxConcurrent', 'Max concurrent requests', 64], ['rpm', 'Requests / minute', 10000], ['tpm', 'Tokens / minute', 10000000], ['maxContext', 'Max context budget', 1048576], ['maxOutput', 'Max output tokens', 131072]] as const).map(([key, label, max]) => <Field key={key} label={label}><input type="number" min={1} max={max} value={draft[key]} onChange={(event) => setDraft({...draft, [key]: Number(event.target.value)})} /></Field>)}
        <div className="inline-info"><span>Remote request limits</span><InfoPopover label={`Mesh limits for ${name}`}><p>All engines use separate concurrency/rate limits for remote requests. vLLM additionally uses a lower queue priority; Ollama and FreeToken do not receive vLLM-specific parameters. Active work is not preempted. Text context uses a conservative byte-based budget; media input is not supported.</p></InfoPopover></div>
      </div>}
      <ErrorNotice error={mutation.error} />
      <div className="form-actions"><Button disabled={!changed || mutation.isPending || (draft.enabled && !ready)} onClick={() => mutation.mutate()}>Save sharing</Button></div>
    </div>
  </details>;
};

const JoinMeshDialog = ({status, onClose, onJoined}: {status: MeshStatus; onClose: () => void; onJoined: () => void}) => {
  const client = useQueryClient();
  const [nodeName, setNodeName] = useState(status.node?.name ?? '');
  const [token, setToken] = useState('');
  const install = useMutation({mutationFn: () => api.enableModule('private-mesh'), onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  const leave = useMutation({mutationFn: () => api.meshCommand('leave'), onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  const join = useMutation({mutationFn: () => api.meshCommand('join', {token: token.trim(), nodeName}),
    onSuccess: async () => {setToken(''); onJoined(); await client.invalidateQueries({queryKey: ['mesh']});}});
  const valid = validNodeName(nodeName) && !!token.trim();
  return <Dialog open title="Join private mesh" onClose={onClose}>
    {status.configured ? <div className="stack">
      <p>This Magic Stick already belongs to <strong>{status.mesh?.name ?? 'a mesh'}</strong>. Leave it before joining another mesh.</p>
      <p>Mesh sharing and imported routes will stop. Your local models keep running.{status.authority && ' This node owns the mesh; other members will also lose access when their membership expires.'}</p>
      <ErrorNotice error={leave.error} />
      <div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button variant="danger" disabled={leave.isPending || leave.isSuccess} onClick={() => leave.mutate()}>{leave.isPending || leave.isSuccess ? 'Leaving…' : 'Leave current mesh'}</Button></div>
    </div> : !status.installed ? <div className="stack">
      <p>Enable Private Mesh on this appliance to join an existing mesh.</p>
      <ErrorNotice error={install.error} />
      <div className="form-actions"><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={install.isPending || install.isSuccess} onClick={() => install.mutate()}>{install.isPending || install.isSuccess ? 'Installing…' : 'Enable Private Mesh'}</Button></div>
    </div> : <form className="stack" onSubmit={(event) => {event.preventDefault(); if (valid && !join.isPending) join.mutate();}}>
      <div className="inline-info"><strong>Join with an invitation</strong><InfoPopover label="Mesh invitation"><p>On the mesh owner's dashboard, open System → Settings → Mesh → Invitations and create a Magic Stick invitation. Paste its single-use token here. An expired or already-used invitation must be replaced with a new one.</p></InfoPopover></div>
      <Field label="Node name"><input autoFocus value={nodeName} required maxLength={63} pattern={nodeNamePattern} disabled={join.isPending} onChange={(event) => setNodeName(event.target.value)} placeholder="magicstick-02" /></Field>
      <Field label="Invite token"><textarea autoComplete="off" spellCheck={false} value={token} required disabled={join.isPending} onChange={(event) => setToken(event.target.value.trim())} /></Field>
      <ErrorNotice error={join.error} />
      <div className="form-actions"><Button type="button" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={!valid || join.isPending}>{join.isPending ? 'Joining…' : 'Join mesh'}</Button></div>
    </form>}
  </Dialog>;
};

const Setup = ({status, onJoin}: {status: MeshStatus; onJoin: () => void}) => {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [meshName, setMeshName] = useState('');
  const [nodeName, setNodeName] = useState('');
  const [relay, setRelay] = useState<MeshRelay>({mode: 'auto', url: ''});
  const [selected, setSelected] = useState<string[]>([]);
  const install = useMutation({mutationFn: () => api.enableModule('private-mesh'), onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  const mutation = useMutation({mutationFn: () => api.meshCommand('create', {
    meshName, nodeName, relay, origin: window.location.origin, shares: Object.fromEntries(selected.map((name) => [name, {...defaults, enabled: true}])),
  }), onSuccess: async () => {setOpen(false); await client.invalidateQueries({queryKey: ['mesh']});}});
  const validNames = validNodeName(nodeName) && validNodeName(meshName);
  return <Panel title="Private Mesh" actions={<StatusBadge phase="Disconnected" />}>
    <div className="actions">{!status.installed ?
      <Button variant="primary" disabled={install.isPending || install.isSuccess} onClick={() => install.mutate()}>{install.isSuccess ? 'Installing…' : 'Enable Private Mesh'}</Button>
      : <Button variant="primary" onClick={() => {setOpen(true); setStep(0); mutation.reset();}}>Create Private Mesh</Button>}
      <Button onClick={onJoin}>Join Mesh</Button>
    </div>
    <ErrorNotice error={install.error} />
    <Dialog open={open} title="Create private mesh" onClose={() => setOpen(false)}>
      <form className="stack" onSubmit={(event) => {event.preventDefault(); if (!validNames || mutation.isPending) return; if (step < 2) setStep(step + 1); else mutation.mutate();}}>
        <div className="tag">Step {step + 1} of 3 · {['Name', 'Network', 'Model sharing'][step]}</div>
        {step === 0 && <>
          <Field label="Mesh name"><input autoFocus value={meshName} required maxLength={63} pattern={nodeNamePattern} onChange={(event) => setMeshName(event.target.value)} placeholder="company-mesh" /></Field>
          <Field label="Node name"><input value={nodeName} required maxLength={63} pattern={nodeNamePattern} onChange={(event) => setNodeName(event.target.value)} placeholder="magicstick-01" /></Field>
        </>}
        {step === 1 && <RelayFields value={relay} onChange={setRelay} />}
        {step === 2 && <>
          <strong>Share local models</strong>
          {(status.models ?? []).map((name) => <label className="checkbox-row" key={name}><input type="checkbox" checked={selected.includes(name)} onChange={(event) => setSelected(event.target.checked ? [...selected, name] : selected.filter((item) => item !== name))} />{name}</label>)}
          {!status.models?.length && <Empty>No local model is ready. You can share a model later.</Empty>}
        </>}
        <ErrorNotice error={mutation.error} />
        <div className="form-actions">{step > 0 && <Button type="button" onClick={() => setStep(step - 1)}>Back</Button>}
          <Button type="submit" variant="primary" disabled={mutation.isPending || !validNames}>{mutation.isPending ? 'Connecting…' : step === 2 ? 'Create mesh' : 'Next'}</Button></div>
      </form>
    </Dialog>
  </Panel>;
};

const Invitations = ({status}: {status: MeshStatus}) => {
  const client = useQueryClient();
  const [type, setType] = useState<'magic-stick' | 'client'>('magic-stick');
  const [lifetime, setLifetime] = useState(3600);
  const [invite, setInvite] = useState<MeshInvite | null>(null);
  const create = useMutation({mutationFn: () => api.meshCommand<MeshInvite>('invite', {type, lifetime}), onSuccess: async (value) => {setInvite(value); await client.invalidateQueries({queryKey: ['mesh']});}});
  const revoke = useMutation({mutationFn: (id: string) => api.meshCommand('revoke-invite', {id}), onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  return <Panel title="Invitations">
    <form className="form-grid" onSubmit={(event) => {event.preventDefault(); create.mutate();}}>
      <Field label="Node type"><select value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="magic-stick">Magic Stick</option><option value="client">Client / Employee laptop</option></select></Field>
      <Field label="Expires in"><select value={lifetime} onChange={(event) => setLifetime(Number(event.target.value))}><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={86400}>24 hours</option></select></Field>
      <div className="form-actions full"><Button type="submit" disabled={create.isPending}>Create invite</Button></div>
    </form>
    <ErrorNotice error={create.error ?? revoke.error} />
    <div className="stack">{status.invites?.map((item) => {
      const label = item.revoked ? 'Revoked' : item.usedAt ? 'Used' : item.expiresAt * 1000 <= Date.now() ? 'Expired' : 'Active';
      return <article className="model-card" key={item.id}><header><strong>{typeLabel(item.type)}</strong><StatusBadge phase={label} /></header>
        <span className="muted">{item.creator} · Expires {date(item.expiresAt)}</span>
        {label === 'Active' && <div className="form-actions"><Button disabled={revoke.isPending} onClick={() => revoke.mutate(item.id)}>Revoke</Button></div>}
      </article>;
    })}</div>
    <Dialog open={!!invite} title="Invitation created" onClose={() => setInvite(null)}>{invite?.token && <div className="stack">
      <Field label="One-time invite token"><textarea readOnly value={invite.token} spellCheck={false} /></Field>
      <span>{typeLabel(invite.type)} · Expires {date(invite.expiresAt)}</span>
      <div className="actions"><CopyButton value={invite.token} label="Copy invite" /><Button onClick={() => setInvite(null)}>Done</Button></div>
    </div>}</Dialog>
  </Panel>;
};

const Network = ({saved}: {saved: MeshRelay}) => {
  const client = useQueryClient();
  const [relay, setRelay] = useState(saved);
  const mutation = useMutation({mutationFn: () => api.meshCommand('relay', relay), onSuccess: () => client.invalidateQueries({queryKey: ['mesh']})});
  return <Panel title="Network"><form className="stack" onSubmit={(event) => {event.preventDefault(); mutation.mutate();}}><RelayFields value={relay} onChange={setRelay} />
    <ErrorNotice error={mutation.error} /><div className="form-actions"><Button disabled={mutation.isPending || JSON.stringify(relay) === JSON.stringify(saved)}>Save network</Button></div>
  </form></Panel>;
};

export const MeshPage = () => {
  const client = useQueryClient();
  const query = useQuery({queryKey: ['mesh'], queryFn: () => api.mesh(), refetchInterval: 5000});
  const [tab, setTab] = useState('overview');
  const [leave, setLeave] = useState(false);
  const [join, setJoin] = useState(false);
  const command = useMutation({mutationFn: ({action, id}: {action: 'leave' | 'sync' | 'revoke-node'; id?: string}) => api.meshCommand(action, {id}), onSuccess: async () => {setLeave(false); await client.invalidateQueries({queryKey: ['mesh']});}});
  if (query.isPending) return <Loading />;
  if (!query.data) return <div className="stack"><ErrorNotice error={query.error} /><Button onClick={() => query.refetch()}>Retry</Button></div>;
  const data = query.data;
  const tabs = ['overview', 'models', ...(data.authority ? ['invitations'] : []), 'network'];
  return <div className="stack">
    {!data.configured ? <Setup status={data} onJoin={() => setJoin(true)} /> : <>
    <div className="section-title"><div className="inline-info"><h2>Private Mesh</h2><InfoPopover label="Private mesh trust"><p>Only enrolled devices can connect. The creator manages membership; laptops can only consume models. If the creator is unreachable, membership expires after two minutes and new mesh requests stop.</p></InfoPopover></div><div className="actions"><StatusBadge phase={phases[data.phase] ?? data.phase} /><Button disabled={command.isPending} onClick={() => setJoin(true)}>Join Mesh</Button></div></div>
    <div className="filter-bar" role="tablist" aria-label="Mesh sections">{tabs.map((item) => <Button key={item} role="tab" aria-selected={tab === item} variant={tab === item ? 'primary' : 'ghost'} onClick={() => setTab(item)}>{item.charAt(0).toUpperCase() + item.slice(1)}</Button>)}</div>
    <ErrorNotice error={query.error ?? command.error} />
    {tab === 'overview' && <>
      <Panel title={data.mesh?.name} actions={<Button disabled={command.isPending} onClick={() => command.mutate({action: 'sync'})}>Sync now</Button>}>
        <dl className="facts"><div><dt>This node</dt><dd>{data.node?.name}</dd></div><div><dt>Node type</dt><dd>{typeLabel(data.node?.type ?? '')}</dd></div>
          <div><dt>Nodes online</dt><dd>{data.nodes?.filter((node) => node.online).length ?? 0}</dd></div><div><dt>Remote models</dt><dd>{data.imports?.length ?? 0}</dd></div>
          <div><dt>Shared models</dt><dd>{enabledShares(data)}</dd></div><div><dt>Connection</dt><dd>{!data.transport || data.transport === 'unknown' ? 'Not yet reported' : data.transport}</dd></div></dl>
        <div className="tags">{Object.entries(data.components ?? {}).map(([name, state]) => <span className="tag" key={name}>{({mesh: 'MeshLLM', litellm: 'LiteLLM', models: 'Local models', vllm: 'Local models', sync: 'Model Sync', export: 'Export'} as Record<string, string>)[name] ?? name} · {state.replaceAll('_', ' ')}</span>)}</div>
      </Panel>
      <Panel title="Nodes"><div className="stack">{data.nodes?.map((node) => <article key={node.id} className="model-card"><header><strong>{node.name}</strong><StatusBadge phase={node.revoked ? 'Revoked' : node.online ? 'Online' : 'Offline'} /></header><span>{typeLabel(node.type)}</span>
        {data.authority && node.id !== data.node?.id && !node.revoked && <div className="form-actions"><Button disabled={command.isPending} variant="danger" onClick={() => command.mutate({action: 'revoke-node', id: node.id})}>Revoke access</Button></div>}
      </article>)}</div></Panel>
      <details className="details-panel"><summary><strong>Activity</strong></summary><div className="details-content stack">
        <dl className="facts"><div><dt>Requests from mesh</dt><dd>{data.metrics?.incoming.requests ?? '—'}</dd></div><div><dt>Requests to mesh</dt><dd>{data.metrics?.outgoing.requests ?? '—'}</dd></div><div><dt>Active remote requests</dt><dd>{data.metrics?.incoming.active ?? '—'}</dd></div><div><dt>Remote errors</dt><dd>{data.metrics?.incoming.errors ?? '—'}</dd></div></dl>
        <div className="inline-info"><strong>Backend activity</strong><InfoPopover label="Mesh activity counters"><p>Counters reset when the component restarts. Backend attempts include retries and fallbacks, not only successful requests. No prompts or response contents are recorded.</p></InfoPopover></div>
        {!data.metrics?.backends ? <span className="muted">Local metrics unavailable</span> : data.metrics.backends.byModel.map((row) => <div className="model-card" key={`${row.traffic}:${row.model}`}><strong>{row.model}</strong><span>{row.traffic} · {row.requests} attempts · {row.errors} errors · {row.requests ? (row.latencySeconds / row.requests).toFixed(2) : '0'} s average</span></div>)}
        {data.metrics?.byPeerModel?.map((row) => <div className="model-card" key={`${row.peer}:${row.model}`}><strong>{row.model}</strong><span>{data.nodes?.find((node) => node.id === row.peer)?.name ?? 'Other peer'} · {row.requests} requests · {row.active} active · {row.errors} errors</span></div>)}
      </div></details>
      <div className="form-actions"><Button variant="danger" onClick={() => setLeave(true)}>Leave mesh</Button></div>
    </>}
    {tab === 'models' && <div className="stack">
      {data.node?.type === 'magic-stick' && <Panel title="Local model sharing"><div className="stack">{[...new Set([...(data.models ?? []), ...Object.keys(data.shares ?? {})])].map((name) => <ShareEditor key={name + JSON.stringify(data.shares?.[name])} name={name} saved={data.shares?.[name]} ready={data.models?.includes(name) ?? false} />)}
        {!data.models?.length && !Object.keys(data.shares ?? {}).length && <Empty>No local model is ready. Start a model in Models to share it.</Empty>}
      </div></Panel>}
      <Panel title="Models from your mesh">{data.imports?.length ? <div className="stack">{data.imports.map((name) => <div key={name} className="tag">{name}</div>)}</div> : <Empty>No remote models are available.</Empty>}</Panel>
    </div>}
    {tab === 'invitations' && data.authority && <Invitations status={data} />}
    {tab === 'network' && data.relay && <Network key={JSON.stringify(data.relay)} saved={data.relay} />}
    </>}
    {join && <JoinMeshDialog status={data} onClose={() => setJoin(false)} onJoined={() => {setJoin(false); setTab('overview');}} />}
    <Dialog open={leave} title="Leave private mesh?" onClose={() => setLeave(false)}><div className="stack"><p>Mesh sharing and imported routes will stop. Your local models keep running.{data.authority && ' This node owns the mesh; other members will also lose access when their membership expires.'}</p><div className="form-actions"><Button onClick={() => setLeave(false)}>Cancel</Button><Button variant="danger" disabled={command.isPending} onClick={() => command.mutate({action: 'leave'})}>Leave mesh</Button></div></div></Dialog>
  </div>;
};
