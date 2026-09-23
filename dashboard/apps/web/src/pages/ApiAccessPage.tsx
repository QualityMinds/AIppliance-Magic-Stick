import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {ApiKeyItem} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';

type CreatedKey = {key: string; name: string; apiBase?: string};
const formatDate = (value?: string) => value ? new Date(value).toLocaleString() : 'Unknown';

export const ApiAccessPage = () => {
  const queryClient = useQueryClient(); const query = useQuery({queryKey: ['api-access'], queryFn: () => api.apiAccess(), refetchInterval: false});
  const [createOpen, setCreateOpen] = useState(false); const [name, setName] = useState(''); const [created, setCreated] = useState<CreatedKey>(); const [revoke, setRevoke] = useState<ApiKeyItem>(); const [message, setMessage] = useState('');
  const createMutation = useMutation({mutationFn: () => api.createApiKey(name), onSuccess: async (result) => {
    const preferred = result.apiBases?.find((base) => base.scope === 'local') ?? result.apiBases?.[0];
    setCreated({key: result.key, name, apiBase: preferred?.url}); setCreateOpen(false); setName('');
    await queryClient.invalidateQueries({queryKey: ['api-access']});
  }});
  const revokeMutation = useMutation({mutationFn: (id: string) => api.revokeApiKey(id), onSuccess: async () => { setMessage(`${revoke?.name ?? 'API key'} revoked.`); setRevoke(undefined); await queryClient.invalidateQueries({queryKey: ['api-access']}); }});
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;
  return <div className="stack">
    <div className="section-title"><div><h2>API Access</h2><p>Create named LiteLLM virtual keys. Secret values are shown once.</p></div><div className="actions"><Button variant="ghost" onClick={() => query.refetch()}>Refresh</Button><Button variant="primary" onClick={() => setCreateOpen(true)}>Create API Key</Button></div></div>
    <Panel title="API bases"><div className="api-bases">{query.data.apiBases?.map((base) => <div className="api-base" key={base.url}><span>{base.scope ?? 'endpoint'} API base</span><code>{base.url}</code><CopyButton value={base.url} /></div>) ?? <Empty>No API endpoints available.</Empty>}</div></Panel>
    {message && <div className="notice notice-good" role="status">{message}</div>}
    <Panel title="Named keys" meta={`${query.data.total} key${query.data.total === 1 ? '' : 's'}`}>
      {query.data.items.length ? <div className="table-wrap"><table><thead><tr><th>Name</th><th>Key ID</th><th>Created</th><th>Status</th><th>Actions</th></tr></thead><tbody>{query.data.items.map((item) => { const active = String(item.status ?? 'active').toLowerCase() === 'active'; return <tr key={item.id}><td><strong>{item.name}</strong></td><td><code>{item.keyHint ?? 'Unavailable'}</code></td><td>{formatDate(item.createdAt)}</td><td><StatusBadge phase={active ? 'Active' : item.status} /></td><td><Button variant="danger" disabled={!active} onClick={() => setRevoke(item)}>Revoke</Button></td></tr>; })}</tbody></table></div> : <Empty>No API keys created by this dashboard.</Empty>}
    </Panel>
    <ErrorNotice error={revokeMutation.error} />
    <Dialog open={createOpen} title="Create API Key" description="Use a recognizable application or integration name." onClose={() => setCreateOpen(false)}><form className="stack" onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}><Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} placeholder="CI pipeline" required /></Field><ErrorNotice error={createMutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" disabled={createMutation.isPending}>Create Key</Button></div></form></Dialog>
    <Dialog open={Boolean(created)} title="API key created" description={`The key for ${created?.name ?? 'this access'} is ready. Copy it now; it cannot be recovered later.`} onClose={() => setCreated(undefined)}><div className="secret-once"><code>{created?.key}</code>{created?.key && <CopyButton value={created.key} label="Copy API key" />}{created?.apiBase && <div className="api-base"><span>API base</span><code>{created.apiBase}</code><CopyButton value={created.apiBase} /></div>}<div className="form-actions"><Button variant="primary" onClick={() => setCreated(undefined)}>Done</Button></div></div></Dialog>
    <ConfirmDialog key={revoke?.id ?? 'revoke'} open={Boolean(revoke)} title="Revoke API key" description={`Revoke ${revoke?.name ?? 'this API key'}? Applications using it lose access immediately.`} confirmLabel="Revoke" busy={revokeMutation.isPending} error={revokeMutation.error} onClose={() => setRevoke(undefined)} onConfirm={() => revoke && revokeMutation.mutate(revoke.id)} />
  </div>;
};
