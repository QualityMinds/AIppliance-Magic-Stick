import {useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import type {
  FederationInput,
  FederationMapping,
  FederationProvider,
  FederationValidation,
} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ConfirmDialog, CopyButton, Dialog, Empty, ErrorNotice, Field, Loading, Panel, StatusBadge} from '../components';

const newMapping = (): FederationMapping => ({source: 'groups', value: '', accessLevel: 'user'});

type Draft = Omit<FederationInput, 'mappings'> & {mappings: FederationMapping[]};

const initialDraft = (provider?: FederationProvider): Draft => ({
  alias: provider?.alias ?? '',
  displayName: provider?.displayName ?? '',
  protocol: provider?.protocol ?? 'oidc',
  metadataUrl: provider?.metadataUrl ?? '',
  clientId: provider?.clientId ?? '',
  clientSecret: '',
  scopes: provider?.scopes || 'openid profile email',
  enabled: provider?.enabled ?? true,
  trustEmail: provider?.trustEmail ?? false,
  mappings: provider?.mappings.length ? provider.mappings.map((item) => ({...item})) : [newMapping()],
  expectedRevision: provider?.revision ?? 'new',
});

const providerPayload = (draft: Draft): FederationInput => ({
  alias: draft.alias.trim(),
  displayName: draft.displayName.trim(),
  protocol: draft.protocol,
  metadataUrl: draft.metadataUrl.trim(),
  ...(draft.protocol === 'oidc' ? {
    clientId: draft.clientId?.trim(),
    clientSecret: draft.clientSecret,
    scopes: draft.scopes?.trim(),
  } : {}),
  enabled: draft.enabled,
  trustEmail: draft.protocol === 'oidc' && draft.trustEmail,
  mappings: draft.mappings.map((item) => ({...item, source: item.source.trim(), value: item.value.trim()})),
  expectedRevision: draft.expectedRevision,
});

const ProviderDialog = ({provider, open, onClose, onSaved}: {
  provider?: FederationProvider;
  open: boolean;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) => {
  const [draft, setDraft] = useState(() => initialDraft(provider));
  const [validation, setValidation] = useState<FederationValidation>();
  const [validatedSource, setValidatedSource] = useState('');
  const sourceKey = `${draft.protocol}:${draft.metadataUrl.trim()}`;
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({...current, [key]: value}));
    if (key === 'protocol' || key === 'metadataUrl') { setValidation(undefined); setValidatedSource(''); }
  };
  const validate = useMutation({
    mutationFn: () => api.validateFederation({protocol: draft.protocol, metadataUrl: draft.metadataUrl.trim()}),
    onSuccess: (value) => { setValidation(value); setValidatedSource(sourceKey); },
  });
  const save = useMutation({
    mutationFn: () => provider
      ? api.updateFederation(provider.alias, providerPayload(draft))
      : api.createFederation(providerPayload(draft)),
    onSuccess: async () => {
      await onSaved(`${draft.displayName || draft.alias} was ${provider ? 'updated' : 'created'}.`);
      onClose();
    },
  });
  const validMappings = draft.mappings.length > 0 && draft.mappings.every((item) => item.source.trim() && item.value.trim());
  const ready = validatedSource === sourceKey && Boolean(validation) && validMappings
    && Boolean(draft.alias.trim() && draft.displayName.trim())
    && (draft.protocol === 'saml' || Boolean(draft.clientId?.trim() && draft.clientSecret));
  const callback = validation ? 'Metadata verified. Review the discovered endpoints, then save.' : 'Validate metadata before saving.';
  return <Dialog open={open} title={provider ? `Edit ${provider.displayName}` : 'Add federated identity provider'} description="Configure an upstream OIDC or SAML provider. Local recovery login remains available." onClose={onClose}>
    <form className="stack" onSubmit={(event) => { event.preventDefault(); save.mutate(); }}>
      <div className="form-grid">
        <Field label="Protocol"><select value={draft.protocol} disabled={Boolean(provider)} onChange={(event) => update('protocol', event.target.value as Draft['protocol'])}><option value="oidc">OpenID Connect</option><option value="saml">SAML 2.0</option></select></Field>
        <Field label="Alias" hint="Lowercase DNS label; it becomes part of the callback URL."><input required value={draft.alias} disabled={Boolean(provider)} pattern="[a-z0-9]([-a-z0-9]*[a-z0-9])?" onChange={(event) => update('alias', event.target.value)} placeholder="company-login" /></Field>
        <Field label="Display name"><input required value={draft.displayName} onChange={(event) => update('displayName', event.target.value)} placeholder="Company SSO" /></Field>
        <Field label={draft.protocol === 'oidc' ? 'Discovery URL' : 'Metadata URL'}><input required type="url" value={draft.metadataUrl} onChange={(event) => update('metadataUrl', event.target.value)} placeholder={draft.protocol === 'oidc' ? 'https://id.example.com/.well-known/openid-configuration' : 'https://id.example.com/saml/metadata'} /></Field>
        {draft.protocol === 'oidc' && <>
          <Field label="Client ID"><input required value={draft.clientId} onChange={(event) => update('clientId', event.target.value)} autoComplete="off" /></Field>
          <Field label="Client secret" hint={provider ? 'Enter the secret again for every update. Existing secrets are never returned.' : 'Stored only in Keycloak and never returned by the dashboard API.'}><input required type="password" value={draft.clientSecret} onChange={(event) => update('clientSecret', event.target.value)} autoComplete="new-password" /></Field>
          <Field label="Scopes"><input required value={draft.scopes} onChange={(event) => update('scopes', event.target.value)} /></Field>
          <label className="check-field"><input type="checkbox" checked={draft.trustEmail} onChange={(event) => update('trustEmail', event.target.checked)} />Trust email verification from this provider</label>
        </>}
      </div>
      <div className="form-actions"><Button type="button" disabled={!draft.metadataUrl.trim() || validate.isPending} onClick={() => validate.mutate()}>Validate metadata</Button></div>
      <ErrorNotice error={validate.error} />
      <div className={`notice ${validation ? 'notice-good' : ''}`} role="status">{callback}</div>
      {validation && <dl className="facts">{Object.entries(validation.configuration).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}

      <fieldset className="sharing-fields"><legend>Group and claim mappings</legend>
        <p className="muted">Only an exact matching upstream claim or SAML attribute grants one fixed Magic Stick access level. Users with no match receive no Magic Stick role.</p>
        {draft.mappings.map((mapping, index) => <div className="federation-mapping" key={index}>
          <Field label={draft.protocol === 'oidc' ? 'Claim' : 'Attribute'}><input required value={mapping.source} onChange={(event) => update('mappings', draft.mappings.map((item, itemIndex) => itemIndex === index ? {...item, source: event.target.value} : item))} /></Field>
          <Field label="Exact value"><input required value={mapping.value} onChange={(event) => update('mappings', draft.mappings.map((item, itemIndex) => itemIndex === index ? {...item, value: event.target.value} : item))} placeholder="magicstick-users" /></Field>
          <Field label="Magic Stick access"><select value={mapping.accessLevel} onChange={(event) => update('mappings', draft.mappings.map((item, itemIndex) => itemIndex === index ? {...item, accessLevel: event.target.value as FederationMapping['accessLevel']} : item))}><option value="user">User</option><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Administrator</option></select></Field>
          <Button type="button" variant="ghost" disabled={draft.mappings.length === 1} onClick={() => update('mappings', draft.mappings.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>
        </div>)}
        <Button type="button" variant="ghost" disabled={draft.mappings.length >= 50} onClick={() => update('mappings', [...draft.mappings, newMapping()])}>Add mapping</Button>
      </fieldset>
      <label className="check-field"><input type="checkbox" checked={draft.enabled} onChange={(event) => update('enabled', event.target.checked)} />Enable this provider after a successful save</label>
      <p className="notice notice-warn">Administrator mappings grant powerful access. Keep at least one enabled local recovery administrator and test a non-administrator mapping first.</p>
      <ErrorNotice error={save.error} />
      <div className="form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.isPending}>Save provider</Button></div>
    </form>
  </Dialog>;
};

export const FederatedSsoPage = () => {
  const cache = useQueryClient();
  const query = useQuery({queryKey: ['federated-sso'], queryFn: () => api.federatedSso(), refetchInterval: 30_000});
  const [dialog, setDialog] = useState<{open: boolean; provider?: FederationProvider}>({open: false});
  const [remove, setRemove] = useState<FederationProvider>();
  const [message, setMessage] = useState('');
  const deletion = useMutation({mutationFn: () => api.deleteFederation(remove!.alias, remove!.revision), onSuccess: async () => { const name = remove!.displayName; setRemove(undefined); await refresh(`${name} was deleted.`); }});
  const refresh = async (nextMessage = '') => { await cache.invalidateQueries({queryKey: ['federated-sso']}); setMessage(nextMessage); };
  const callbackFor = useMemo(() => (alias: string) => query.data?.callbackUrl.replace('{alias}', alias) ?? '', [query.data?.callbackUrl]);
  if (query.isPending) return <Loading />;
  if (query.error || !query.data) return <ErrorNotice error={query.error ?? new Error('Federated SSO is unavailable.')} />;
  const {feature, providers} = query.data;
  const verificationUnavailable = ['storage_unavailable', 'trust_unavailable', 'verification_unavailable'].includes(feature.reason);
  return <div className="stack">
    <div className="section-title"><div><h2>Federated SSO</h2><p>Connect corporate OIDC and SAML identity providers and map their groups or claims to Magic Stick roles.</p></div><div className="actions"><Button variant="ghost" onClick={() => query.refetch()}>Refresh</Button><Button variant="primary" disabled={!feature.available} onClick={() => setDialog({open: true})}>Add provider</Button></div></div>
    <div className={`notice ${feature.available ? 'notice-good' : 'notice-warn'}`}>{feature.available ? 'Enterprise entitlement active. Dashboard-managed federation is available.' : verificationUnavailable ? 'License verification is currently unavailable. Managed providers are disabled fail closed; viewing and recovery deletion remain available.' : feature.licensed ? 'The entitlement is present, but the Enterprise implementation is unavailable.' : 'A valid Federated SSO Enterprise entitlement is required to add or change providers.'}</div>
    <Panel title="Sign-in boundary" meta="Keycloak remains the stable Magic Stick issuer">
      <div className="facts"><div><dt>Magic Stick issuer</dt><dd>{query.data.issuer}</dd></div><div><dt>Provider callback template</dt><dd><code>{query.data.callbackUrl}</code></dd></div></div>
      <p className="muted">Register the provider-specific callback URL upstream. Client secrets are stored in Keycloak, never returned to the browser, and must be entered again for an update.</p>
    </Panel>
    {message && <div className="notice notice-good" role="status">{message}</div>}
    <Panel title="Identity providers" meta={`${providers.length} dashboard-managed provider${providers.length === 1 ? '' : 's'}`}>
      {providers.length ? <div className="list">{providers.map((provider) => <article className="list-row" key={provider.alias}><div><div className="actions"><strong>{provider.displayName}</strong><StatusBadge phase={provider.enabled ? 'Enabled' : 'Disabled'} /><span className="tag">{provider.protocol.toUpperCase()}</span></div><p>{provider.metadataUrl}</p><p><code>{callbackFor(provider.alias)}</code></p><div className="tag-list"><span className="tag">Alias: {provider.alias}</span><span className="tag">{provider.mappings.length} mapping{provider.mappings.length === 1 ? '' : 's'}</span>{provider.protocol === 'oidc' && <span className="tag">Secret: {provider.secretConfigured ? 'configured' : 'missing'}</span>}</div></div><div className="actions"><CopyButton value={callbackFor(provider.alias)} label="Copy callback" /><Button variant="ghost" disabled={!feature.available} onClick={() => setDialog({open: true, provider})}>Edit</Button><Button variant="danger" onClick={() => setRemove(provider)}>Delete</Button></div></article>)}</div> : <Empty>No dashboard-managed identity providers are configured.</Empty>}
    </Panel>
    <Panel title="Recovery and enforcement"><p className="muted">The local Keycloak login stays available as a break-glass path. If the entitlement becomes invalid or expires, Magic Stick disables every dashboard-managed provider; it does not delete configuration or local users. Deletion remains available without a license for recovery.</p></Panel>
    <ProviderDialog key={`${dialog.provider?.alias ?? 'new'}-${dialog.open}`} open={dialog.open} provider={dialog.provider} onClose={() => setDialog({open: false})} onSaved={refresh} />
    <ConfirmDialog open={Boolean(remove)} title={`Delete ${remove?.displayName ?? 'provider'}?`} description="This removes the provider and its dashboard-managed mappings from Keycloak. Existing local accounts remain." confirmLabel="Delete provider" expectedValue={remove?.alias} busy={deletion.isPending} error={deletion.error} onClose={() => setRemove(undefined)} onConfirm={() => deletion.mutate()} />
  </div>;
};
