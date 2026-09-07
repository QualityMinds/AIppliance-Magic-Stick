import {useState} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import type {InstanceAccessState, InstanceSharing, SharingPrincipal} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, Dialog, ErrorNotice, Field, Loading} from '../components';

export const SharingFields = ({value, onChange, disabled = false, labels = {users: [], groups: []}}: {
  value: InstanceSharing; onChange: (value: InstanceSharing) => void; disabled?: boolean;
  labels?: {users: SharingPrincipal[]; groups: SharingPrincipal[]};
}) => {
  const [kind, setKind] = useState<'users' | 'groups'>('users');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [first, setFirst] = useState(0);
  const [names, setNames] = useState<Record<string, string>>({});
  const results = useQuery({queryKey: ['instance-principals', kind, query, first],
    queryFn: () => api.instancePrincipals(kind, query, first), enabled: value.mode === 'selected' && !disabled});
  const selected = value[kind] ?? [];
  const remove = (type: 'users' | 'groups', id: string) => onChange({...value, [type]: (value[type] ?? []).filter((item) => item !== id)});
  return <fieldset className="sharing-fields" disabled={disabled}><legend>Instance sharing · Enterprise</legend>
    <Field label="Visible and accessible to"><select aria-label="Visible and accessible to" value={value.mode} onChange={(event) => onChange(event.target.value === 'all' ? {mode: 'all', users: [], groups: []} : {mode: 'selected', users: [], groups: []})}>
      <option value="all">All users with the required role</option><option value="selected">Selected users or groups</option>
    </select></Field>
    {value.mode === 'selected' && <div className="stack compact">
      <p className="muted">Any selected user or member of a selected group may use this instance. Subgroups are included. The minimum role still applies.</p>
      <div className="form-grid">
        <Field label="Search directory"><select aria-label="Search directory" value={kind} onChange={(event) => {setKind(event.target.value as 'users' | 'groups'); setFirst(0);}}><option value="users">Users</option><option value="groups">Groups</option></select></Field>
        <Field label="User or group name"><input value={search} maxLength={128} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => {if (event.key === 'Enter') {event.preventDefault(); setQuery(search); setFirst(0);}}} /></Field>
      </div>
      <div className="actions"><Button type="button" onClick={() => {setQuery(search); setFirst(0);}}>Search</Button>
        <Button type="button" variant="ghost" disabled={!first || results.isFetching} onClick={() => setFirst(Math.max(0, first - 50))}>Previous</Button>
        <Button type="button" variant="ghost" disabled={results.data?.next == null || results.isFetching} onClick={() => setFirst(results.data?.next ?? first)}>Next</Button>
      </div>
      <ErrorNotice error={results.error} />
      {results.isFetching && <p className="muted">Loading directory…</p>}
      <div className="sharing-results" aria-label="Directory results">{results.data?.items.map((entry) => <Button key={entry.id} type="button" variant="ghost" disabled={selected.includes(entry.id) || selected.length >= 100} onClick={() => {
        setNames((current) => ({...current, [`${kind}:${entry.id}`]: entry.name}));
        onChange({...value, [kind]: [...selected, entry.id]});
      }}>{selected.includes(entry.id) ? '✓ ' : '+ '}{entry.name}</Button>)}
        {results.data && !results.data.items.length && <p className="muted">No matching entries. Groups are managed in Keycloak.</p>}
      </div>
      {(['users', 'groups'] as const).map((type) => <div key={type}><h4>Selected {type}</h4><div className="sharing-results">{(value[type] ?? []).map((id) => <Button key={id} type="button" variant="ghost" aria-label={`Remove ${type === 'users' ? 'user' : 'group'} ${names[`${type}:${id}`] ?? labels[type].find((item) => item.id === id)?.name ?? id}`} onClick={() => remove(type, id)}>
        {names[`${type}:${id}`] ?? labels[type].find((item) => item.id === id)?.name ?? id} ×
      </Button>)}</div></div>)}
      {!value.users?.length && !value.groups?.length && <p className="notice notice-warn">No one can use this instance until at least one user or group is selected.</p>}
    </div>}
  </fieldset>;
};

const SharingEditor = ({initial, onSaved, onClose}: {initial: InstanceAccessState; onSaved: () => Promise<void>; onClose: () => void}) => {
  const [sharing, setSharing] = useState(initial.sharing);
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useMutation({mutationFn: () => api.updateInstanceAccess(initial.name, sharing, initial.revision),
    onSuccess: async () => {await onSaved(); onClose();}});
  const enabled = initial.feature.available && initial.guardReady && initial.authentication === 'sso';
  return <form className="stack" onSubmit={(event) => {event.preventDefault(); if (confirmed && enabled) mutation.mutate();}}>
    <p>Administrators retain the management view. App access and instance credentials still require an explicit grant.</p>
    {!initial.feature.available && <p className="notice notice-warn">A valid license with Targeted access and the installed Enterprise extension is required. Existing restrictions are never removed automatically.</p>}
    {!initial.guardReady && <p className="notice notice-warn">The operator is still preparing the access guard. Wait for the instance to become ready.</p>}
    {initial.authentication !== 'sso' && <p className="notice notice-warn">Switch this instance to SSO before selecting users or groups.</p>}
    <SharingFields value={sharing} onChange={(value) => {setSharing(value); setConfirmed(false);}} disabled={!enabled || mutation.isPending} labels={initial.principals} />
    <label className="check-field"><input type="checkbox" checked={confirmed} disabled={!enabled || mutation.isPending} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm who will be able to see and use this instance.</label>
    <ErrorNotice error={mutation.error} />
    <div className="actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!enabled || !confirmed || mutation.isPending}>Save sharing</Button></div>
  </form>;
};

export const InstanceSharingDialog = ({name, onClose, onSaved}: {name: string; onClose: () => void; onSaved: () => Promise<void>}) => {
  const query = useQuery({queryKey: ['instance-access', name], queryFn: () => api.instanceAccess(name), refetchOnWindowFocus: false, refetchOnMount: 'always', refetchInterval: false, staleTime: 0});
  return <Dialog open title={`Sharing · ${name}`} description="Manage access to this instance." onClose={onClose}>
    {query.isFetching ? <Loading /> : query.error || !query.data ? <ErrorNotice error={query.error} /> : <SharingEditor key={`${name}-${query.data.revision}`} initial={query.data} onClose={onClose} onSaved={onSaved} />}
    {query.error && <Button type="button" onClick={() => void query.refetch()}>Retry</Button>}
  </Dialog>;
};
