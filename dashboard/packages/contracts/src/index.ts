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

export interface AppInstance {
  metadata?: KubernetesObjectMeta;
  spec?: Record<string, unknown> & {
    application?: string;
    enabled?: boolean;
    targetNamespace?: string;
    values?: Record<string, unknown>;
    access?: {authentication?: string; role?: string; exposure?: string};
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
  available?: boolean;
  message?: string;
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

export interface MemoryEstimate {
  minimumMi: number;
  recommendedMi: number;
  maximumMi?: number | null;
  weightsMi?: number;
  downloadBytes?: number;
  quantization?: Quantization | null;
  kvCacheMi?: number;
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
  };
  contextWindow?: number;
  modelMaxContext?: number;
  maxNumSeqs?: number;
  confidence?: string;
  calculationSource?: string;
  warnings?: string[];
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
