import type {CleanupAdapter, JournalEntry} from './journal.ts';
import {HarnessError, requireSafe} from './errors.ts';
import {KubectlObserver, type KubeObject} from './observer.ts';
import {poll} from './poll.ts';
import {readPrivate} from './private-files.ts';

const resource = 'modelactivations.appliance.magicstick.dev';
const group = 'appliance.magicstick.dev';

/** Only a namespaced ModelActivation DELETE credential; never an admin kubeconfig. */
export class KubernetesModelCleaner extends KubectlObserver {
  readonly namespace: string;
  constructor(kubeconfig: string, namespace: string, timeoutMs = 15_000) {
    super(kubeconfig, timeoutMs);
    this.namespace = namespace;
    requireSafe(namespace === 'ai-system', 'CONFIG');
  }

  async verifyConfiguration() {
    await readPrivate(this.kubeconfig);
    const data = JSON.parse(await this.command(['config', 'view', '--raw', '--minify', '-o', 'json']));
    const cluster = data.clusters?.[0]?.cluster, user = data.users?.[0]?.user;
    requireSafe(cluster && /^https:\/\//.test(cluster.server) && !cluster['insecure-skip-tls-verify'] &&
      user && !user.exec && !user['auth-provider'], 'OBSERVER');
    const review = JSON.parse(await this.command(['create', '--raw', '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews', '-f', '-'],
      JSON.stringify({apiVersion: 'authorization.k8s.io/v1', kind: 'SelfSubjectRulesReview', spec: {namespace: this.namespace}})));
    verifyModelCleanerRules(review);
  }

  async find(name: string): Promise<KubeObject | null> {
    requireSafe(/^[a-z0-9][a-z0-9-]{0,62}$/.test(name), 'OWNERSHIP');
    const matches = (await this.list(resource, this.namespace)).filter(item => item.metadata.name === name);
    requireSafe(matches.length <= 1, 'OWNERSHIP');
    return matches[0] ?? null;
  }

  async remove(name: string, uid: string, generation: number) {
    const current = await this.find(name);
    requireSafe(current?.metadata.uid === uid && current.metadata.generation === generation &&
      current.metadata.resourceVersion && current.metadata.labels?.['app.kubernetes.io/managed-by'] === 'ai-appliance-dashboard' &&
      ['local', 'external'].includes(String(current.spec?.type)) && current.spec?.targetNamespace === 'ai', 'OWNERSHIP');
    const path = `/apis/${group}/v1alpha1/namespaces/${this.namespace}/modelactivations/${name}`;
    const options = {apiVersion: 'v1', kind: 'DeleteOptions',
      preconditions: {uid, resourceVersion: current.metadata.resourceVersion}};
    try { await this.command(['delete', '--raw', path, '-f', '-'], JSON.stringify(options)); }
    catch { throw new HarnessError('CLEANUP'); }
  }

  adapter(prefix: string, readRemaining: (name: string) => Promise<{podCount: number; catalogCount: number}>,
    heartbeat: () => Promise<void> = async () => {}): CleanupAdapter {
    return {
      lookup: async entry => {
        await heartbeat();
        validateEntry(entry, prefix);
        const item = await this.find(entry.name);
        if (item) requireSafe(item.metadata.generation === entry.generation &&
          item.metadata.labels?.['app.kubernetes.io/managed-by'] === 'ai-appliance-dashboard' &&
          ['local', 'external'].includes(String(item.spec?.type)) && item.spec?.targetNamespace === 'ai', 'OWNERSHIP');
        return item?.metadata.uid ? {uid: item.metadata.uid} : null;
      },
      removeIfUid: async (entry, uid) => {
        await heartbeat();
        validateEntry(entry, prefix);
        requireSafe(entry.uid === uid, 'OWNERSHIP');
        await this.remove(entry.name, uid, entry.generation!);
      },
      verifyRemoved: async entry => {
        validateEntry(entry, prefix);
        await poll(async () => {
          await heartbeat();
          const [item, remaining] = await Promise.all([this.find(entry.name), readRemaining(entry.name)]);
          return {item, remaining};
        }, result => result.item === null && result.remaining.podCount === 0 && result.remaining.catalogCount === 0,
        {timeoutMs: 300_000, intervalMs: 1000, stage: 'cleanup'});
        return true;
      },
    };
  }
}

function validateEntry(entry: JournalEntry, prefix: string) {
  requireSafe(entry.kind === 'model' && entry.name.startsWith(prefix) && entry.uid &&
    Number.isSafeInteger(entry.generation) && Number(entry.generation) > 0, 'OWNERSHIP');
}

export function verifyModelCleanerRules(review: {status?: {incomplete?: boolean; resourceRules?: Array<{
  apiGroups: string[]; resources: string[]; verbs: string[]}>; nonResourceRules?: Array<{verbs: string[]}>}}) {
  requireSafe(review.status?.incomplete === false && Array.isArray(review.status.resourceRules), 'OBSERVER');
  let modelDelete = false;
  for (const rule of review.status.resourceRules) {
    requireSafe(Array.isArray(rule.apiGroups) && Array.isArray(rule.resources) && Array.isArray(rule.verbs), 'OBSERVER');
    const model = rule.apiGroups.length === 1 && rule.apiGroups[0] === group &&
      rule.resources.length === 1 && rule.resources[0] === 'modelactivations';
    const selfReview = rule.apiGroups.every(value => ['authorization.k8s.io', 'authentication.k8s.io'].includes(value)) &&
      rule.resources.every(value => ['selfsubjectaccessreviews', 'selfsubjectrulesreviews', 'selfsubjectreviews'].includes(value));
    requireSafe((model && rule.verbs.every(value => ['get', 'list', 'delete'].includes(value))) ||
      (selfReview && rule.verbs.every(value => value === 'create')), 'OBSERVER');
    if (model && rule.verbs.some(value => String(value) === 'delete')) modelDelete = true;
  }
  requireSafe(modelDelete && (review.status.nonResourceRules ?? []).every(rule =>
    Array.isArray(rule.verbs) && rule.verbs.every(value => value === 'get')), 'OBSERVER');
}
