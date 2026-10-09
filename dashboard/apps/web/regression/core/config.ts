import {isAbsolute, resolve} from 'node:path';
import {readPrivate} from './private-files.ts';
import {HarnessError, requireSafe} from './errors.ts';
import type {RealtimeConfiguration,NvidiaGpuSelection,VllmConfiguration} from '@magicstick/dashboard-contracts';

export interface LocalModelFixture {
  engine: 'OLlama' | 'VLLM';
  computeTarget: 'cpu';
  url: string;
  memoryRequiredMi: number;
  contextWindow: number;
  maxNumSeqs: 1;
  kvCacheType?: string;
  realtime?: RealtimeConfiguration;
}

/** Explicit, bounded GPU fixtures. Never inherited by CPU smoke profiles. */
export interface GpuModelFixture {
  engine: 'OLlama' | 'VLLM';
  computeTarget: 'amd-gpu' | 'nvidia-gpu';
  url: string;
  memoryRequiredMi: number;
  contextWindow: number;
  maxNumSeqs: 1;
  kvCacheType?: string;
  realtime?: RealtimeConfiguration;
  /** Derived from current DRA inventory by the registered-lab multi-GPU case. */
  gpuDevices?: NvidiaGpuSelection[];
  gpuDeployment?: 'split' | 'replicated';
  systemMemoryMi?: number;
  vllm?: VllmConfiguration;
}
export type RuntimeModelFixture = LocalModelFixture | GpuModelFixture;
export interface GpuLabProfile {
  /** Current task explicitly authorizes temporary backend transitions. */
  acknowledgeSharingTransitions: true;
  nodeName: string;
  nodeUid: string;
  bootId: string;
  selection?:'available-providers';
  devices: {amd?: {id: string; pciAddress: string}; nvidia?: {id: string; pciAddress: string}};
  models: {amdOllama?: GpuModelFixture; amdVllm?: GpuModelFixture;
    nvidiaOllama?: GpuModelFixture; nvidiaVllm?: GpuModelFixture};
  sharedSlots: 2;
}

export type ExternalModelFixture = {
  apiBase: string;
  contextWindow: number;
} & ({source?: 'configured'; model: string; apiKeyFile?: string} |
  {source: 'owned-ollama'; model?: never; apiKeyFile?: never});

export interface LabConfig {
  version: 1;
  profile: 'preflight';
  dashboardUrl: string;
  identityUrl: string;
  inferenceUrl?: string;
  caFile?: string;
  /** Both a private registration and the independently observed server marker
   * are required for live writes. Reboots do not change this identity. */
  registrationFile?:string;
  usernameFile: string;
  passwordFile: string;
  observerKubeconfig: string;
  requestTimeoutMs: number;
  loginTimeoutMs: number;
  expected: {
    applianceUid: string;
    applianceNamespace: string;
    applianceName: string;
    role: 'magicstick-admin';
    nodes: Array<{name: string; uid: string; bootId?: string}>;
    capabilities: Array<{target: string; engines: string[]}>;
    flux?: {namespace: string; name: string; revision: string};
    images: Array<{namespace: string; deployment: string; container: string; digest: string}>;
  };
  /** A missing/expired holder is inspected, never stolen by the harness. */
  lock?: {namespace: string; name: string; kubeconfig: string};
  /** Separate namespaced delete-only credential; never the observer or admin account. */
  modelCleanupKubeconfig?: string;
  smokeModel?: LocalModelFixture & {engine: 'OLlama'};
  phase2?: {
    ollamaModel: LocalModelFixture & {engine: 'OLlama'};
    vllmModel: LocalModelFixture & {engine: 'VLLM'};
    failureModel: LocalModelFixture & {engine: 'OLlama'; expectedReason: string};
    externalModel: ExternalModelFixture;
    discovery: {query: string; repo: string; artifactUrl: string};
  };
  gpu?: GpuLabProfile;
}

function object(value: unknown): Record<string, unknown> {
  requireSafe(value && typeof value === 'object' && !Array.isArray(value), 'CONFIG');
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern = /^[a-zA-Z0-9][a-zA-Z0-9._:@/+-]{0,255}$/): string {
  requireSafe(typeof value === 'string' && pattern.test(value) && !value.includes('CHANGEME'), 'CONFIG');
  return value;
}
function hostname(value: unknown): string {
  const result = text(value, /^https:\/\/[^\s]+$/);
  let url;
  try { url = new URL(result); } catch { throw new HarnessError('CONFIG'); }
  requireSafe(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'CONFIG');
  return url.origin;
}
function endpoint(value: unknown, ownedProvider = false): string {
  const result = text(value, /^https?:\/\/[^\s]+$/);
  let url;
  try { url = new URL(result); } catch { throw new HarnessError('CONFIG'); }
  const internalProvider = ownedProvider && url.protocol === 'http:' &&
    /^[a-z0-9-]+\.[a-z0-9-]+\.svc\.cluster\.local$/.test(url.hostname) &&
    (!url.port || url.port === '80') && url.pathname === '/openai/v1';
  requireSafe((url.protocol === 'https:' || internalProvider) && !url.username && !url.password && !url.search && !url.hash &&
    url.pathname.startsWith('/') && !url.pathname.includes('//'), 'CONFIG');
  return url.href.replace(/\/$/, '');
}
function array(value: unknown): unknown[] {
  requireSafe(Array.isArray(value) && value.length <= 64, 'CONFIG');
  return value;
}
function path(value: unknown, directory: string): string {
  requireSafe(typeof value === 'string' && value.length > 0 && value.length < 4096 && !/[\r\n\0]/.test(value), 'CONFIG');
  return isAbsolute(value) ? value : resolve(directory, value);
}
function timeout(value: unknown, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  requireSafe(Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= maximum, 'CONFIG');
  return Number(value);
}

export function parseLabConfig(value: unknown, directory: string): LabConfig {
  const source = object(value), expected = object(source.expected);
  requireSafe(source.version === 1 && source.profile === 'preflight' && expected.role === 'magicstick-admin', 'CONFIG');
  const nodes = array(expected.nodes).map(item => {
    const node = object(item);
    return {name: text(node.name), uid: text(node.uid), ...(node.bootId ? {bootId: text(node.bootId)} : {})};
  });
  requireSafe(nodes.length > 0 && new Set(nodes.map(node => node.name)).size === nodes.length, 'CONFIG');
  const capabilities = array(expected.capabilities).map(item => {
    const capability = object(item);
    const engines = array(capability.engines).map(engine => text(engine));
    requireSafe(engines.length > 0, 'CONFIG');
    return {target: text(capability.target), engines};
  });
  // Base identity/API tests can still run when no inference runtime is ready.
  // Only the registered automatic policy permits this partial inventory.
  requireSafe(capabilities.length > 0 || typeof source.registrationFile === 'string', 'CONFIG');
  const images = array(expected.images ?? []).map(item => {
    const image = object(item);
    return {namespace: text(image.namespace), deployment: text(image.deployment), container: text(image.container),
      digest: text(image.digest, /^sha256:[0-9a-f]{64}$/)};
  });
  let flux: LabConfig['expected']['flux'];
  if (expected.flux) {
    const selection = object(expected.flux);
    flux = {namespace: text(selection.namespace), name: text(selection.name), revision: text(selection.revision)};
  }
  let lock: LabConfig['lock'];
  if (source.lock) {
    const selection = object(source.lock);
    requireSafe(selection.namespace === 'magicstick-regression', 'CONFIG');
    requireSafe(selection.name === 'lab-lock', 'CONFIG');
    lock = {namespace: 'magicstick-regression', name: 'lab-lock', kubeconfig: path(selection.kubeconfig, directory)};
  }
  const localModel = (value: unknown, engine: LocalModelFixture['engine'], maximumMemoryMi = 32768,
    maximumContextWindow = 8192): LocalModelFixture => {
    const selection = object(value);
    const urlPattern = engine === 'OLlama' ? /^ollama:\/\/[a-zA-Z0-9._:/+-]{1,200}$/ : /^hf:\/\/[a-zA-Z0-9._/+-]{3,200}$/;
    requireSafe(selection.engine === engine && selection.computeTarget === 'cpu' && selection.maxNumSeqs === 1 &&
      Number.isSafeInteger(selection.memoryRequiredMi) && Number(selection.memoryRequiredMi) >= 1024 && Number(selection.memoryRequiredMi) <= maximumMemoryMi &&
      Number.isSafeInteger(selection.contextWindow) && Number(selection.contextWindow) >= 256 && Number(selection.contextWindow) <= maximumContextWindow, 'CONFIG');
    const kvCacheType = selection.kvCacheType === undefined ? undefined : text(selection.kvCacheType, /^[a-z0-9_]{2,16}$/);
    return {engine, computeTarget: 'cpu', url: text(selection.url, urlPattern), memoryRequiredMi: Number(selection.memoryRequiredMi),
      contextWindow: Number(selection.contextWindow), maxNumSeqs: 1, ...(kvCacheType ? {kvCacheType} : {})};
  };
  let smokeModel: LabConfig['smokeModel'];
  if (source.smokeModel) {
    smokeModel = localModel(source.smokeModel, 'OLlama', 8192, 4096) as LabConfig['smokeModel'];
  }
  let phase2: LabConfig['phase2'];
  if (source.phase2) {
    const selection = object(source.phase2);
    requireSafe(Object.keys(selection).sort().join(',') === 'discovery,externalModel,failureModel,ollamaModel,vllmModel', 'CONFIG');
    const failure = object(selection.failureModel), external = object(selection.externalModel), discovery = object(selection.discovery);
    const failureModel = localModel(selection.failureModel, 'OLlama') as NonNullable<LabConfig['phase2']>['failureModel'];
    failureModel.expectedReason = text(failure.expectedReason, /^[a-zA-Z0-9][a-zA-Z0-9 ._:/()+-]{2,159}$/);
    requireSafe(external.source === undefined || external.source === 'configured' || external.source === 'owned-ollama', 'CONFIG');
    const ownedProvider = external.source === 'owned-ollama';
    if (ownedProvider) requireSafe(external.model === undefined && external.apiKeyFile === undefined, 'CONFIG');
    const externalModel: ExternalModelFixture = ownedProvider
      ? {source: 'owned-ollama', apiBase: endpoint(external.apiBase, true), contextWindow: Number(external.contextWindow)}
      : {model: text(external.model), apiBase: endpoint(external.apiBase), contextWindow: Number(external.contextWindow),
        ...(external.apiKeyFile ? {apiKeyFile: path(external.apiKeyFile, directory)} : {})};
    requireSafe(Number.isSafeInteger(externalModel.contextWindow) && externalModel.contextWindow >= 256 &&
      externalModel.contextWindow <= 1_048_576, 'CONFIG');
    const query = text(discovery.query, /^[a-zA-Z0-9][a-zA-Z0-9 ._:/+-]{1,79}$/);
    const repo = text(discovery.repo, /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
    const artifactUrl = text(discovery.artifactUrl, /^hf:\/\/[a-zA-Z0-9._/+-]{3,200}$/);
    phase2 = {ollamaModel: localModel(selection.ollamaModel, 'OLlama') as NonNullable<LabConfig['phase2']>['ollamaModel'],
      vllmModel: localModel(selection.vllmModel, 'VLLM') as NonNullable<LabConfig['phase2']>['vllmModel'],
      failureModel, externalModel, discovery: {query, repo, artifactUrl}};
  }
  let gpu: GpuLabProfile | undefined;
  if (source.gpu) {
    const selection = object(source.gpu), devices = object(selection.devices), models = object(selection.models);
    const available=selection.selection === 'available-providers' && typeof source.registrationFile === 'string';
    requireSafe(selection.acknowledgeSharingTransitions === true && selection.sharedSlots === 2 &&
      (available ? Object.keys(selection).sort().join(',') === 'acknowledgeSharingTransitions,bootId,devices,models,nodeName,nodeUid,selection,sharedSlots' &&
        Object.keys(devices).length > 0 && Object.keys(devices).every(key=>['amd','nvidia'].includes(key)) &&
        Object.keys(models).every(key=>['amdOllama','amdVllm','nvidiaOllama','nvidiaVllm'].includes(key)) :
      Object.keys(selection).sort().join(',') === 'acknowledgeSharingTransitions,bootId,devices,models,nodeName,nodeUid,sharedSlots' &&
      Object.keys(devices).sort().join(',') === 'amd,nvidia' &&
      Object.keys(models).sort().join(',') ===
        ['amdOllama','amdVllm','nvidiaOllama','nvidiaVllm'].join(',')), 'CONFIG');
    const device = (value: unknown) => {const d = object(value);requireSafe(Object.keys(d).sort().join(',') === 'id,pciAddress','CONFIG'); return {id: text(d.id, /^[a-zA-Z0-9._:/-]{1,255}$/),
      pciAddress: text(d.pciAddress, /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/)}};
    const gpuModel = (value: unknown, engine: GpuModelFixture['engine'], target: GpuModelFixture['computeTarget']): GpuModelFixture => {
      const m = object(value);
      requireSafe(m.engine === engine && m.computeTarget === target && m.maxNumSeqs === 1 &&
        Number.isSafeInteger(m.contextWindow) && Number(m.contextWindow) >= 256 && Number(m.contextWindow) <= 4096 &&
        Number.isSafeInteger(m.memoryRequiredMi) && Number(m.memoryRequiredMi) >= 1024 && Number(m.memoryRequiredMi) <= 32768 &&
        Object.keys(m).every(key => ['engine','computeTarget','url','contextWindow','maxNumSeqs','memoryRequiredMi','kvCacheType'].includes(key)), 'CONFIG');
      const url = text(m.url, engine === 'OLlama' ? /^ollama:\/\/[a-zA-Z0-9._:/+-]{1,200}$/ : /^hf:\/\/[a-zA-Z0-9._/+-]{3,200}$/);
      requireSafe(['f16','q8_0','auto','fp8'].includes(String(m.kvCacheType)), 'CONFIG');
      return {engine,computeTarget:target,url,contextWindow:Number(m.contextWindow),maxNumSeqs:1,memoryRequiredMi:Number(m.memoryRequiredMi),
        kvCacheType:String(m.kvCacheType)};
    };
    gpu = {acknowledgeSharingTransitions:true,nodeName:text(selection.nodeName),nodeUid:text(selection.nodeUid),bootId:text(selection.bootId),
      ...(available ? {selection:'available-providers' as const} : {}),
      devices:{...(devices.amd ? {amd:device(devices.amd)} : {}),...(devices.nvidia ? {nvidia:device(devices.nvidia)} : {})},sharedSlots:2,
      models:{...(models.amdOllama ? {amdOllama:gpuModel(models.amdOllama,'OLlama','amd-gpu')} : {}),
        ...(models.amdVllm ? {amdVllm:gpuModel(models.amdVllm,'VLLM','amd-gpu')} : {}),
        ...(models.nvidiaOllama ? {nvidiaOllama:gpuModel(models.nvidiaOllama,'OLlama','nvidia-gpu')} : {}),
        ...(models.nvidiaVllm ? {nvidiaVllm:gpuModel(models.nvidiaVllm,'VLLM','nvidia-gpu')} : {})}};

    requireSafe((!models.amdOllama && !models.amdVllm || devices.amd) &&
      (!models.nvidiaOllama && !models.nvidiaVllm || devices.nvidia),'CONFIG');
    requireSafe(nodes.some(node => node.name === gpu!.nodeName && node.uid === gpu!.nodeUid && node.bootId === gpu!.bootId), 'CONFIG');
  }
  return {version: 1, profile: 'preflight', dashboardUrl: hostname(source.dashboardUrl), identityUrl: hostname(source.identityUrl),
    ...(source.inferenceUrl ? {inferenceUrl: hostname(source.inferenceUrl)} : {}),
    ...(source.caFile ? {caFile: path(source.caFile, directory)} : {}),
    ...(source.registrationFile ? {registrationFile:path(source.registrationFile,directory)} : {}),
    usernameFile: path(source.usernameFile, directory), passwordFile: path(source.passwordFile, directory),
    observerKubeconfig: path(source.observerKubeconfig, directory),
    requestTimeoutMs: timeout(source.requestTimeoutMs, 15_000, 60_000), loginTimeoutMs: timeout(source.loginTimeoutMs, 90_000, 180_000),
    expected: {applianceUid: text(expected.applianceUid), applianceNamespace: text(expected.applianceNamespace),
      applianceName: text(expected.applianceName), role: 'magicstick-admin', nodes, capabilities, images, ...(flux ? {flux} : {})},
    ...(lock ? {lock} : {}),
    ...(source.modelCleanupKubeconfig ? {modelCleanupKubeconfig: path(source.modelCleanupKubeconfig, directory)} : {}),
    ...(smokeModel ? {smokeModel} : {}), ...(phase2 ? {phase2} : {}), ...(gpu ? {gpu} : {})};
}

export async function loadLabConfig(filename: string) {
  try { return parseLabConfig(JSON.parse(await readPrivate(filename)), resolve(filename, '..')); }
  catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('CONFIG'); }
}
