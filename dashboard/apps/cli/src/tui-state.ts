// Navigation state of the terminal dashboard: the same pages, sections and
// visibility rules as the browser dashboard (apps/web/src/App.tsx and the System pages).
import {canAdminister} from '@magicstick/dashboard-core';
import type {Session} from '@magicstick/dashboard-contracts';
import {hasDashboardRole, type DashboardSnapshot} from './snapshot';
import type {Row} from './tui-screen';

export type PageId = 'overview' | 'models' | 'services' | 'api-access' | 'mesh' | 'kubernetes-access' | 'system' | 'my-instances';
export type SystemSectionId = 'settings' | 'license' | 'users' | 'hardware' | 'status' | 'power';
export type SettingsSectionId = 'domains' | 'federated-sso' | 'network' | 'updates' | 'console';
export type StatusSectionId = 'overview' | 'gpu-operators' | 'flux' | 'network' | 'model-cache' | 'regression';
export type MeshTabId = 'overview' | 'models' | 'invitations' | 'network';
export type ServiceFilter = 'all' | 'applications' | 'runtime' | 'platform';

export interface PageState {
  page: PageId;
  systemSection: SystemSectionId;
  settingsSection: SettingsSectionId;
  statusSection: StatusSectionId;
  meshTab: MeshTabId;
  serviceFilter: ServiceFilter;
  expanded: Record<string, boolean>;
  /** Per-page values that change what is loaded or shown: searches, filters, paging, selections. */
  ui: Record<string, string>;
}

/** A page-level shortcut shown in the hotkey bar; it triggers the same action as its button. */
export interface Hotkey {
  key: string;
  label: string;
  actionId: string;
}

export interface PageView {
  rows: Row[];
  hotkeys: Hotkey[];
  /** Repaint every second while shown, e.g. for a confirmation countdown. */
  tick?: boolean;
}

interface Entry<T> {id: T; label: string; admin?: boolean; identity?: boolean}

// Same pages, order and visibility rules as the browser dashboard.
export const PAGES: Array<Entry<PageId>> = [
  {id: 'overview', label: 'Overview'},
  {id: 'models', label: 'Models'},
  {id: 'services', label: 'Services'},
  {id: 'api-access', label: 'API Access', admin: true},
  {id: 'mesh', label: 'Mesh', admin: true},
  {id: 'kubernetes-access', label: 'Kubernetes Access', admin: true, identity: true},
  {id: 'system', label: 'System'},
];

export const SYSTEM_SECTIONS: Array<Entry<SystemSectionId>> = [
  {id: 'settings', label: 'Settings', admin: true},
  {id: 'license', label: 'License', admin: true},
  {id: 'users', label: 'Users', admin: true, identity: true},
  {id: 'hardware', label: 'Hardware'},
  {id: 'status', label: 'System Status'},
  {id: 'power', label: 'Computer power', admin: true},
];

export const SETTINGS_SECTIONS: Array<Entry<SettingsSectionId> & {entitlement?: string}> = [
  {id: 'domains', label: 'Domains'},
  {id: 'federated-sso', label: 'Federated SSO', identity: true, entitlement: 'federated-sso'},
  {id: 'network', label: 'Network'},
  {id: 'updates', label: 'Updates'},
  {id: 'console', label: 'Local console', identity: true},
];

export const STATUS_SECTIONS: Array<Entry<StatusSectionId>> = [
  {id: 'overview', label: 'Overview'},
  {id: 'gpu-operators', label: 'GPU Operators'},
  {id: 'flux', label: 'Flux'},
  {id: 'network', label: 'Network & routes'},
  {id: 'model-cache', label: 'Model cache', admin: true},
  {id: 'regression', label: 'Regression tests', admin: true},
];

export const SERVICE_FILTERS: Array<{id: ServiceFilter; label: string}> = [
  {id: 'all', label: 'All'}, {id: 'applications', label: 'Applications'},
  {id: 'runtime', label: 'AI Runtime'}, {id: 'platform', label: 'Platform'},
];

const allowed = <T extends {admin?: boolean; identity?: boolean}>(items: T[], session: Session) => items.filter((item) => (
  (!item.admin || canAdminister(session)) && (!item.identity || session.identityManagementAvailable !== false)
));

export const availablePages = (snapshot: DashboardSnapshot): Array<Entry<PageId>> => hasDashboardRole(snapshot.session)
  ? allowed(PAGES, snapshot.session) : [{id: 'my-instances', label: 'My applications'}];
export const availableSystemSections = (snapshot: DashboardSnapshot) => allowed(SYSTEM_SECTIONS, snapshot.session);
export const activeSystemSection = (snapshot: DashboardSnapshot, section: SystemSectionId): SystemSectionId =>
  availableSystemSections(snapshot).some((item) => item.id === section) ? section : 'status';

export const federationLicensed = (snapshot: DashboardSnapshot) =>
  snapshot.license?.features.some((feature) => feature.id === 'federated-sso' && feature.licensed) === true;
export const availableSettingsSections = (snapshot: DashboardSnapshot) => canAdminister(snapshot.session)
  ? allowed(SETTINGS_SECTIONS, snapshot.session).map((item) => ({
    ...item,
    // As in the browser: visible, but not selectable without the entitlement.
    disabled: item.entitlement === 'federated-sso' && !federationLicensed(snapshot) ? 'A valid Free Registered or Commercial Federated SSO entitlement is required.' : undefined,
  })) : [];
export const activeSettingsSection = (snapshot: DashboardSnapshot, section: SettingsSectionId): SettingsSectionId =>
  availableSettingsSections(snapshot).some((item) => item.id === section && !item.disabled) ? section : 'domains';
export const availableStatusSections = (snapshot: DashboardSnapshot) => allowed(STATUS_SECTIONS, snapshot.session);
export const activeStatusSection = (snapshot: DashboardSnapshot, section: StatusSectionId): StatusSectionId =>
  availableStatusSections(snapshot).some((item) => item.id === section) ? section : 'overview';

export const meshTabs = (snapshot: DashboardSnapshot): Array<{id: MeshTabId; label: string}> => [
  {id: 'overview', label: 'Overview'}, {id: 'models', label: 'Models'},
  ...(snapshot.mesh?.authority ? [{id: 'invitations' as const, label: 'Invitations'}] : []),
  {id: 'network', label: 'Network'},
];
export const activeMeshTab = (snapshot: DashboardSnapshot, tab: MeshTabId): MeshTabId =>
  meshTabs(snapshot).some((item) => item.id === tab) ? tab : 'overview';

export const initialPageState = (overrides: Partial<PageState> = {}): PageState => ({
  page: 'overview', systemSection: 'status', settingsSection: 'domains', statusSection: 'overview', meshTab: 'overview',
  serviceFilter: 'all', expanded: {}, ui: {}, ...overrides,
});
