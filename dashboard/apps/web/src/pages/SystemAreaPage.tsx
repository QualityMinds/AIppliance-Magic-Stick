import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {Button} from '../components';
import {LicensePage} from './LicensePage';
import {SettingsPage, type SettingsSectionId} from './SettingsPage';
import {SystemPage} from './SystemPage';
import {UsersPage} from './UsersPage';
import {HardwarePage} from './HardwarePage';
import {HostPowerPanel} from './HostManagement';
import {ModelCachePage} from './ModelCachePage';

export type SystemSectionId = 'settings' | 'license' | 'users' | 'hardware' | 'status' | 'power' | 'model-cache';

const sections: Array<{id: SystemSectionId; label: string; admin?: boolean; identity?: boolean}> = [
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'license', label: 'License', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
  {id: 'hardware', label: 'Hardware'},
  {id: 'model-cache', label: 'Model cache', admin: true},
  {id: 'status', label: 'System Status'},
  {id: 'power', label: 'Computer power', admin: true},
];

export const isSystemSection = (value: string): value is SystemSectionId => sections.some((section) => section.id === value);

export const allowedSystemSections = (session: Session) => sections.filter((section) => (
  (!section.admin || canAdminister(session))
  && (!section.identity || session.identityManagementAvailable !== false)
));

export const SystemAreaPage = ({session, section, settingsSection, onSectionChange, onSettingsSectionChange}: {
  session: Session;
  section: SystemSectionId;
  settingsSection: SettingsSectionId;
  onSectionChange: (section: SystemSectionId) => void;
  onSettingsSectionChange: (section: SettingsSectionId) => void;
}) => {
  const allowed = allowedSystemSections(session);
  const active = allowed.some((item) => item.id === section) ? section : 'status';

  return <div className="stack">
    <div className="section-title"><h2>System</h2></div>
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
      {active === 'settings' && <SettingsPage session={session} section={settingsSection} onSectionChange={onSettingsSectionChange} />}
      {active === 'license' && <LicensePage />}
      {active === 'users' && <UsersPage />}
      {active === 'hardware' && <HardwarePage session={session} />}
      {active === 'status' && <SystemPage />}
      {active === 'power' && canAdminister(session) && <HostPowerPanel />}
      {active === 'model-cache' && canAdminister(session) && <ModelCachePage />}
    </div>
  </div>;
};
