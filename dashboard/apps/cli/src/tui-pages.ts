// Page content of the terminal dashboard. It mirrors the browser dashboard:
// the same pages, sections, panels and buttons. Each area lives in its own module.
import type {DashboardSnapshot, ExtraKey, SnapshotOptions} from './snapshot';
import {accessModule, apiAccessPage, kubernetesPage} from './tui-access';
import type {AreaModule} from './tui-context';
import {hardwareModule, hardwareSection, powerSection} from './tui-hardware';
import {hostSettingsModule} from './tui-host-settings';
import {identityModule, licenseSection, usersSection} from './tui-identity';
import {meshModule, meshPage} from './tui-mesh';
import {modelsModule, modelsPage} from './tui-models';
import {myInstancesPage, overviewPage} from './tui-overview';
import {servicesModule, servicesPage} from './tui-services';
import {settingsModule, settingsSection} from './tui-settings';
import {
  activeSettingsSection, activeStatusSection, activeSystemSection, availableSystemSections,
  type PageState, type PageView, type SystemSectionId,
} from './tui-state';
import {statusModule, statusSection} from './tui-status';
import {heading, tabBar} from './tui-widgets';

export * from './tui-state';
export {deployedChatModels, isLocalUser, userSource} from './tui-widgets';

/** Every area's action handler; the runtime dispatches `scope:verb:target` ids to them. */
export const AREA_MODULES: AreaModule[] = [
  modelsModule, servicesModule, accessModule, meshModule, settingsModule, hostSettingsModule, identityModule, hardwareModule, statusModule,
];

const SECTION_BUILDERS: Record<SystemSectionId, (snapshot: DashboardSnapshot, state: PageState, width: number) => PageView> = {
  settings: settingsSection, license: licenseSection, users: usersSection,
  hardware: hardwareSection, status: statusSection, power: powerSection,
};

const systemPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  const sections = availableSystemSections(snapshot);
  const active = activeSystemSection(snapshot, state.systemSection);
  const body = SECTION_BUILDERS[active](snapshot, state, width);
  return {tick: body.tick, hotkeys: [{key: 's', label: 'Section', actionId: 'section:next'}, ...body.hotkeys], rows: [
    ...heading(width, 'System', ''),
    tabBar('section', sections, active),
    [],
    ...body.rows,
  ]};
};

export const buildPage = (snapshot: DashboardSnapshot, state: PageState, width: number): PageView => {
  switch (state.page) {
    case 'models': return modelsPage(snapshot, width, state);
    case 'services': return servicesPage(snapshot, state, width);
    case 'api-access': return apiAccessPage(snapshot, width);
    case 'mesh': return meshPage(snapshot, state, width);
    case 'kubernetes-access': return kubernetesPage(snapshot, state, width);
    case 'system': return systemPage(snapshot, state, width);
    case 'my-instances': return myInstancesPage(snapshot, width);
    default: return overviewPage(snapshot, width);
  }
};

/**
 * What the open page needs besides the shared state, and how often to reload it.
 * Like the browser, fast-changing host operations, mesh state and regression runs poll more often.
 */
export const dataNeeds = (snapshot: DashboardSnapshot, state: PageState): {options: SnapshotOptions; refreshMs: number} => {
  const extras = new Set<ExtraKey>();
  let refreshMs = 15_000;
  const fast = (ms: number) => { refreshMs = Math.min(refreshMs, ms); };
  if (state.page === 'mesh') {
    extras.add('mesh');
    fast(5_000);
  }
  if (state.page === 'system') {
    const section = activeSystemSection(snapshot, state.systemSection);
    if (section === 'settings') {
      const settings = activeSettingsSection(snapshot, state.settingsSection);
      if (settings === 'network' || settings === 'updates') { extras.add('hosts'); fast(5_000); }
      if (settings === 'updates') extras.add('softwareReleases');
      if (settings === 'federated-sso') extras.add('federatedSso');
    }
    if (section === 'hardware') { extras.add('hosts'); extras.add('gpuSharing'); fast(5_000); }
    if (section === 'power') { extras.add('hosts'); fast(5_000); }
    if (section === 'status') {
      const status = activeStatusSection(snapshot, state.statusSection);
      if (status === 'model-cache') { extras.add('hosts'); fast(5_000); }
      if (status === 'regression') { extras.add('regression'); fast(2_000); }
    }
  }
  return {refreshMs, options: {extras: [...extras], ...queryOptions(state)}};
};

/** Searches and paging that select which users and identities are loaded. */
export const queryOptions = (state: PageState): Pick<SnapshotOptions, 'users' | 'kubernetesSearch'> => ({
  users: {search: state.ui['users.search'] ?? '', first: Number(state.ui['users.first'] ?? 0), max: Number(state.ui['users.max'] ?? 25)},
  kubernetesSearch: state.ui['k8s.search'] ?? '',
});
