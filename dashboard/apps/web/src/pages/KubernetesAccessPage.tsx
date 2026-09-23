import {useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {KubernetesAccessUser} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, Dialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';

const levels = ['none', 'viewer', 'operator', 'admin'];
const labels: Record<string, string> = {none: 'No access', viewer: 'Viewer', operator: 'Operator', admin: 'Cluster Administrator'};
const notes: Record<string, string> = {
  none: 'Existing direct Kubernetes group membership is removed.',
  viewer: 'Viewer can inspect cluster resources but cannot read Kubernetes Secrets or make changes.',
  operator: 'Operator can read the cluster and manage Magic Stick modules, models, and instances. It cannot create arbitrary workloads or read Secrets.',
  admin: 'Warning: Cluster Administrator grants unrestricted control over workloads, RBAC, Secrets, and the appliance itself.',
};

const download = (filename: string, content: string) => {
  const url = URL.createObjectURL(new Blob([content], {type: 'application/yaml;charset=utf-8'}));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
};

const AccessDialog = ({user, onClose, onSaved}: {user?: KubernetesAccessUser; onClose: () => void; onSaved: (message: string) => Promise<void>}) => {
  const [level, setLevel] = useState(user?.accessLevel ?? 'none');
  const mutation = useMutation({mutationFn: () => api.updateKubernetesAccess(user!.id, level), onSuccess: async () => { await onSaved(`Kubernetes access for ${user?.username} updated to ${labels[level]}.`); onClose(); }});
  return <Dialog open={Boolean(user)} title={`Kubernetes access for ${user?.username ?? ''}`} description="Access is bound to this Keycloak identity and revoked by removing its direct group membership." onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Field label="Access level"><select value={level} onChange={(event) => setLevel(event.target.value)}>{levels.map((item) => <option key={item} value={item}>{labels[item]}</option>)}</select></Field><div className={`notice ${level === 'admin' ? 'notice-warn' : ''}`}>{notes[level]}</div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Save Access</Button></div></form></Dialog>;
};

export const KubernetesAccessPage = () => {
  const queryClient = useQueryClient(); const [search, setSearch] = useState(''); const [submittedSearch, setSubmittedSearch] = useState(''); const [message, setMessage] = useState(''); const [editUser, setEditUser] = useState<KubernetesAccessUser>(); const [busyUser, setBusyUser] = useState('');
  const query = useQuery({queryKey: ['kubernetes-access', submittedSearch], queryFn: () => api.kubernetesAccess(submittedSearch), refetchInterval: false});
  const refresh = async (nextMessage = '') => { await queryClient.invalidateQueries({queryKey: ['kubernetes-access']}); setMessage(nextMessage); };
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;
  const configuration = query.data.configuration ?? {}; const configured = configuration.configured === true;
  const configurationMessage = configured
    ? `SSO is active for ${String(configuration.apiServer || 'this cluster')}. Kubeconfigs use ${String(configuration.credentialPlugin || 'kubectl oidc-login')} and contain no token.`
    : 'Kubernetes SSO is not confirmed by this cluster. Access can be assigned, but kubeconfig export remains disabled until the API server publishes its OIDC configuration.';
  const exportKubeconfig = async (user: KubernetesAccessUser, mode: 'download' | 'copy') => {
    setBusyUser(user.id); setMessage('');
    try {
      const result = await api.kubeconfig(user.id);
      if (mode === 'download') { download(result.filename, result.content); setMessage(`Kubeconfig downloaded for ${user.username}. It contains no token or password.`); }
      else { await navigator.clipboard.writeText(result.content); setMessage(`Kubeconfig copied for ${user.username}. It contains no token or password.`); }
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : String(reason)); } finally { setBusyUser(''); }
  };
  return <div className="stack">
    <div className="section-title"><div><h2>Kubernetes Access</h2><p>Assign SSO-backed cluster roles and issue token-free OIDC kubeconfigs.</p></div><Button variant="ghost" onClick={() => query.refetch()}>Refresh</Button></div>
    <div className="access-level-grid"><article><strong>Viewer</strong><span>Read cluster resources. Kubernetes Secrets remain hidden.</span></article><article><strong>Operator</strong><span>Viewer access plus lifecycle control for Magic Stick modules, models, and instances.</span></article><article className="danger-card"><strong>Cluster Administrator</strong><span>Unrestricted cluster-admin access. Grant only when operationally necessary.</span></article></div>
    <div className={`notice ${configured ? 'notice-good' : 'notice-warn'}`} role="status">{configurationMessage}</div>
    <details className="details-panel"><summary><span><strong>OIDC configuration</strong><small>{configured ? 'Configured' : 'Not confirmed'}</small></span><span>Show</span></summary><pre className="json-preview details-content">{JSON.stringify(configuration, null, 2)}</pre></details>
    <form className="search-row" onSubmit={(event) => { event.preventDefault(); setSubmittedSearch(search.trim()); }}><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Username, name, or email" /><Button>Search</Button></form>
    {message && <div className={message.toLowerCase().includes('fail') || message.toLowerCase().includes('error') ? 'notice notice-error' : 'notice'} role="status">{message}</div>}
    <Panel title="Users" meta={`${query.data.total} eligible identit${query.data.total === 1 ? 'y' : 'ies'}`}>
      {query.data.users.length ? <div className="table-wrap"><table><thead><tr><th>User</th><th>Source</th><th>Status</th><th>Kubernetes Access</th><th>Actions</th></tr></thead><tbody>{query.data.users.map((user) => {
        const granted = (user.accessLevel ?? 'none') !== 'none'; const exportDisabled = !configured || !user.enabled || !granted || busyUser === user.id;
        return <tr key={user.id}><td><strong>{user.displayName || user.username}</strong><small>{user.username}{user.email ? ` · ${user.email}` : ''}</small></td><td>{user.provider ?? user.source ?? 'Local'}</td><td><StatusBadge phase={user.enabled ? 'Enabled' : 'Disabled'} /></td><td><StatusBadge phase={user.accessLevel === 'admin' ? 'Degraded' : granted ? 'Enabled' : 'Disabled'} /> <span>{labels[user.accessLevel ?? 'none']}</span></td><td><div className="actions"><Button variant="ghost" disabled={Boolean(user.protected) || (!user.enabled && !granted)} title={user.protected ? 'Protected recovery access cannot be changed.' : !user.enabled && !granted ? 'Enable the user before granting Kubernetes access.' : ''} onClick={() => setEditUser(user)}>Edit Access</Button><Button variant="primary" disabled={exportDisabled} title={!configured ? 'The Kubernetes API server has not confirmed OIDC.' : !user.enabled ? 'The user is disabled.' : !granted ? 'Grant access first.' : ''} onClick={() => exportKubeconfig(user, 'download')}>Download Kubeconfig</Button><Button variant="ghost" disabled={exportDisabled} onClick={() => exportKubeconfig(user, 'copy')}>Copy to Clipboard</Button></div></td></tr>;
      })}</tbody></table></div> : <Empty>No users match the current search.</Empty>}
    </Panel>
    <AccessDialog key={editUser?.id ?? 'kubernetes-access'} user={editUser} onClose={() => setEditUser(undefined)} onSaved={refresh} />
  </div>;
};
