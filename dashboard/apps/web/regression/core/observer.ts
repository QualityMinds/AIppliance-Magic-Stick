import {spawn} from 'node:child_process';
import {HarnessError, requireSafe} from './errors.ts';
import {readPrivate} from './private-files.ts';
import type {Lease, LeaseStore} from './lease.ts';

interface ContainerStatus {
  name: string; image?: string; imageID?: string; ready?: boolean; restartCount?: number;
  state?: {waiting?: {reason?: string}; terminated?: {exitCode?: number}};
  lastState?: {terminated?: {exitCode?: number}};
}

export interface KubeObject {
  metadata: {uid?: string; name?: string; namespace?: string; generation?: number; resourceVersion?: string;
    creationTimestamp?: string; deletionTimestamp?: string; labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: Array<{uid: string; kind: string; name?: string; controller?: boolean}>};
  spec?: Record<string, unknown>;
  status?: {nodeInfo?: {bootID?: string; kernelVersion?: string}; observedGeneration?: number;
    conditions?: Array<{type: string; status: string; reason?: string; observedGeneration?: number}>; phase?: string;
    readyReplicas?: number; replicas?: number; lastAppliedRevision?: string;
    allocatable?: Record<string, string>; capacity?: Record<string, string>;
    allocation?: Record<string, unknown>; devices?: Record<string, unknown>; active?: number; succeeded?: number; failed?: number;
    containerStatuses?: ContainerStatus[]; initContainerStatuses?: ContainerStatus[]};
}

export function verifyObserverRules(value: {status?: {incomplete?: boolean; resourceRules?: Array<{verbs: string[]; apiGroups: string[]; resources: string[]}>;
  nonResourceRules?: Array<{verbs: string[]}>}}) {
  requireSafe(value.status?.incomplete === false && Array.isArray(value.status.resourceRules), 'OBSERVER');
  for (const rule of value.status.resourceRules) {
    requireSafe(Array.isArray(rule.verbs) && Array.isArray(rule.apiGroups) && Array.isArray(rule.resources), 'OBSERVER');
    const selfReview = rule.apiGroups.every(group => ['authorization.k8s.io', 'authentication.k8s.io'].includes(group)) &&
      rule.resources.every(resource => ['selfsubjectaccessreviews', 'selfsubjectrulesreviews', 'selfsubjectreviews'].includes(resource));
    requireSafe(rule.verbs.every(verb => ['get', 'list', 'watch'].includes(verb) || (verb === 'create' && selfReview)), 'OBSERVER');
    // GET on exec/attach/proxy subresources can perform actions. No subresource
    // or wildcard grants are needed by this observer's declared read contract.
    requireSafe(!rule.resources.some(resource => resource === 'secrets' || resource.includes('*') || resource.includes('/')), 'OBSERVER');
  }
  for (const rule of value.status.nonResourceRules ?? []) {
    requireSafe(Array.isArray(rule.verbs) && rule.verbs.every(verb => verb === 'get'), 'OBSERVER');
  }
}

/** No shell, no Secret reads, no exec/log collection. Output stays in memory. */
export class KubectlObserver {
  readonly kubeconfig: string;
  readonly timeoutMs: number;
  constructor(kubeconfig: string, timeoutMs = 15_000) {
    this.kubeconfig = kubeconfig; this.timeoutMs = timeoutMs;
  }
  protected command(arguments_: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('kubectl', ['--kubeconfig', this.kubeconfig, `--request-timeout=${this.timeoutMs}ms`, ...arguments_],
        {stdio: ['pipe', 'pipe', 'pipe'], env: {...process.env, KUBECONFIG: this.kubeconfig}});
      let stdout = '', stderrBytes = 0, settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); };
      const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new HarnessError('OBSERVER')); }, this.timeoutMs + 1000);
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString(); if (stdout.length > 8 * 1024 * 1024) { child.kill('SIGKILL'); finish(new HarnessError('OBSERVER')); }
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 1024 * 1024) child.kill('SIGKILL'); });
      child.on('error', () => finish(new HarnessError('OBSERVER')));
      child.stdin.on('error', () => finish(new HarnessError('OBSERVER')));
      child.on('close', code => finish(code === 0 ? undefined : new HarnessError('OBSERVER')));
      child.stdin.end(input);
    });
  }
  async verifyConfiguration() {
    await readPrivate(this.kubeconfig);
    // Inspect the selected context without printing raw tokens/certificates.
    const data = JSON.parse(await this.command(['config', 'view', '--raw', '--minify', '-o', 'json']));
    const cluster = data.clusters?.[0]?.cluster;
    const user = data.users?.[0]?.user;
    requireSafe(cluster && /^https:\/\//.test(cluster.server) && !cluster['insecure-skip-tls-verify'] && user &&
      !user.exec && !user['auth-provider'], 'OBSERVER');
    const server = new URL(cluster.server);
    requireSafe(!server.username && !server.password && !server.search && !server.hash, 'OBSERVER');
    // Review every namespace as well as cluster-scoped permissions. A namespace
    // admin must not be mistaken for a read-only observer by an all-namespace probe.
    for (const namespace of await this.list('namespaces')) {
      requireSafe(namespace.metadata.name, 'OBSERVER');
      const result = JSON.parse(await this.command(['create', '--raw', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', '-f', '-'], JSON.stringify({
        apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: {namespace: namespace.metadata.name},
      })));
      verifyObserverRules(result);
    }
  }
  async get(resource: string, namespace?: string, name?: string): Promise<KubeObject> {
    requireSafe(/^[a-z][a-z0-9.]*$/.test(resource) && !resource.includes('secret') &&
      (!namespace || /^[a-z0-9-]+$/.test(namespace)) && (!name || /^[a-z0-9.-]+$/.test(name)), 'OBSERVER');
    const args = ['get', resource, ...(name ? [name] : []), ...(namespace ? ['-n', namespace] : ['-A']), '-o', 'json'];
    try { return JSON.parse(await this.command(args)); } catch { throw new HarnessError('OBSERVER'); }
  }
  async list(resource: string, namespace?: string): Promise<KubeObject[]> {
    const value = await this.get(resource, namespace) as unknown as {items: KubeObject[]};
    requireSafe(Array.isArray(value.items), 'OBSERVER');
    return value.items;
  }
}

/** Separate lock credentials can update ONE precreated Lease, not product objects. */
export class KubernetesLeaseStore extends KubectlObserver implements LeaseStore {
  private readonly namespace: string;
  private readonly name: string;
  constructor(kubeconfig: string, namespace: string, name: string, timeoutMs = 15_000) {
    super(kubeconfig, timeoutMs);
    this.namespace = namespace; this.name = name;
    requireSafe(namespace === 'magicstick-regression' && name === 'lab-lock', 'CONFIG');
  }
  async read(): Promise<Lease> { return await this.get('leases.coordination.k8s.io', this.namespace, this.name) as unknown as Lease; }
  async replace(lease: Lease): Promise<Lease> {
    requireSafe(lease.metadata.namespace === this.namespace && lease.metadata.name === this.name && lease.metadata.resourceVersion, 'LOCK_LOST');
    return JSON.parse(await this.command(['replace', '-f', '-', '-o', 'json'], JSON.stringify(lease)));
  }
}
