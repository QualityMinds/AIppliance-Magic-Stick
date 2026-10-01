import {isAbsolute, resolve} from 'node:path';
import {readPrivate} from './private-files.ts';
import {HarnessError, requireSafe} from './errors.ts';

export interface LabConfig {
  version: 1;
  profile: 'preflight';
  dashboardUrl: string;
  identityUrl: string;
  inferenceUrl?: string;
  caFile?: string;
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
  smokeModel?: {engine: 'OLlama'; computeTarget: 'cpu'; url: string; memoryRequiredMi: number; contextWindow: number; maxNumSeqs: 1};
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
  requireSafe(capabilities.length > 0, 'CONFIG');
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
  let smokeModel: LabConfig['smokeModel'];
  if (source.smokeModel) {
    const selection = object(source.smokeModel);
    requireSafe(selection.engine === 'OLlama' && selection.computeTarget === 'cpu' && selection.maxNumSeqs === 1 &&
      Number.isSafeInteger(selection.memoryRequiredMi) && Number(selection.memoryRequiredMi) >= 1024 && Number(selection.memoryRequiredMi) <= 8192 &&
      Number.isSafeInteger(selection.contextWindow) && Number(selection.contextWindow) >= 256 && Number(selection.contextWindow) <= 4096, 'CONFIG');
    smokeModel = {engine: 'OLlama', computeTarget: 'cpu', url: text(selection.url, /^ollama:\/\/[a-zA-Z0-9._:/+-]{1,200}$/),
      memoryRequiredMi: Number(selection.memoryRequiredMi), contextWindow: Number(selection.contextWindow), maxNumSeqs: 1};
  }
  return {version: 1, profile: 'preflight', dashboardUrl: hostname(source.dashboardUrl), identityUrl: hostname(source.identityUrl),
    ...(source.inferenceUrl ? {inferenceUrl: hostname(source.inferenceUrl)} : {}),
    ...(source.caFile ? {caFile: path(source.caFile, directory)} : {}),
    usernameFile: path(source.usernameFile, directory), passwordFile: path(source.passwordFile, directory),
    observerKubeconfig: path(source.observerKubeconfig, directory),
    requestTimeoutMs: timeout(source.requestTimeoutMs, 15_000, 60_000), loginTimeoutMs: timeout(source.loginTimeoutMs, 90_000, 180_000),
    expected: {applianceUid: text(expected.applianceUid), applianceNamespace: text(expected.applianceNamespace),
      applianceName: text(expected.applianceName), role: 'magicstick-admin', nodes, capabilities, images, ...(flux ? {flux} : {})},
    ...(lock ? {lock} : {}),
    ...(source.modelCleanupKubeconfig ? {modelCleanupKubeconfig: path(source.modelCleanupKubeconfig, directory)} : {}),
    ...(smokeModel ? {smokeModel} : {})};
}

export async function loadLabConfig(filename: string) {
  try { return parseLabConfig(JSON.parse(await readPrivate(filename)), resolve(filename, '..')); }
  catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('CONFIG'); }
}
