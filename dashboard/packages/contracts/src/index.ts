import {z} from 'zod';

export const phaseSchema = z.string().catch('Unknown');

export const sessionSchema = z.object({
  subject: z.string().default(''),
  username: z.string().default('unknown'),
  roles: z.array(z.string()).default([]),
  identityManagementAvailable: z.boolean().default(false),
  identityManagementMode: z.string().default('external'),
}).passthrough();

export type Session = z.infer<typeof sessionSchema>;

export interface LicenseClaims {
  version: 1;
  product: 'magicstick';
  issuer: 'magicstick';
  licenseId: string;
  customer: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  features: string[];
  installationId?: string;
}

export interface LicenseVerification {
  state: string;
  message: string;
  valid: boolean;
  claims?: LicenseClaims;
  keyId?: string;
}

export interface LicenseStatus extends LicenseVerification {
  installationId: string;
  revision: string;
  checkedAt: number;
  trustedKeyIds: string[];
  hasDocument: boolean;
  features: Array<{id: string; name: string; licensed: boolean; implemented: boolean; available: boolean; reason: string}>;
}

export interface LicensePreview {
  candidate: LicenseVerification;
  current: LicenseStatus;
}

export interface EnterpriseFeatureState {
  id: string;
  name: string;
  licensed: boolean;
  implemented: boolean;
  available: boolean;
  reason: string;
}

export interface FederationMapping {
  source: string;
  value: string;
  accessLevel: 'user' | 'viewer' | 'operator' | 'admin';
}

export interface FederationProvider {
  alias: string;
  displayName: string;
  protocol: 'oidc' | 'saml';
  metadataUrl: string;
  clientId?: string;
  scopes?: string;
  enabled: boolean;
  trustEmail: boolean;
  secretConfigured: boolean;
  mappings: FederationMapping[];
  revision: string;
}

export interface FederatedSsoStatus {
  feature: EnterpriseFeatureState;
  issuer: string;
  callbackUrl: string;
  providers: FederationProvider[];
}

export interface FederationValidation {
  protocol: 'oidc' | 'saml';
  metadataUrl: string;
  configuration: Record<string, string>;
}

export interface FederationInput {
  alias: string;
  displayName: string;
  protocol: 'oidc' | 'saml';
  metadataUrl: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
  enabled: boolean;
  trustEmail: boolean;
  mappings: FederationMapping[];
  expectedRevision?: string;
}

export const settingsSchema = z.object({
  publicDomain: z.string().default(''),
  dashboardHost: z.string().default(''),
  mdnsDomain: z.string().default('magicstick.local'),
  mdnsName: z.string().default('magicstick'),
}).passthrough();

export type Settings = z.infer<typeof settingsSchema>;

export interface KubernetesObjectMeta {
  name?: string;
  namespace?: string;
  deletionTimestamp?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface StatusValue {
  phase?: string;
  message?: string;
  [key: string]: unknown;
}

export interface Appliance {
  metadata?: KubernetesObjectMeta;
  spec?: Record<string, unknown>;
  status?: StatusValue;
}

export interface ModuleState {
  enabled?: boolean;
  activationMode?: string;
  displayName?: string;
  status?: StatusValue;
  [key: string]: unknown;
}

export interface ModuleCatalogEntry {
  displayName?: string;
  activationMode?: string;
  activationPolicy?: string;
  group?: string;
  order?: number;
  credentials?: {provider?: string};
  description?: string;
  aliases?: string[];
  parameters?: Array<{
    name: string;
    label?: string;
    placeholder?: string;
    type?: string;
  }>;
  [key: string]: unknown;
}

export interface ModuleCatalogGroup {
  displayName?: string;
  order?: number;
}

export interface ApplicationCatalogEntry {
  displayName?: string;
  requiredModules?: string[];
  [key: string]: unknown;
}

export interface ModulesPayload {
  modules: Record<string, ModuleState>;
  catalogJson?: {
    modules?: Record<string, ModuleCatalogEntry>;
    applications?: Record<string, ApplicationCatalogEntry>;
    groups?: Record<string, ModuleCatalogGroup>;
  };
}

export interface InstanceSharing {
  mode: 'all' | 'selected';
  users?: string[];
  groups?: string[];
}

export interface SharingPrincipal {id: string; name: string}

export interface InstanceAccessState {
  name: string;
  revision: string;
  sharing: InstanceSharing;
  authentication: string;
  guardReady: boolean;
  feature: {id: string; licensed: boolean; implemented: boolean; available: boolean; reason: string};
  principals?: {users: SharingPrincipal[]; groups: SharingPrincipal[]};
}

export interface AppInstance {
  metadata?: KubernetesObjectMeta;
  spec?: Record<string, unknown> & {
    application?: string;
    enabled?: boolean;
    targetNamespace?: string;
    values?: Record<string, unknown>;
    access?: {authentication?: string; role?: string; exposure?: string; sharing?: InstanceSharing};
  };
  status?: StatusValue;
}

export interface InstancesPayload {
  instances: Record<string, AppInstance[]>;
}

export interface ComputeTarget {
  id: string;
  kind?: 'cpu' | 'gpu' | string;
  displayName?: string;
  engines?: string[];
  kvCacheTypes?: Record<string, KvCacheOption[]>;
  available?: boolean;
  message?: string;
}

export interface KvCacheOption {
  value: 'auto' | 'fp8' | 'f16' | 'q8_0' | 'q4_0' | string;
  label: string;
  description?: string;
  relativeSize?: number;
}

export interface ComputeMemoryDevice {
  id: string;
  kind?: string;
  vendor?: string;
  computeTarget?: string;
  name?: string;
  totalMi?: number;
  reservedMi?: number;
  unreservedMi?: number;
  freeMi?: number;
  metricsAvailable?: boolean;
  metricsSource?: string;
}

export interface ModelArtifact {
  id?: string;
  title?: string;
  label?: string;
  url?: string;
  precision?: string;
  quantization?: string | Quantization | null;
  bits?: number;
  format?: string;
  memoryRequiredMi?: number;
  vramMi?: number;
  weightBytes?: number;
  downloadBytes?: number;
  sizeLabel?: string;
  modelMaxContext?: number;
  compatibility?: string;
  [key: string]: unknown;
}

export interface ModelVariant {
  computeTarget?: string;
  engine?: string;
  url?: string;
  modelType?: string;
  contextWindow?: number;
  maxNumSeqs?: number;
  memoryRequiredMi?: number;
  vramMi?: number;
  defaultArtifact?: string;
  artifacts?: ModelArtifact[];
  [key: string]: unknown;
}

export interface ModelPreset {
  displayName?: string;
  variants?: ModelVariant[];
  [key: string]: unknown;
}

export interface ModelActivation {
  metadata?: KubernetesObjectMeta;
  spec?: Record<string, unknown> & {
    type?: string;
    enabled?: boolean;
    local?: Record<string, unknown>;
    external?: Record<string, unknown>;
  };
  status?: StatusValue;
}

export interface RegisteredModel {
  id?: string;
  name?: string;
  type?: string;
  provider?: string;
  source?: string;
  modelRef?: string;
  [key: string]: unknown;
}

export interface ModelsPayload {
  models?: RegisteredModel[];
  activations: ModelActivation[];
  presets: Record<string, ModelPreset>;
  computeTargets: {default?: string; targets: ComputeTarget[]};
  computeMemory?: {deviceCount?: number; metricsComplete?: boolean; devices?: ComputeMemoryDevice[]};
  [key: string]: unknown;
}

export interface Quantization {
  method?: string;
  bits?: number;
  scheme?: string;
  label?: string;
}

export interface DiscoveryItem extends ModelArtifact {
  id: string;
  repo: string;
  name?: string;
  author?: string;
  formats?: string[];
  parameterCount?: number;
  quantization?: Quantization | null;
  trustStatus?: string;
  pulls?: number;
  tagCount?: number;
}

export interface DiscoverySearchPayload {
  provider: 'huggingface' | 'ollama';
  results: DiscoveryItem[];
  total: number;
  nextCursor?: string | null;
}

export interface DiscoveryArtifactsPayload {
  provider: 'huggingface' | 'ollama';
  artifacts: DiscoveryItem[];
  total: number;
  nextCursor?: string | null;
}

export interface CpuOffloadingPlan {
  enabled: boolean;
  mode: 'weights' | 'gpu-first';
  vramBudgetMi: number;
  weightsOnGpuMi: number;
  weightsOnCpuMi: number;
  kvOnGpuMi: number;
  kvOnCpuMi: number;
  hostRuntimeMi: number;
  ramMinimumMi: number;
  ramRecommendedMi: number;
  ramMaximumMi: number | null;
  gpuMinimumMi: number;
  gpuRecommendedMi: number;
  fitsVram: boolean;
  estimated: boolean;
}

export interface MemoryCalculation {
  formula: string;
  substitution?: string | null;
  notes?: string[];
}

export interface MemoryEstimate {
  minimumMi: number;
  recommendedMi: number;
  maximumMi?: number | null;
  weightsMi?: number;
  downloadBytes?: number;
  quantization?: Quantization | null;
  kvCacheMi?: number;
  kvCacheType?: string;
  kvCacheBaselineMi?: number;
  kvCacheSavingsMi?: number;
  theoreticalKvCacheMi?: number | null;
  hybridAllocatorSafetyMi?: number;
  kvCompatibilityFactor?: number;
  reserveMi?: number;
  recommendedReserveMi?: number;
  runtimeDetails?: {
    runtimeWeightsMi?: number;
    compileReserveMi?: number;
    multimodalReserveMi?: number;
    unpackReserveMi?: number;
    engineRuntimeReserveMi?: number;
    attentionKvCacheMi?: number;
    recurrentStateMi?: number;
    fullAttentionLayers?: number;
    recurrentLayers?: number;
  };
  offloading?: CpuOffloadingPlan;
  contextWindow?: number;
  modelMaxContext?: number;
  maxNumSeqs?: number;
  confidence?: string;
  calculationSource?: string;
  warnings?: string[];
  calculations?: Record<string, MemoryCalculation>;
  [key: string]: unknown;
}

export interface HardwareOperator {
  module?: string;
  displayName?: string;
  vendor?: string;
  operatorVersion?: string;
  driverMode?: string;
  phase?: string;
  needed?: boolean;
  operatorActive?: boolean;
  managedBy?: string;
  detectedNodes?: string[];
  compatibleNodes?: string[];
  allocatableResources?: number;
  message?: string;
}

export interface RouteStatus {
  namespace?: string;
  name?: string;
  labels?: Record<string, string>;
  hostnames?: string[];
  accepted?: boolean;
}

export interface IngressStatus {
  namespace?: string;
  name?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  hosts?: string[];
}

export interface KubernetesObjectSummary {
  namespace?: string;
  name?: string;
  phase?: string;
  conditions?: Array<{type?: string; status?: string; reason?: string; message?: string}>;
}

export interface SystemStatusPayload {
  appliance?: Appliance;
  fluxKustomizations?: KubernetesObjectSummary[];
  pods?: KubernetesObjectSummary[];
  services?: KubernetesObjectSummary[];
  ingresses?: IngressStatus[];
  httpRoutes?: RouteStatus[];
  hardwareOperators?: Record<string, HardwareOperator>;
  events?: Array<Record<string, unknown>>;
}

export interface UserCapabilities {
  canEditProfile?: boolean;
  canManageRoles?: boolean;
  canEnable?: boolean;
  canDisable?: boolean;
  canResetPassword?: boolean;
  canDelete?: boolean;
  isSelf?: boolean;
  isProtected?: boolean;
}

export interface User {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  email?: string;
  emailVerified?: boolean;
  enabled?: boolean;
  source?: string | Record<string, unknown>;
  provider?: string;
  local?: boolean;
  createdAt?: string | number;
  createdTimestamp?: string | number;
  directRoles?: string[];
  effectiveRoles?: string[];
  accessLevel?: string;
  effectiveAccessLevel?: string;
  capabilities?: UserCapabilities;
}

export interface UsersPayload {
  users: User[];
  total: number;
  first: number;
  max: number;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  keyHint?: string;
  createdAt?: string;
  expiresAt?: string;
  status?: string;
}

export interface ApiAccessPayload {
  items: ApiKeyItem[];
  total: number;
  apiBases?: Array<{scope?: string; url: string}>;
}

export interface KubernetesAccessUser {
  id: string;
  username: string;
  displayName?: string;
  email?: string;
  enabled?: boolean;
  source?: string;
  provider?: string;
  accessLevel?: string;
  protected?: boolean;
}

export interface KubernetesAccessPayload {
  users: KubernetesAccessUser[];
  total: number;
  first: number;
  max: number;
  configuration?: Record<string, unknown>;
}
