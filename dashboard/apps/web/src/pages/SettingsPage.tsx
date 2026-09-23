import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button, ErrorNotice, Field, Loading, Panel} from '../components';
import {MeshPage} from './MeshPage';
import {FederatedSsoPage} from './FederatedSsoPage';
import {NetworkPage} from './NetworkPage';
import {UpdatesPage} from './UpdatesPage';

export type SettingsSectionId = 'domains' | 'mesh' | 'federated-sso' | 'network' | 'updates';

const sections: Array<{id: SettingsSectionId; label: string; identity?: boolean; entitlement?: string}> = [
  {id: 'domains', label: 'Domains'},
  {id: 'mesh', label: 'Mesh'},
  {id: 'federated-sso', label: 'Federated SSO', identity: true, entitlement: 'federated-sso'},
  {id: 'network', label: 'Network'},
  {id: 'updates', label: 'Updates'},
];

export const isSettingsSection = (value: string): value is SettingsSectionId => sections.some((section) => section.id === value);
export const allowedSettingsSections = (session: Session) => sections.filter((section) => (
  canAdminister(session) && (!section.identity || session.identityManagementAvailable !== false)
));

export const SettingsPage = ({session, section, onSectionChange}: {
  session: Session;
  section: SettingsSectionId;
  onSectionChange: (section: SettingsSectionId) => void;
}) => {
  const allowed = allowedSettingsSections(session);
  const active = allowed.some((item) => item.id === section) ? section : 'domains';
  const canViewFederation = allowed.some((item) => item.id === 'federated-sso');
  const license = useQuery({queryKey: ['license'], queryFn: () => api.licenseStatus(), enabled: canViewFederation, refetchInterval: 30_000});
  const federationLicensed = license.data?.features.some((feature) => feature.id === 'federated-sso' && feature.licensed) === true;
  if (!allowed.length) return null;

  return <div className="stack">
    <h2>Settings</h2>
    <div className="filter-bar" role="tablist" aria-label="Settings sections">
      {allowed.map((item) => {
        const disabled = item.entitlement === 'federated-sso' && !federationLicensed;
        return <Button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          variant={active === item.id ? 'primary' : 'ghost'}
          aria-label={disabled ? `${item.label} (registration or commercial license required)` : item.label}
          title={disabled ? 'A valid Free Registered or Commercial Federated SSO entitlement is required.' : undefined}
          disabled={disabled}
          onClick={() => onSectionChange(item.id)}
        >{item.label}</Button>;
      })}
    </div>
    <div role="tabpanel" aria-label={active === 'mesh' ? 'Mesh' : allowed.find((item) => item.id === active)?.label}>
      {active === 'domains' && <DomainSettings />}
      {active === 'mesh' && <MeshPage />}
      {active === 'federated-sso' && <FederatedSsoPage />}
      {active === 'network' && <NetworkPage />}
      {active === 'updates' && <UpdatesPage />}
    </div>
  </div>;
};

const DomainSettings = () => {
  const queryClient = useQueryClient();
  const query = useQuery({queryKey: ['settings'], queryFn: () => api.settings()});
  const [publicDomain, setPublicDomain] = useState('');
  const [mdnsDomain, setMdnsDomain] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (query.data) {
      setPublicDomain(query.data.publicDomain);
      setMdnsDomain(query.data.mdnsDomain);
    }
  }, [query.data]);
  const mutation = useMutation({
    mutationFn: () => api.updateSettings({publicDomain, mdnsDomain}),
    onSuccess: async () => {
      setMessage('Domain settings saved.');
      await queryClient.invalidateQueries({queryKey: ['settings']});
    },
  });
  if (query.error) return <ErrorNotice error={query.error} />;
  if (query.isPending) return <Loading />;

  return (
    <div className="stack">
      <Panel title="Domains">
        <form className="form-grid" onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}>
          <Field label="Public Domain"><input value={publicDomain} onChange={(event) => setPublicDomain(event.target.value)} placeholder="magicstick.example.com" /></Field>
          <Field label="mDNS Domain"><input value={mdnsDomain} onChange={(event) => setMdnsDomain(event.target.value)} placeholder="magicstick.local" required /></Field>
          <div className="form-actions full"><Button variant="primary" disabled={mutation.isPending}>Save Domains</Button></div>
        </form>
        <ErrorNotice error={mutation.error} />
        {message && <div className="notice notice-good">{message}</div>}
      </Panel>
    </div>
  );
};
