import type {
  ApiAccessPayload,
  Appliance,
  ConsoleAccess,
  FederatedSsoStatus,
  GpuSharingState,
  InstancesPayload,
  KubernetesAccessPayload,
  ManagedHost,
  MeshStatus,
  ModelsPayload,
  ModulesPayload,
  RegressionStatus,
  Session,
  Settings,
  SoftwareReleaseCatalog,
  SystemStatusPayload,
  UsersPayload,
  LicenseStatus,
} from '@magicstick/dashboard-contracts';
import {canAdminister} from '@magicstick/dashboard-core';
import type {MagicStickApi} from '@magicstick/dashboard-api-client';

/** Data that only some pages show; loaded while such a page is open, like the browser's per-page queries. */
export type ExtraKey = 'hosts' | 'gpuSharing' | 'mesh' | 'federatedSso' | 'regression' | 'softwareReleases';

export interface MyInstance {
  name: string;
  application: string;
  phase: string;
  urls: string[];
}

export interface DashboardSnapshot {
  session: Session;
  appliance: Appliance;
  modules: ModulesPayload;
  instances: InstancesPayload;
  models: ModelsPayload;
  settings?: Settings;
  status: SystemStatusPayload;
  users?: UsersPayload;
  apiAccess?: ApiAccessPayload;
  kubernetesAccess?: KubernetesAccessPayload;
  consoleAccess?: ConsoleAccess;
  license?: LicenseStatus;
  licenseError?: string;
  /** Applications shared with a signed-in user without a dashboard role (the browser's "My applications"). */
  myInstances?: MyInstance[];
  hosts?: {nodes: ManagedHost[]};
  gpuSharing?: {providers: GpuSharingState[]};
  mesh?: MeshStatus;
  federatedSso?: FederatedSsoStatus;
  regression?: RegressionStatus;
  softwareReleases?: SoftwareReleaseCatalog;
  softwareReleasesAt?: number;
  /** When the page-specific data was last loaded (it polls faster than the shared state). */
  extrasLoadedAt?: number;
  /** Why on-demand data could not be loaded, by key; the rest of the dashboard stays usable. */
  errors?: Partial<Record<ExtraKey, string>>;
  loadedAt: number;
}

export interface SnapshotOptions {
  extras?: ExtraKey[];
  users?: {search?: string; first?: number; max?: number};
  kubernetesSearch?: string;
  /** The previous snapshot, to reuse slowly changing data such as the release catalog. */
  previous?: DashboardSnapshot;
  /** Reload the release catalog even when the cached copy is recent. */
  forceReleases?: boolean;
  /** Reload only the page-specific data and keep the shared state of `previous`, like the browser's per-page polling. */
  extrasOnly?: boolean;
}

const DASHBOARD_ROLES = ['magicstick-viewer', 'magicstick-operator', 'magicstick-admin'];
const RELEASE_CACHE_MS = 300_000;

/** A signed-in identity without any dashboard role only sees the applications shared with it. */
export const hasDashboardRole = (session: Session) => session.roles.some((role) => DASHBOARD_ROLES.includes(role));

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Extras = Pick<DashboardSnapshot, 'hosts' | 'gpuSharing' | 'mesh' | 'federatedSso' | 'regression' | 'softwareReleases' | 'softwareReleasesAt' | 'errors'>;

const loadExtras = async (api: MagicStickApi, session: Session, options: SnapshotOptions): Promise<Extras> => {
  const admin = canAdminister(session);
  const identity = session.identityManagementAvailable !== false;
  const extras = new Set(options.extras ?? []);
  const errors: Partial<Record<ExtraKey, string>> = {};
  const optional = async <T,>(key: ExtraKey, allowed: boolean, fetch: () => Promise<T>): Promise<T | undefined> => {
    if (!allowed || !extras.has(key)) return undefined;
    try { return await fetch(); } catch (error) { errors[key] = errorText(error); return undefined; }
  };
  const previous = options.previous;
  const cachedReleases = !options.forceReleases && previous?.softwareReleases && Date.now() - (previous.softwareReleasesAt ?? 0) < RELEASE_CACHE_MS;
  const [hosts, gpuSharing, mesh, federatedSso, regression, releases] = await Promise.all([
    optional('hosts', true, () => api.hostManagement()),
    optional('gpuSharing', true, () => api.gpuSharing()),
    optional('mesh', admin, () => api.mesh()),
    optional('federatedSso', admin && identity, () => api.federatedSso()),
    optional('regression', admin, () => api.regression()),
    optional('softwareReleases', admin && !cachedReleases, () => api.softwareReleases()),
  ]);
  return {
    hosts, gpuSharing, mesh, federatedSso, regression,
    softwareReleases: releases ?? (cachedReleases ? previous?.softwareReleases : undefined),
    softwareReleasesAt: releases ? Date.now() : cachedReleases ? previous?.softwareReleasesAt : undefined,
    ...(Object.keys(errors).length ? {errors} : {}),
  };
};

export const loadSnapshot = async (api: MagicStickApi, options: SnapshotOptions = {}): Promise<DashboardSnapshot> => {
  const previous = options.previous;
  if (options.extrasOnly && previous && hasDashboardRole(previous.session)) {
    const {errors: _stale, ...base} = previous;
    return {...base, ...await loadExtras(api, previous.session, options), extrasLoadedAt: Date.now()};
  }
  const session = await api.session();
  if (!hasDashboardRole(session)) {
    const mine = await api.myInstances();
    return {
      session, appliance: {}, modules: {} as ModulesPayload, instances: {} as InstancesPayload, status: {},
      models: {activations: [], presets: {}, computeTargets: {targets: []}} as unknown as ModelsPayload,
      myInstances: mine.items, loadedAt: Date.now(),
    };
  }
  const admin = canAdminister(session);
  const identity = session.identityManagementAvailable !== false;
  const [appliance, modules, instances, models, status, settings, users, apiAccess, kubernetesAccess, consoleAccess] = await Promise.all([
    api.appliance(), api.modules(), api.instances(), api.models(), api.status(),
    admin ? api.settings() : Promise.resolve(undefined),
    admin && identity ? api.users(options.users?.search ?? '', options.users?.first ?? 0, options.users?.max ?? 25) : Promise.resolve(undefined),
    admin ? api.apiAccess() : Promise.resolve(undefined),
    admin && identity ? api.kubernetesAccess(options.kubernetesSearch ?? '') : Promise.resolve(undefined),
    // Optional: an appliance API from before automatic console sign-in has no such route.
    admin && identity ? api.consoleAccess().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  let license: LicenseStatus | undefined;
  let licenseError: string | undefined;
  if (admin) {
    try { license = await api.licenseStatus(); }
    catch { licenseError = 'License status unavailable. Core functions are unaffected.'; }
  }

  const now = Date.now();
  return {
    session, appliance, modules, instances, models, status, settings, users, apiAccess, kubernetesAccess, consoleAccess, license, licenseError,
    ...await loadExtras(api, session, options), extrasLoadedAt: now, loadedAt: now,
  };
};
