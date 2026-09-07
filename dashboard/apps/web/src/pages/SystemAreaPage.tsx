import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {Button} from '../components';
import {LicensePage} from './LicensePage';
import {SettingsPage} from './SettingsPage';
import {SystemPage} from './SystemPage';
import {UsersPage} from './UsersPage';

export type SystemSectionId = 'settings' | 'license' | 'users' | 'status';

const sections: Array<{id: SystemSectionId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'license', label: 'License', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
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

  return <div className="stack">
    <div className="section-title"><div><h2>System</h2><p>Settings, licenses, users and operational status in one place.</p></div></div>
    <div className="filter-bar" role="tablist" aria-label="System sections">
      {allowed.map((item) => <Button
        key={item.id}
        type="button"
        role="tab"
        variant={active === item.id ? 'primary' : 'ghost'}
        aria-selected={active === item.id}
        onClick={() => onSectionChange(item.id)}
      >{item.label}</Button>)}
    </div>
    <div role="tabpanel" aria-label={allowed.find((item) => item.id === active)?.label}>
      {active === 'settings' && <SettingsPage />}
      {active === 'license' && <LicensePage />}
      {active === 'users' && <UsersPage />}
      {active === 'status' && <SystemPage />}
    </div>
  </div>;
};
