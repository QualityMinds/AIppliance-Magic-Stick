import {HarnessError} from './errors.ts';
import type {KubeObject, KubectlObserver} from './observer.ts';

export interface GatewayProcess {
  uid: string;
  containerId: string;
  restarts: number;
  ready: boolean;
  lastExitCode?: number;
}
export interface GatewaySnapshot {version: 1; processes: GatewayProcess[]}

function failure(): never { throw new HarnessError('API', 'Failed', 'gateway-ready'); }

/** Only process identity and bounded state; never logs, headers, tokens or config dumps. */
export function gatewayProcessSnapshot(pods: readonly KubeObject[]): GatewaySnapshot {
  const proxies = pods.filter(pod => pod.metadata.namespace === 'envoy-gateway-system' &&
    pod.metadata.labels?.['app.kubernetes.io/managed-by'] === 'envoy-gateway' &&
    pod.metadata.labels?.['app.kubernetes.io/component'] === 'proxy');
  if (!proxies.length || proxies.length > 32) failure();
  const processes = proxies.map(pod => {
    const containers = pod.status?.containerStatuses?.filter(item => item.name === 'envoy') ?? [];
    if (!pod.metadata.uid || containers.length !== 1) failure();
    const container = containers[0]!;
    if (!container.containerID || !Number.isSafeInteger(container.restartCount) || container.restartCount! < 0) failure();
    const lastExitCode = container.lastState?.terminated?.exitCode;
    if (lastExitCode !== undefined && (!Number.isInteger(lastExitCode) || lastExitCode < 0 || lastExitCode > 255)) failure();
    return {uid: pod.metadata.uid, containerId: container.containerID, restarts: container.restartCount!,
      ready: !pod.metadata.deletionTimestamp && pod.status?.phase === 'Running' && container.ready === true &&
        container.state?.running !== undefined && pod.status.conditions?.some(item => item.type === 'Ready' && item.status === 'True') === true,
      ...(lastExitCode === undefined ? {} : {lastExitCode})};
  }).sort((a, b) => a.uid.localeCompare(b.uid));
  if (new Set(processes.map(item => item.uid)).size !== processes.length) failure();
  return {version: 1, processes};
}

/** A route/policy transition must not restart or silently replace the shared gateway. */
export function assertGatewayStable(before: GatewaySnapshot, after: GatewaySnapshot): void {
  if (before.version !== 1 || after.version !== 1 || !before.processes.length ||
      before.processes.length !== after.processes.length) failure();
  const current = new Map(after.processes.map(item => [item.uid, item]));
  if (current.size !== after.processes.length) failure();
  for (const original of before.processes) {
    const observed = current.get(original.uid);
    if (!original.ready || !observed?.ready || original.containerId !== observed.containerId ||
        original.restarts !== observed.restarts || original.lastExitCode !== observed.lastExitCode) failure();
  }
}

/** Establish a healthy baseline before mutation; fail closed if observation is unavailable. */
export async function gatewaySnapshot(observer: Pick<KubectlObserver, 'list'>): Promise<GatewaySnapshot> {
  try {
    const snapshot = gatewayProcessSnapshot(await observer.list('pods', 'envoy-gateway-system'));
    assertGatewayStable(snapshot, snapshot);
    return snapshot;
  } catch { failure(); }
}
