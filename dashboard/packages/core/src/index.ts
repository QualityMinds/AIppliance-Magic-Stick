import type {
  AppInstance,
  ApplicationCatalogEntry,
  IngressStatus,
  InstancesPayload,
  ModelArtifact,
  ModelVariant,
  StatusValue,
  ModuleCatalogEntry,
  ModuleState,
  RouteStatus,
  Session,
  SystemStatusPayload,
} from '@magicstick/dashboard-contracts';

export type DashboardRole = 'viewer' | 'operator' | 'admin';

export const dashboardRole = (session?: Session): DashboardRole => {
  const roles = new Set(session?.roles ?? []);
  if (roles.has('magicstick-admin')) return 'admin';
  if (roles.has('magicstick-operator')) return 'operator';
  return 'viewer';
};

export const canMutateRuntime = (session?: Session) => dashboardRole(session) !== 'viewer';
export const canAdminister = (session?: Session) => dashboardRole(session) === 'admin';

export const phaseTone = (phase?: string) => {
  const normalized = String(phase ?? '').toLowerCase();
  if (['ready', 'active', 'enabled', 'completed', 'succeeded', 'registered', 'accepted', 'configured'].includes(normalized)) return 'good';
  if (['failed', 'error', 'degraded'].includes(normalized)) return 'bad';
  if (['installing', 'starting', 'reconciling', 'pending', 'progressing'].includes(normalized)) return 'warn';
  return 'neutral';
};

export interface ProgressState {
  value: number;
  label: string;
  tone: 'good' | 'warn' | 'bad' | 'neutral';
}

export const phaseInProgress = (phase?: string) => [
  'requested', 'detected', 'installing', 'waitingformodules', 'waitingforcrds',
  'waitingforgpu', 'starting', 'reconciling', 'removing', 'progressing',
].includes(String(phase ?? '').toLowerCase());

export const phaseNeedsAttention = (phase?: string) => {
  const normalized = String(phase ?? '').toLowerCase();
  return ['degraded', 'failed', 'error', 'unsupported', 'conflict'].includes(normalized)
    || phaseInProgress(normalized);
};

export const effectiveModuleStatus = (
  id: string,
  state: ModuleState,
  status?: SystemStatusPayload,
  nvidiaTelemetryAvailable?: boolean,
): StatusValue => {
  const operator = status?.hardwareOperators?.[id];
  if (!operator) return state.status ?? {};
  const merged: StatusValue = {...state.status, ...operator, message: operator.message || state.status?.message};
  if (id === 'gpu' && String(merged.phase ?? '').toLowerCase() === 'ready' && nvidiaTelemetryAvailable !== true) {
    return {...merged, phase: 'Installing', message: 'The NVIDIA GPU resource is published; waiting for DCGM telemetry before reporting the service ready.'};
  }
  return merged;
};

export const progressForPhase = (phase?: string, enabled = true, message = ''): ProgressState => {
  const normalized = String(phase ?? '').toLowerCase();
  if (['ready', 'active', 'completed', 'succeeded'].includes(normalized)) return {value: 100, label: 'Ready', tone: 'good'};
  if (normalized === 'installing') return {value: 85, label: 'Waiting for hardware readiness', tone: 'warn'};
  if (normalized === 'waitingformodules') return {value: 35, label: 'Waiting for dependencies', tone: 'warn'};
  if (normalized === 'waitingforcrds') return {value: 45, label: 'Waiting for CRDs', tone: 'warn'};
  if (normalized === 'waitingforgpu') return {value: 55, label: 'Waiting for GPU', tone: 'warn'};
  if (normalized === 'starting') return {value: 85, label: 'Starting model runtime', tone: 'warn'};
  if (normalized === 'reconciling') return {value: 70, label: 'Reconciling', tone: 'warn'};
  if (normalized === 'removing') return {value: 65, label: 'Removing', tone: 'warn'};
  if (['degraded', 'failed', 'error', 'unsupported', 'conflict'].includes(normalized)) {
    return {value: 100, label: message || phase || 'Needs attention', tone: 'bad'};
  }
  if (['disabled', 'suspended'].includes(normalized) || !enabled) return {value: 0, label: normalized === 'suspended' ? 'Suspended' : 'Disabled', tone: 'neutral'};
  return {value: 20, label: phase || 'Requested', tone: 'warn'};
};

export const titleFromKey = (value: string) => value
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[-_]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
  .join(' ') || 'Module';

export const moduleReady = (module?: ModuleState, catalog?: ModuleCatalogEntry) => {
  if (module?.enabled !== true) return false;
  const phase = String(module.status?.phase ?? '').toLowerCase();
  const activationMode = module.activationMode ?? catalog?.activationMode;
  return phase === 'ready' || (activationMode === 'static' && !phase);
};

export const missingApplicationModules = (
  definition: ApplicationCatalogEntry | undefined,
  modules: Record<string, ModuleState>,
  catalog: Record<string, ModuleCatalogEntry>,
) => (definition?.requiredModules ?? []).filter((id) => !moduleReady(modules[id], catalog[id]));

export interface ResourceLink {url: string; label: string; scope: 'local' | 'public' | 'direct'}

const httpUrl = (value?: unknown) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `http://${raw.replace(/^\/+/, '').replace(/\/?$/, '/')}`;
};

const hostOf = (value?: unknown) => {
  const url = httpUrl(value);
  if (!url) return '';
  try { return new URL(url).host; } catch { return String(value ?? '').replace(/^https?:\/\//i, '').replace(/\/.*$/, ''); }
};

const hostnameOf = (value?: unknown) => {
  const url = httpUrl(value);
  if (!url) return '';
  try { return new URL(url).hostname; } catch { return hostOf(value).replace(/:\d+$/, ''); }
};

const scopeOf = (url: string): ResourceLink['scope'] => {
  const hostname = hostnameOf(url);
  if (hostname.endsWith('.local')) return 'local';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname === 'localhost') return 'direct';
  return 'public';
};

const linkFromUrl = (value?: unknown): ResourceLink | null => {
  const url = httpUrl(value);
  return url ? {url, label: hostOf(url) || url, scope: scopeOf(url)} : null;
};

const uniqueLinks = (links: Array<ResourceLink | null>) => {
  const seen = new Set<string>();
  return links.filter((link): link is ResourceLink => {
    const key = link?.url.replace(/\/$/, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => ({local: 10, public: 20, direct: 30}[a.scope] - {local: 10, public: 20, direct: 30}[b.scope]) || a.label.localeCompare(b.label));
};

const normalizedKey = (value?: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const routeLinks = (routes: RouteStatus[]) => routes.flatMap((route) => route.accepted === true
  ? (route.hostnames ?? []).map((host) => linkFromUrl(`https://${host}`))
  : []);

const ingressLinks = (ingresses: IngressStatus[]) => ingresses.flatMap((ingress) => (ingress.hosts ?? []).map(linkFromUrl));

export const moduleResourceLinks = (
  name: string,
  catalog: ModuleCatalogEntry | undefined,
  status?: SystemStatusPayload,
) => {
  const keys = new Set([name, ...(catalog?.aliases ?? [])].map(normalizedKey).filter(Boolean));
  const allowContains = catalog?.activationMode === 'static';
  const matches = (resource: RouteStatus | IngressStatus) => {
    const labels = resource.labels ?? {};
    const annotations = 'annotations' in resource ? resource.annotations ?? {} : {};
    const labeled = [labels.app, labels['app.kubernetes.io/name'], labels['appliance.magicstick.dev/module'], annotations['dashboard.ai-appliance.io/title']]
      .map(normalizedKey).filter(Boolean);
    if (labeled.some((key) => keys.has(key))) return true;
    const resourceName = normalizedKey(resource.name);
    if (keys.has(resourceName) || (allowContains && [...keys].some((key) => resourceName.includes(key)))) return true;
    const hosts: string[] = (resource as IngressStatus).hosts ?? (resource as RouteStatus).hostnames ?? [];
    return hosts.some((host) => hostOf(host).split('.').map(normalizedKey).some((part) => keys.has(part)));
  };
  return uniqueLinks([
    ...ingressLinks((status?.ingresses ?? []).filter(matches)),
    ...routeLinks((status?.httpRoutes ?? []).filter(matches)),
  ]);
};

export const instanceResourceLinks = (instance: AppInstance, status?: SystemStatusPayload) => {
  const instanceName = String(instance.metadata?.name ?? '').toLowerCase();
  const values = instance.spec?.values ?? {};
  const server = typeof values.server === 'object' && values.server ? values.server as Record<string, unknown> : {};
  const ingress = typeof values.ingress === 'object' && values.ingress ? values.ingress as Record<string, unknown> : {};
  const serverIngress = typeof server.ingress === 'object' && server.ingress ? server.ingress as Record<string, unknown> : {};
  const configuredHosts = new Set([
    instance.status?.url, instance.status?.localURL, instance.status?.publicURL,
    ingress.host, serverIngress.host, values.host,
  ].map(hostOf).filter(Boolean));
  const matches = (resource: RouteStatus | IngressStatus) => {
    const resourceName = String(resource.name ?? '').toLowerCase();
    if (resourceName.endsWith('-callback')) return false;
    const appInstance = String(resource.labels?.['appliance.magicstick.dev/appinstance'] ?? '').toLowerCase();
    if (instanceName && (resourceName === instanceName || resourceName.startsWith(`${instanceName}-`) || appInstance === instanceName)) return true;
    const hosts: string[] = (resource as IngressStatus).hosts ?? (resource as RouteStatus).hostnames ?? [];
    return hosts.some((host) => configuredHosts.has(hostOf(host)));
  };
  return uniqueLinks([
    ...ingressLinks((status?.ingresses ?? []).filter(matches)),
    ...routeLinks((status?.httpRoutes ?? []).filter(matches)),
    linkFromUrl(instance.status?.localURL), linkFromUrl(instance.status?.publicURL), linkFromUrl(instance.status?.url),
  ]);
};

export const formatMi = (value?: number) => {
  if (!Number.isFinite(value)) return 'unknown';
  const mib = Number(value);
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib >= 10240 ? 0 : 1)} GiB` : `${Math.round(mib)} MiB`;
};

export const formatBytes = (value?: number) => {
  if (!Number.isFinite(value) || Number(value) <= 0) return 'unknown';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = Number(value);
  let index = 0;
  while (current >= 1000 && index < units.length - 1) {
    current /= 1000;
    index += 1;
  }
  return `${current.toFixed(current >= 10 || index === 0 ? 1 : 2)} ${units[index]}`;
};

export interface FlatInstance {
  type: string;
  name: string;
  value: AppInstance;
}

export const flattenInstances = (payload?: InstancesPayload): FlatInstance[] =>
  Object.entries(payload?.instances ?? {}).flatMap(([type, items]) =>
    (items ?? []).map((value) => ({type, name: value.metadata?.name ?? 'unnamed', value})),
  );

export const matchingVariants = (
  variants: ModelVariant[] | undefined,
  engine: string,
  computeTarget: string,
) => (variants ?? []).filter(
  (variant) => variant.engine === engine && variant.computeTarget === computeTarget,
);

export const selectedArtifact = (variant?: ModelVariant, id?: string): ModelArtifact | undefined => {
  const artifacts = variant?.artifacts ?? [];
  return artifacts.find((artifact) => artifact.id === id)
    ?? artifacts.find((artifact) => artifact.id === variant?.defaultArtifact)
    ?? artifacts[0];
};

export const safeModelName = (reference: string) => {
  const tail = reference.replace(/^[a-z]+:\/\//i, '').split('/').pop() ?? 'model';
  return tail.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'model';
};
