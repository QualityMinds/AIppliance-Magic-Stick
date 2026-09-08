import {useQuery} from '@tanstack/react-query';
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {api} from '../api';
import {Button} from '../components';
import {FederatedSsoPage} from './FederatedSsoPage';
import {LicensePage} from './LicensePage';
import {SettingsPage} from './SettingsPage';
import {SystemPage} from './SystemPage';
import {UsersPage} from './UsersPage';

export type SystemSectionId = 'settings' | 'license' | 'users' | 'federated-sso' | 'status';

const sections: Array<{id: SystemSectionId; label: string; admin?: boolean; identity?: boolean; entitlement?: string}> = [
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'license', label: 'License', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
  {id: 'federated-sso', label: 'Federated SSO', admin: true, identity: true, entitlement: 'federated-sso'},
  {id: 'status', label: 'System Status'},
];

export const allowedSystemSections = (session: Session) => sections.filter((section) => (
  (!section.admin || canAdminister(session))
  && (!section.identity || session.identityManagementAvailable !== false)
));

export const SystemAreaPage = ({session, section, onSectionChange}: {
  session: Session;
  section: SystemSectionId;
  onSectionChange: (section: SystemSectionId) => void;
}) => {
  const allowed = allowedSystemSections(session);
  const active = allowed.some((item) => item.id === section) ? section : 'status';
  const canViewFederation = canAdminister(session) && session.identityManagementAvailable !== false;
  const license = useQuery({queryKey: ['license'], queryFn: () => api.licenseStatus(), enabled: canViewFederation, refetchInterval: 30_000});
  const federationLicensed = license.data?.features.some((feature) => feature.id === 'federated-sso' && feature.licensed) === true;

  return <div className="stack">
    <div className="section-title"><div><h2>System</h2><p>Settings, licenses, users, federated identity and operational status in one place.</p></div></div>
    <div className="filter-bar" role="tablist" aria-label="System sections">
      {allowed.map((item) => {
        const disabled = item.entitlement === 'federated-sso' && !federationLicensed;
        return <Button
          key={item.id}
          type="button"
          role="tab"
          variant={active === item.id ? 'primary' : 'ghost'}
          aria-selected={active === item.id}
          aria-label={disabled ? `${item.label} (Enterprise license required)` : item.label}
          title={disabled ? 'A valid Federated SSO Enterprise entitlement is required.' : undefined}
          disabled={disabled}
          onClick={() => onSectionChange(item.id)}
        >{item.label}</Button>;
      })}
    </div>
    <div role="tabpanel" aria-label={allowed.find((item) => item.id === active)?.label}>
      {active === 'settings' && <SettingsPage />}
      {active === 'license' && <LicensePage />}
      {active === 'users' && <UsersPage />}
      {active === 'federated-sso' && <FederatedSsoPage />}
      {active === 'status' && <SystemPage />}
    </div>
  </div>;
};
