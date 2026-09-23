import {useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {User} from '@magicstick/dashboard-contracts';
import {titleFromKey} from '@magicstick/dashboard-core';
import {api} from '../api';
import {Button, Dialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';

const levels = ['user', 'viewer', 'operator', 'admin'];
const sourceName = (user: User) => {
  if (typeof user.source === 'object' && user.source) {
    const source = user.source as Record<string, unknown>;
    return String(source.displayName ?? source.provider ?? source.alias ?? source.type ?? 'External');
  }
  return String(user.provider ?? user.source ?? 'Local');
};
const isLocal = (user: User) => user.local ?? ['local', 'keycloak', 'internal'].includes(sourceName(user).toLowerCase());
const formatDate = (value?: string | number) => {
  if (value === undefined || value === null || value === '') return 'Unknown';
  const numeric = Number(value); const date = Number.isFinite(numeric) ? new Date(numeric < 100000000000 ? numeric * 1000 : numeric) : new Date(String(value));
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
};

const UserDialog = ({open, user, onClose, onSaved}: {open: boolean; user?: User; onClose: () => void; onSaved: (message: string) => Promise<void>}) => {
  const [username, setUsername] = useState(user?.username ?? ''); const [firstName, setFirstName] = useState(user?.firstName ?? ''); const [lastName, setLastName] = useState(user?.lastName ?? ''); const [email, setEmail] = useState(user?.email ?? '');
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState(''); const [accessLevel, setAccessLevel] = useState(user?.accessLevel ?? 'user'); const [enabled, setEnabled] = useState(true);
  const mutation = useMutation({mutationFn: async () => {
    if (!user && password !== confirmation) throw new Error('The password confirmation does not match.');
    if (user) return api.updateUser(user.id, {firstName, lastName, email});
    return api.createUser({username, firstName, lastName, email, password, enabled, accessLevel});
  }, onSuccess: async () => { setPassword(''); setConfirmation(''); await onSaved(user ? `${user.username} updated.` : `${username} created.`); onClose(); }});
  const local = !user || isLocal(user);
  return <Dialog open={open} title={user ? `Edit ${user.username}` : 'Create User'} description={user ? (local ? 'Edit this locally managed profile.' : 'This profile is managed by the external identity provider.') : 'Create a local Keycloak user for this appliance.'} onClose={onClose}>
    <form className="form-grid" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
      <Field label="Username"><input value={username} disabled={Boolean(user)} onChange={(event) => setUsername(event.target.value)} required maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._@+\-]{0,127}" /></Field>
      <Field label="First name"><input value={firstName} disabled={Boolean(user && !local)} onChange={(event) => setFirstName(event.target.value)} maxLength={128} /></Field>
      <Field label="Last name"><input value={lastName} disabled={Boolean(user && !local)} onChange={(event) => setLastName(event.target.value)} maxLength={128} /></Field>
      <Field label="Email"><input type="email" value={email} disabled={Boolean(user && !local)} onChange={(event) => setEmail(event.target.value)} required maxLength={254} /></Field>
      {!user && <><Field label="Access level"><select value={accessLevel} onChange={(event) => setAccessLevel(event.target.value)}>{levels.map((level) => <option key={level} value={level}>{titleFromKey(level)}</option>)}</select></Field><Field label="Temporary password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} required autoComplete="new-password" /></Field><Field label="Confirm temporary password"><input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} minLength={12} required autoComplete="new-password" /></Field><label className="check-field full"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> Enable the account after creation</label></>}
      <ErrorNotice error={mutation.error} />
      <div className="form-actions full"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending || Boolean(user && !local)}>{user ? 'Save User' : 'Create User'}</Button></div>
    </form>
  </Dialog>;
};

const AccessDialog = ({user, onClose, onSaved}: {user?: User; onClose: () => void; onSaved: (message: string) => Promise<void>}) => {
  const [level, setLevel] = useState(user?.accessLevel ?? 'user');
  const mutation = useMutation({mutationFn: () => api.updateUserRoles(user!.id, level), onSuccess: async () => { await onSaved(`${user?.username} access updated to ${titleFromKey(level)}.`); onClose(); }});
  return <Dialog open={Boolean(user)} title={`Change access for ${user?.username ?? ''}`} description="Only direct Magic Stick roles are replaced. Unmanaged and inherited roles remain." onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><Field label="Access level"><select value={level} onChange={(event) => setLevel(event.target.value)}>{levels.map((item) => <option key={item} value={item}>{titleFromKey(item)}</option>)}</select></Field><div className="notice">Direct roles: {(user?.directRoles ?? []).join(', ') || 'none'}<br />Effective roles: {(user?.effectiveRoles ?? []).join(', ') || 'none'}</div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Save Access</Button></div></form></Dialog>;
};

const PasswordDialog = ({user, onClose, onSaved}: {user?: User; onClose: () => void; onSaved: (message: string) => Promise<void>}) => {
  const [password, setPassword] = useState(''); const [confirmation, setConfirmation] = useState('');
  const mutation = useMutation({mutationFn: () => { if (password !== confirmation) throw new Error('The password confirmation does not match.'); return api.resetUserPassword(user!.id, password, true); }, onSuccess: async () => { setPassword(''); setConfirmation(''); await onSaved(`Temporary password set for ${user?.username}.`); onClose(); }});
  return <Dialog open={Boolean(user)} title={`Reset password for ${user?.username ?? ''}`} description="The temporary password must be changed at the next sign-in." onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}><div className="form-grid"><Field label="Temporary password"><input type="password" minLength={12} required value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" /></Field><Field label="Confirm temporary password"><input type="password" minLength={12} required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" /></Field></div><ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={mutation.isPending}>Set Temporary Password</Button></div></form></Dialog>;
};

type ConfirmAction = {user: User; action: 'enable' | 'disable' | 'delete'};
const ActionDialog = ({value, onClose, onSaved}: {value?: ConfirmAction; onClose: () => void; onSaved: (message: string) => Promise<void>}) => {
  const [confirmation, setConfirmation] = useState('');
  const mutation = useMutation({mutationFn: () => {
    if (!value) throw new Error('No user selected.');
    if (value.action === 'delete') { if (confirmation !== value.user.username) throw new Error('Enter the exact username to confirm deletion.'); return api.deleteUser(value.user.id, confirmation); }
    return api.setUserEnabled(value.user.id, value.action === 'enable');
  }, onSuccess: async () => { await onSaved(`${value?.user.username} ${value?.action === 'delete' ? 'deleted' : value?.action === 'enable' ? 'enabled' : 'disabled'}.`); onClose(); }});
  const destructive = value?.action !== 'enable';
  return <Dialog open={Boolean(value)} title={`${titleFromKey(value?.action ?? 'Confirm')} ${value?.user.username ?? ''}`} description={value?.action === 'delete' ? 'This local account is permanently deleted. Enter the username to confirm.' : `${titleFromKey(value?.action ?? '')} this Keycloak account and end its current sessions?`} onClose={onClose}><form className="stack" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>{value?.action === 'delete' && <Field label="Username confirmation"><input autoComplete="off" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>}<ErrorNotice error={mutation.error} /><div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant={destructive ? 'danger' : 'primary'} disabled={mutation.isPending || (value?.action === 'delete' && confirmation !== value.user.username)}>{titleFromKey(value?.action ?? 'Confirm')}</Button></div></form></Dialog>;
};

export const UsersPage = () => {
  const queryClient = useQueryClient(); const [search, setSearch] = useState(''); const [submittedSearch, setSubmittedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'disabled'>('all'); const [sourceFilter, setSourceFilter] = useState<'all' | 'local' | 'external'>('all');
  const [first, setFirst] = useState(0); const [pageSize, setPageSize] = useState(25); const [dialog, setDialog] = useState<{open: boolean; user?: User}>({open: false});
  const [accessUser, setAccessUser] = useState<User>(); const [passwordUser, setPasswordUser] = useState<User>(); const [confirmAction, setConfirmAction] = useState<ConfirmAction>(); const [message, setMessage] = useState('');
  const query = useQuery({queryKey: ['users', submittedSearch, first, pageSize], queryFn: () => api.users(submittedSearch, first, pageSize)});
  const refresh = async (nextMessage = '') => { await queryClient.invalidateQueries({queryKey: ['users']}); setMessage(nextMessage); };
  const visible = useMemo(() => (query.data?.users ?? []).filter((user) => (statusFilter === 'all' || (statusFilter === 'enabled' ? user.enabled !== false : user.enabled === false)) && (sourceFilter === 'all' || (sourceFilter === 'local' ? isLocal(user) : !isLocal(user)))), [query.data, sourceFilter, statusFilter]);
  if (query.error) return <ErrorNotice error={query.error} />; if (query.isPending || !query.data) return <Loading />;
  const end = first + query.data.users.length;
  return <div className="stack">
    <div className="section-title"><div><h2>Users</h2><p>Local and brokered Keycloak identities.</p></div><div className="actions"><Button variant="ghost" onClick={() => query.refetch()}>Refresh</Button><Button variant="primary" onClick={() => setDialog({open: true})}>Create User</Button></div></div>
    <form className="toolbar-grid" onSubmit={(event) => { event.preventDefault(); setFirst(0); setSubmittedSearch(search.trim()); }}><Field label="Search users"><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Username, name, or email" /></Field><Field label="Status"><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></Field><Field label="Source"><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value as typeof sourceFilter)}><option value="all">All</option><option value="local">Local</option><option value="external">External</option></select></Field><Button>Search</Button></form>
    {message && <div className="notice notice-good" role="status">{message}</div>}
    <Panel title="User overview" meta={`${query.data.total} user${query.data.total === 1 ? '' : 's'}`}><div className="table-wrap"><table><thead><tr><th>User</th><th>Email</th><th>Source</th><th>Status</th><th>Access</th><th>Created</th><th>Actions</th></tr></thead><tbody>{visible.map((user) => <tr key={user.id}><td><strong>{user.displayName || user.username}</strong><small>{user.username}</small></td><td>{user.email || 'Not set'}</td><td><strong>{sourceName(user)}</strong><small>{isLocal(user) ? 'Managed locally' : 'Profile and password managed upstream'}</small></td><td><StatusBadge phase={user.enabled === false ? 'Disabled' : 'Enabled'} /></td><td><strong>{titleFromKey(user.effectiveAccessLevel ?? user.accessLevel ?? 'user')}</strong><small>Direct: {(user.directRoles ?? []).join(', ') || 'none'}</small><small>Effective: {(user.effectiveRoles ?? []).join(', ') || 'none'}</small></td><td>{formatDate(user.createdAt ?? user.createdTimestamp)}</td><td><div className="actions"><Button variant="ghost" disabled={!user.capabilities?.canEditProfile} title={!user.capabilities?.canEditProfile ? (isLocal(user) ? 'This protected profile cannot be edited.' : 'Profile fields are managed upstream.') : ''} onClick={() => setDialog({open: true, user})}>Edit</Button><Button variant="ghost" disabled={!user.capabilities?.canManageRoles} title={!user.capabilities?.canManageRoles ? 'Your own or protected access cannot be changed.' : ''} onClick={() => setAccessUser(user)}>Access</Button><Button variant="ghost" disabled={user.enabled === false ? !user.capabilities?.canEnable : !user.capabilities?.canDisable} onClick={() => setConfirmAction({user, action: user.enabled === false ? 'enable' : 'disable'})}>{user.enabled === false ? 'Enable' : 'Disable'}</Button><Button variant="ghost" disabled={!user.capabilities?.canResetPassword} title={!user.capabilities?.canResetPassword ? (isLocal(user) ? 'Password reset is unavailable for this account.' : 'Reset the password at the external identity provider.') : ''} onClick={() => setPasswordUser(user)}>Reset Password</Button><Button variant="danger" disabled={!user.capabilities?.canDelete} title={!user.capabilities?.canDelete ? (isLocal(user) ? 'Self, recovery, and last-admin accounts cannot be deleted.' : 'External accounts must be disabled or removed upstream.') : ''} onClick={() => setConfirmAction({user, action: 'delete'})}>Delete</Button></div></td></tr>)}</tbody></table></div>{!visible.length && <Empty>No users match the current search and filters.</Empty>}
      <div className="pagination"><span>{query.data.users.length ? first + 1 : 0}–{end} of {query.data.total}{visible.length !== query.data.users.length ? `; ${visible.length} shown after filters` : ''}</span><div className="actions"><Field label="Per page"><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setFirst(0); }}><option value="10">10</option><option value="25">25</option><option value="50">50</option></select></Field><Button disabled={first === 0} onClick={() => setFirst(Math.max(0, first - pageSize))}>Previous</Button><Button disabled={end >= query.data.total || !query.data.users.length} onClick={() => setFirst(first + pageSize)}>Next</Button></div></div>
    </Panel>
    <UserDialog key={dialog.user?.id ?? `new-${dialog.open}`} open={dialog.open} user={dialog.user} onClose={() => setDialog({open: false})} onSaved={refresh} />
    <AccessDialog key={accessUser?.id ?? 'access'} user={accessUser} onClose={() => setAccessUser(undefined)} onSaved={refresh} />
    <PasswordDialog key={passwordUser?.id ?? 'password'} user={passwordUser} onClose={() => setPasswordUser(undefined)} onSaved={refresh} />
    <ActionDialog key={`${confirmAction?.user.id}-${confirmAction?.action}`} value={confirmAction} onClose={() => setConfirmAction(undefined)} onSaved={refresh} />
  </div>;
};
