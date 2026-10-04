import {request as httpsRequest} from 'node:https';
import {createHash} from 'node:crypto';
import type {Appliance, ManagedHost, ModelsPayload} from '@magicstick/dashboard-contracts';
import type {LabConfig} from './config.ts';
import type {KubeObject, KubectlObserver} from './observer.ts';
import {HarnessError, requireSafe} from './errors.ts';

export async function verifiedEndpoint(url: string, timeoutMs: number, ca?: string): Promise<void> {
  requireSafe(new URL(url).protocol === 'https:', 'TLS');
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(url, {method: 'HEAD', ...(ca ? {ca} : {})}, response => {
      // Authentication redirects/401 are expected here. Only connectivity/TLS is accepted.
      response.resume(); resolve();
    });
    const timer = setTimeout(() => { request.destroy(); reject(new HarnessError('TLS')); }, timeoutMs);
    request.on('error', () => { clearTimeout(timer); reject(new HarnessError('TLS')); });
    request.on('response', () => clearTimeout(timer));
    request.end();
  });
}

export function verifyIdentity(config: LabConfig, appliance: Appliance, observedAppliance: KubeObject, nodes: KubeObject[], hosts: ManagedHost[]) {
  requireSafe(appliance.metadata?.uid === config.expected.applianceUid && observedAppliance.metadata.uid === config.expected.applianceUid &&
    appliance.metadata.name === config.expected.applianceName && appliance.metadata.namespace === config.expected.applianceNamespace, 'IDENTITY');
  for (const expected of config.expected.nodes) {
    const node = nodes.find(item => item.metadata.name === expected.name), host = hosts.find(item => item.name === expected.name);
    requireSafe(node?.metadata.uid === expected.uid && host?.nodeUid === expected.uid, 'IDENTITY');
    const bootId = node.status?.nodeInfo?.bootID;
    if (!bootId || host.bootId !== bootId || (expected.bootId && expected.bootId !== bootId)) {
      throw new HarnessError('HOST', 'Blocked', 'host-boot');
    }
    if (!node.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True') || host.available !== true) {
      throw new HarnessError('HOST', 'Blocked', 'host-readiness');
    }
  }
}

export function verifyCapabilities(config: LabConfig, models: ModelsPayload) {
  requireSafe(Array.isArray(models.computeTargets?.targets) && Array.isArray(models.activations), 'API');
  for (const expected of config.expected.capabilities) {
    const target = models.computeTargets.targets.find(item => item.id === expected.target);
    requireSafe(target?.available === true && expected.engines.every(engine => target.engines?.includes(engine) &&
      target.engineAvailability?.[engine]?.available !== false), 'CAPABILITY');
  }
}

export function verifyIdle(hosts: ManagedHost[], models: ModelsPayload, config: LabConfig) {
  const selected = new Set(config.expected.nodes.map(item => item.name));
  const terminal = new Set(['Succeeded', 'Failed', 'Cancelled']);
  requireSafe(hosts.filter(host => selected.has(host.name)).every(host => !host.updates?.busy && !host.software?.busy &&
    (!host.operation || terminal.has(host.operation.phase))), 'BUSY');
  // Phase 0 is conservative: active local definitions, even without a Pod, block it.
  requireSafe(models.activations.every(item => item.spec?.type !== 'local' || item.spec?.enabled === false), 'BUSY');
}

export async function verifyDeploymentPins(config: LabConfig, observer: Pick<KubectlObserver, 'get' | 'list'>,
  pods: KubeObject[], flux: KubeObject[]) {
  if (config.expected.flux) {
    const expected = config.expected.flux;
    const item = flux.find(entry => entry.metadata.name === expected.name && entry.metadata.namespace === expected.namespace);
    requireSafe(item?.status?.lastAppliedRevision === expected.revision && item.status.conditions?.some(condition =>
      condition.type === 'Ready' && condition.status === 'True' &&
      (condition.observedGeneration ?? item.status?.observedGeneration) === item.metadata.generation), 'REVISION');
  }
  for (const expected of config.expected.images) {
    const deployment = await observer.get('deployments.apps', expected.namespace, expected.deployment);
    const replicasets = await observer.list('replicasets.apps', expected.namespace);
    const owners = new Set(replicasets.filter(item => item.metadata.ownerReferences?.some(owner => owner.uid === deployment.metadata.uid))
      .map(item => item.metadata.uid));
    const containers = pods.filter(item => item.metadata.namespace === expected.namespace && item.metadata.ownerReferences?.some(owner => owners.has(owner.uid)))
      .flatMap(item => item.status?.containerStatuses ?? []).filter(item => item.name === expected.container);
    requireSafe(deployment.metadata.generation === deployment.status?.observedGeneration &&
      Number(deployment.status?.readyReplicas) > 0 && containers.length > 0 &&
      containers.every(item => item.ready && item.imageID?.endsWith(expected.digest)), 'REVISION');
  }
}

export function safeBaseline(config: LabConfig, nodes: KubeObject[], pods: KubeObject[], models: ModelsPayload, flux: KubeObject[]) {
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
  return {version: 1, targetFingerprint: fingerprint(config.expected.applianceUid),
    nodes: config.expected.nodes.map((expected, index) => {
      const node = nodes.find(item => item.metadata.uid === expected.uid)!;
      return {alias: `node-${index + 1}`, uidFingerprint: fingerprint(expected.uid), bootFingerprint: fingerprint(node.status?.nodeInfo?.bootID ?? ''),
        kernel: /^[0-9a-zA-Z.+-]+$/.test(node.status?.nodeInfo?.kernelVersion ?? '') ? node.status?.nodeInfo?.kernelVersion : 'unknown'};
    }),
    computeTargets: models.computeTargets.targets.map(item => ({id: /^[a-z0-9-]+$/.test(item.id) ? item.id : 'unknown', available: item.available === true,
      engines: (item.engines ?? []).filter(engine => /^[a-zA-Z0-9-]+$/.test(engine))})),
    imageDigests: [...new Set(pods.flatMap(pod => (pod.status?.containerStatuses ?? []).map(container =>
      container.imageID?.match(/sha256:[0-9a-f]{64}/)?.[0]).filter((digest): digest is string => Boolean(digest))))].sort(),
    fluxRevisions: [...new Set(flux.map(item => item.status?.lastAppliedRevision?.match(/(?:sha1:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/)?.[0])
      .filter((revision): revision is string => Boolean(revision)))],
    pins: {flux: Boolean(config.expected.flux), criticalImages: config.expected.images.length, bootIds: config.expected.nodes.filter(item => item.bootId).length},
    nonTestDefinitions: models.activations.length, observedPodCount: pods.length,
    mutationsEnabled: false, cleanupAdaptersEnabled: false};
}
