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
  edition: 'free-registered' | 'commercial';
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
  edition: 'free' | 'free-registered' | 'commercial';
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

export interface LicenseRequestInput {
  edition: 'free-registered' | 'commercial';
  customer: string;
  features: string[];
  ttlSeconds: number;
}

export interface LicenseDownload {
  filename: string;
  content: string;
}

export interface LicensedFeatureState {
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
  feature: LicensedFeatureState;
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
  uid?: string;
  generation?: number;
  resourceVersion?: string;
  deletionTimestamp?: string;
  annotations?: Record<string, string>;
  labels?: Record<string, string>;
}

export interface StatusValue {
  gpuSharing?: {mode: 'dra-shared' | 'time-slicing' | 'exclusive'; claimName?: string; node: string; device?: string; slotCount?: number; memoryIsolation?: boolean} | null;
  /** Optional normalized observations from a FreeToken local runtime. */
  freeTokenStats?: FreeTokenRuntimeStats | null;
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
  /** Engines declared by the capability catalog, including unavailable ones. */
  declaredEngines?: string[];
  engineAvailability?: Record<string, {available: boolean; message?: string; compatibleNodes?: number; slots?: GpuSlots}>;
  kvCacheTypes?: Record<string, KvCacheOption[]>;
  available?: boolean;
  message?: string;
  slots?: GpuSlots;
}

export interface KvCacheOption {
  value: 'auto' | 'fp8' | 'f16' | 'q8_0' | 'q4_0' | string;
  label: string;
  description?: string;
  relativeSize?: number;
}

/** Corroborated driver capacity, not proof of an engine allocation or RAM protection. */
export interface GpuAllocationEvidence {
  gpuAllocationMode?: 'firmware-reserved' | 'shared-gtt' | 'unknown';
  gpuCapacityMi?: number | null;
  gpuCapacitySource?: string;
}

/** Physical layout: the dynamic ceiling is a subset of Linux-visible RAM. */
export interface SharedMemoryInventory extends GpuAllocationEvidence {
  node: string;
  installedMemoryMi?: number | null;
  firmwareReservedMi?: number | null;
  physicalMemoryMi?: number | null;
  gpuAccessibleMi?: number | null;
  memoryAccountingVerified?: boolean;
}

/** Existing compute-memory API counters for one Linux/GPU shared-memory pool. */
export interface SharedMemoryPool extends SharedMemoryInventory {
  id: string;
  totalMi?: number | null;
  freeMi?: number | null;
  sharedFreeMi?: number | null;
  dedicatedFreeMi?: number | null;
  memoryMetricsSource?: string;
  memorySampledAt?: string | null;
  unreservedMi?: number | null;
  gpuUnreservedMi?: number | null;
  systemReserveMi?: number | null;
}

export interface ComputeMemoryDevice extends GpuAllocationEvidence {
  id: string;
  kind?: string;
  vendor?: string;
  computeTarget?: string;
  name?: string;
  /** Nodes reporting this physical device; used to show a scheduler node, never a GPU UUID. */
  nodes?: string[];
  totalMi?: number;
  reservedMi?: number;
  unreservedMi?: number | null;
  freeMi?: number | null;
  metricsAvailable?: boolean;
  metricsSource?: string;
  memoryArchitecture?: 'unified' | 'discrete' | string;
  sharedPoolId?: string;
  sharedMemoryMi?: number;
  accountingVerified?: boolean;
  warning?: string;
  message?: string;
  slots?: GpuSlots;
  /** Engine-specific device eligibility, populated when the runtime exposes it. */
  freeToken?: {
    /** A scheduler node key (`node:<name>`), never a CUDA UUID. */
    id?: string;
    supported?: boolean;
    reason?: string;
    architecture?: string;
  };
}

/** One GPU as evaluated by the pinned FreeToken runtime capability catalog. */
export interface FreeTokenGpuCapability {
  id: string;
  name?: string;
  /** Scheduling node, when a whole-GPU FreeToken allocation is selectable. */
  node?: string;
  computeTarget?: string;
  vendor?: string;
  architecture?: string;
  supported: boolean;
  reason?: string;
  totalMi?: number;
  freeMi?: number | null;
  unreservedMi?: number | null;
  /** Host RAM on this scheduling node, not a cluster-wide CPU aggregate. */
  systemMemoryMi?: number | null;
  /** Currently usable host RAM on this scheduling node. An explicit zero is capacity zero. */
  systemAvailableMi?: number | null;
  /** Whole NVIDIA GPUs that Kubernetes can allocate on this selected node. */
  gpuCount?: number;
  /** Maximum whole GPUs a single FreeToken runtime may request on this node. */
  maxGpuCount?: number;
}

/**
 * Server-supplied FreeToken limits. The dashboard deliberately treats this as
 * data rather than duplicating a vendor/architecture allow-list in the UI.
 */
export interface FreeTokenCapabilities {
  available?: boolean;
  message?: string;
  version?: string;
  supportedVendors?: string[];
  supportedArchitectures?: string[];
  supportedPrecisionModes?: string[];
  devices?: FreeTokenGpuCapability[];
  unavailableDevices?: FreeTokenGpuCapability[];
  memoryStrategies?: Array<'auto' | 'offload' | 'cpu' | 'hybrid' | 'fused' | string>;
  cacheTypes?: Array<'radix' | 'naive' | string>;
  defaultMemoryRatio?: number;
  defaultSystemMemoryMi?: number;
  minimumGpuMemoryMi?: number;
  minimumSystemMemoryMi?: number;
  defaults?: {
    memoryStrategy?: string;
    systemMemoryMi?: number;
    contextWindow?: number;
    maxNumSeqs?: number;
  };
  advanced?: {
    cacheType?: string[];
    kvReserveTokens?: boolean;
    cudaGraphMaxBatchSize?: boolean;
    moeCacheSize?: boolean;
    maxPrefillLength?: boolean;
    cpuThreads?: boolean;
    expertLoad?: boolean | string[];
    dtype?: boolean | string[];
  };
}

export interface CpuResources {
  requestMillicores: number;
  /** Zero means no CPU quota. */
  limitMillicores: number;
}

export interface VllmConfiguration {
  visionAttention: 'auto' | 'aotriton' | 'triton' | 'flash-attn-triton';
}

export interface RealtimeConfiguration {
  profile: string;
  gpuNode: string;
  gpuCount: number;
  systemMemoryMi: number;
  gpuMemoryFraction: number;
  thinkerCpuOffloadGiB: number;
  runtimeImage?: string;
  restartNonce?: string;
}

export interface RealtimeProfile {
  displayName: string;
  model: string;
  description: string;
  gpuCounts: number[];
  defaultContextWindow: number;
  maxContextWindow?: number;
  defaultSystemMemoryMi: number;
  sourceRevision: string;
  computeTargets?: string[];
  backend?: 'cuda' | 'rocm' | 'xpu' | 'cpu';
  image?: string;
  maxCpuOffloadGiB?: number;
  hostRuntimeHeadroomMi?: number;
}

export interface RealtimeDevice {
  profile: string;
  node: string;
  name: string;
  supported: boolean;
  reason: string;
  gpuCount: number;
  maxGpuCount?: number;
  slotCount?: number;
  allocationMode?: 'exclusive' | 'time-slicing' | 'dra-shared' | 'cpu';
  freeGpuCount: number;
  gpuMemoryMi: number;
  systemMemoryMi: number;
  computeTarget?: string;
  memoryArchitecture?: string;
  gpuAllocationMode?: string;
}

/** Catalog-owned choices; availability is not a successful GPU/model test. */
export interface VisionAttentionSettings {
  default: VllmConfiguration['visionAttention'];
  computeTargets: string[];
  runtimeVersion?: string;
  options: Array<{value: VllmConfiguration['visionAttention']; label: string; description: string}>;
}

export interface ComputeTargetsPayload {
  default?: string;
  defaultEngine?: string;
  engineCatalog?: Record<string, {displayName?: string; available?: boolean; message?: string; cpuDefaults?: Partial<Record<'cpu' | 'gpu', CpuResources>>; deploymentSettings?: {visionAttention?: VisionAttentionSettings}; realtimeProfiles?: Record<string, RealtimeProfile>}>;
  realtimeDevices?: RealtimeDevice[];
  freeTokenCapabilities?: FreeTokenCapabilities;
  targets: ComputeTarget[];
}

/** Scheduling capacity, independent of memory and shared across engines. */
export interface GpuSlots {
  total: number;
  used: number;
  free: number;
  queued?: number;
  scope?: 'device' | 'node' | 'target';
  node?: string;
  mode?: string;
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
  modelContextSource?: 'artifact' | 'base-model';
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

/** Persisted FreeToken-only runtime settings; no vLLM/Ollama settings apply here. */
export interface FreeTokenAdvancedConfiguration {
  cacheType?: 'radix' | 'naive' | string;
  kvReserveTokens?: number | null;
  cpuThreads?: number | null;
  cudaGraphMaxBatchSize?: number | null;
  moeCacheSize?: number | null;
  maxPrefillLength?: number | null;
  expertLoad?: string | null;
  dtype?: string | null;
}

export interface FreeTokenConfiguration {
  gpuDevice: string;
  /** Whole GPUs requested from the selected Kubernetes node. Defaults to one. */
  gpuCount?: number;
  /** Aggregate VRAM budget across all requested whole GPUs, in MiB. */
  gpuMemoryMi: number;
  /** Kubernetes host-RAM reservation; FreeToken itself has no separate RAM-limit flag. */
  systemMemoryMi: number;
  memoryStrategy: 'auto' | 'offload' | 'cpu' | 'hybrid' | 'fused' | string;
  advanced: FreeTokenAdvancedConfiguration;
}

/**
 * Normalized optional telemetry from FreeToken's versioned `/v1/stats`
 * endpoint. Values are observations, not scheduler reservations or limits.
 */
export interface FreeTokenRuntimeStats {
  source?: string;
  sampledAt?: string;
  vramMi?: number;
  cacheBudgetMi?: number;
  kvPoolMi?: number;
  moeCacheMi?: number;
  tokensPerSecond?: number;
  decodeTokensPerSecond?: number;
  prefillTokensPerSecond?: number;
  activeRequests?: number;
  completedRequests?: number;
  lifetimeTokens?: number;
  p95LatencyMs?: number;
  ttftMs?: number;
}

export interface ModelActivation {
  metadata?: KubernetesObjectMeta;
  spec?: Record<string, unknown> & {
    type?: string;
    enabled?: boolean;
    local?: Record<string, unknown> & {freetoken?: FreeTokenConfiguration; vllm?: VllmConfiguration; realtime?: RealtimeConfiguration};
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
  computeTargets: ComputeTargetsPayload;
  computeMemory?: {deviceCount?: number; metricsComplete?: boolean; devices?: ComputeMemoryDevice[]; sharedPools?: SharedMemoryPool[]};
  [key: string]: unknown;
}

export interface ModelLogContent {
  previous: boolean;
  text: string;
  error?: string;
  truncated?: boolean;
}

export interface ModelLogContainer {
  name: string;
  kind: 'application' | 'init';
  ready?: boolean;
  restartCount: number;
  state: string;
  reason?: string;
  logs: ModelLogContent[];
}

export interface ModelLogPod {
  name: string;
  phase: string;
  node?: string;
  createdAt?: string;
  deleting: boolean;
  omittedContainers?: number;
  containers: ModelLogContainer[];
}

export interface ModelLogsPayload {
  model: string;
  namespace: string;
  generatedAt: string;
  tailLines: number;
  omittedPods?: number;
  pods: ModelLogPod[];
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
  baseModel?: DiscoveryItem;
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

export interface GpuCompatibilityProfile {
  id: string;
  displayName: string;
  version: string;
  experimental: boolean;
  memoryArchitecture: string;
  expectedArchitecture?: string;
  description?: string;
}

export interface GpuEngineValidation {
  state: 'unverified' | 'queued' | 'running' | 'passed' | 'failed' | 'stale' | 'upstream';
  image?: string;
  imageId?: string;
  kernelVersion?: string;
  driverVersion?: string;
  validatedAt?: string;
  message?: string;
  runtimeReady?: boolean;
  runtimeMessage?: string;
}

export interface GpuCompatibilityNode extends SharedMemoryInventory {
  nodeUid?: string;
  hostBootId?: string;
  profileId?: string;
  profileVersion?: string;
  upstreamSupported?: boolean;
  optedIn?: boolean;
  eligible?: boolean;
  memoryArchitecture?: string;
  expectedArchitecture?: string;
  detectedArchitecture?: string;
  pciDevices?: string[];
  hostDriverReady?: boolean | null;
  resourceRegistered?: boolean;
  message?: string;
  validation?: Record<string, GpuEngineValidation>;
}

export interface GpuCompatibility {
  validationRequired?: boolean;
  schemaVersion: number;
  profiles: GpuCompatibilityProfile[];
  selectedProfile?: string;
  allowExperimental?: boolean;
  nodes: GpuCompatibilityNode[];
}

export interface GpuValidationRequest {
  nodeName: string;
  nodeUid: string;
  engine: 'OLlama' | 'VLLM';
  profileId?: string;
  deviceIds?: string[];
  requestId: string;
  acknowledgeResourceUse: boolean;
}

export interface HardwareGpuDevice {
  id: string;
  node: string;
  nodeUid: string;
  bootId?: string;
  vendor: string;
  module?: string;
  name: string;
  pciAddress: string;
  pciId: string;
  architecture?: string;
  hostDriver?: string;
  hostDriverReady?: boolean | null;
  resourceRegistered?: boolean;
  eligible?: boolean;
  memoryTotalMi?: number | null;
  memoryArchitecture?: string;
  memory?: SharedMemoryInventory;
  validationAvailable: boolean;
  validationReason?: string;
  validationContext?: string;
  validation?: Record<string, GpuEngineValidation>;
}

export interface GpuSharingState {
  provider: 'amd' | 'nvidia';
  backend: 'dra' | 'time-slicing';
  mode: 'exclusive' | 'shared';
  managed: boolean;
  experimental: boolean;
  maxModels: number;
  nodeName: string;
  nodeUid: string;
  namespace: string;
  expectedRevision: string;
  available: boolean;
  reason: string;
  phase: string;
  message: string;
  device?: {name: string; pool: string; pciAddress: string} | null;
  claimName: string;
  activeModels: number;
  admittedModels: string[];
  memoryIsolation: false;
}

export interface GpuSharingRequest {
  provider: 'amd' | 'nvidia';
  mode: 'exclusive' | 'shared';
  maxModels: number;
  nodeName: string;
  nodeUid: string;
  expectedRevision: string;
  acknowledgeSharing: boolean;
  acknowledgeRestart: boolean;
}

export interface HardwareOperator {
  devices?: HardwareGpuDevice[];
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
  compatibility?: GpuCompatibility;
  sharing?: {managed?: boolean; mode?: 'exclusive' | 'time-slicing'; phase?: string; message?: string;
    nodeName?: string; nodeUid?: string; maxModels?: number; slotLimit?: number;
    activeModels?: number; admittedModels?: string[]; memoryIsolation?: false};
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

export type HostAction = 'prepare-gpu' | 'configure-gpu-memory' | 'configure-network' | 'scan-wifi' | 'configure-updates' | 'check-updates' | 'install-updates' | 'clear-model-cache' | 'check-software-channel' | 'apply-software-channel' | 'reboot' | 'poweroff';
export interface NetworkSettings {
  interface: string;
  mode?: 'dhcp' | 'static';
  address?: string;
  gateway?: string;
  dns?: string[];
  metric?: number;
  ssid?: string;
  security?: 'open' | 'wpa-psk';
  password?: string;
  hidden?: boolean;
}
export interface NetworkInterface {
  name: string;
  kind: 'ethernet' | 'wifi';
  mac: string;
  state: string;
  addresses: string[];
  gateway?: string;
  editable: boolean;
  scanSupported: boolean;
  clusterAddresses: string[];
  configuredMode?: 'dhcp' | 'static';
  configuredAddress?: string;
  configuredGateway?: string;
  dns?: string[];
  metric?: number;
  configuredSsid?: string;
  connectedSsid?: string;
  hasPassword?: boolean;
  security?: 'open' | 'wpa-psk';
  hidden?: boolean;
}
export interface HostNetwork {
  id?: string;
  supported: boolean;
  message: string;
  interfaces: NetworkInterface[];
  scan?: {interface: string; observedAt: string; networks: Array<{ssid: string; signal?: number; security: string}>};
}
export interface HostGpuMemorySettings {
  carveoutIndex: number;
  dynamicLimitMi: number;
}
export interface HostGpuMemory {
  id: string;
  supported: boolean;
  message: string;
  pciAddress?: string;
  systemMemoryMi?: number;
  currentCarveoutIndex?: number;
  currentCarveoutMi?: number;
  currentDynamicLimitMi?: number;
  options?: Array<{index: number; label: string; sizeMi: number}>;
  systemReserveMi?: number;
  stepMi?: number;
  minDynamicLimitMi?: number;
}
export interface HostPreparationPlan {
  id: string;
  state: 'not-required' | 'blocked' | 'ready' | 'available';
  message: string;
  profileId: string;
  profileVersion: string;
  gpuProfile: string;
  experimental: boolean;
  experimentMode?: boolean;
  engineValidationAvailable?: boolean;
  displayGpus?: string[];
  packages: Record<string, string>;
  targetKernel: string;
  rebootRequired: boolean;
  experiment?: HostPreparationPlan;
}
export interface HostOperationStatus {
  requestId: string;
  action: HostAction;
  phase: string;
  message?: string;
  updatedAt?: string;
  confirmationDeadline?: string;
}
export interface HostUpdatePolicy {
  mode: 'manual' | 'security' | 'all';
  windowStart: string;
  windowMinutes: number;
  automaticReboot: boolean;
}
export interface HostUpdates {
  supported: boolean;
  id: string;
  policy: HostUpdatePolicy;
  busy: boolean;
  rebootRequired: boolean;
  phase?: string;
  message?: string;
  checkedAt?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  pendingCount?: number;
  securityCount?: number;
  blockedCount?: number;
  truncated?: boolean;
  packages?: Array<{name: string; installed: string; candidate: string; security: boolean; blocked: string}>;
}
export interface HostModelCache {
  supported: boolean;
  blocked: boolean;
  id?: string;
  message?: string;
  totalBytes?: number;
  freeBytes?: number;
  reclaimableBytes: number;
  caches: Array<{id: string; name: string; usedBytes: number; clearable: boolean}>;
}
export interface ManagedHost {
  name: string;
  nodeUid: string;
  bootId: string;
  kernel: string;
  available: boolean;
  observedAt?: string;
  message: string;
  plan?: HostPreparationPlan | null;
  gpuMemory?: HostGpuMemory | null;
  network?: HostNetwork | null;
  updates?: HostUpdates | null;
  modelCache?: HostModelCache | null;
  software?: HostSoftware | null;
  operation?: HostOperationStatus | null;
}
export interface HostOperationRequest {
  action: HostAction;
  nodeName: string;
  nodeUid: string;
  bootId: string;
  requestId: string;
  confirmation: string;
  acknowledgeDisruption: boolean;
  allowExperimental: boolean;
  experimentMode: boolean;
  planId?: string;
  gpuMemory?: HostGpuMemorySettings;
  network?: NetworkSettings;
  updatePolicy?: HostUpdatePolicy;
  updateScope?: 'security' | 'all';
  softwareChannel?: SoftwareChannel;
  softwarePreviewId?: string;
}

export interface SoftwareChannel {kind: 'branch' | 'tag' | 'commit'; value: string}
export interface SoftwarePreview {
  id: string;
  configurationId: string;
  channel: SoftwareChannel;
  commit: string;
  checkedAtEpoch: number;
  ready: boolean;
  images: Array<{name: string; image: string; available: boolean}>;
}
export interface HostSoftware {
  supported: boolean;
  id?: string;
  channel?: SoftwareChannel;
  hostCommit?: string;
  previousCommit?: string;
  busy?: boolean;
  blocked?: boolean;
  message?: string;
  preview?: SoftwarePreview;
  operation?: {requestId: string; phase: string; message?: string};
  observed?: {sourceRevision?: string; appliedRevision?: string; ready?: boolean; checkedAtEpoch?: number;
    images?: Array<{name: string; image: string; imageId: string; ready: boolean}>};
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

export interface MeshRelay {mode: 'auto' | 'public' | 'custom'; url: string}
export interface MeshShare {
  enabled: boolean;
  maxConcurrent: number;
  rpm: number;
  tpm: number;
  maxContext: number;
  maxOutput: number;
  priority: 'low';
}
export interface MeshInvite {
  id: string;
  type: 'magic-stick' | 'client';
  creator: string;
  expiresAt: number;
  createdAt: number;
  usedAt: number | null;
  revoked: boolean;
  token?: string;
}
export interface MeshStatus {
  installed: boolean;
  configured: boolean;
  phase: string;
  authority?: boolean;
  mesh?: {id: string; name: string; authority: string; origin: string} | null;
  node?: {id: string; name: string; type: 'magic-stick' | 'client'} | null;
  nodes?: Array<{id: string; name: string; type: 'magic-stick' | 'client'; online: boolean; revoked: boolean; lastSeen: number}>;
  invites?: MeshInvite[];
  models?: string[];
  shares?: Record<string, MeshShare>;
  imports?: string[];
  relay?: MeshRelay;
  membershipValid?: boolean;
  meshVersion?: string;
  components?: Record<string, string>;
  transport?: string;
  lastError?: string | null;
  lastSync?: number | null;
  metrics?: {
    incoming: {requests: number; errors: number; active: number; queue: number; latencySeconds: number};
    outgoing: {requests: number; errors: number; active: number};
    backends?: {semantics: 'completed_backend_attempts'; byModel: Array<{traffic: 'LOCAL' | 'MESH_REMOTE'; model: string; requests: number; errors: number; latencySeconds: number}>} | null;
    byPeerModel?: Array<{peer: string | null; model: string; requests: number; errors: number; active: number; latencySeconds: number}>;
  };
}
