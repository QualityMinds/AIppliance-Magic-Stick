import type {Browser, BrowserContext} from '@playwright/test';
import type {LabConfig, LocalModelFixture} from './config.ts';
import {realLogin, type RealLoginOptions} from './auth.ts';
import {readOnlyApi} from './transport.ts';
import {KubernetesLeaseStore, KubectlObserver} from './observer.ts';
import {KubernetesModelCleaner} from './model-cleanup.ts';
import {LabLease} from './lease.ts';
import {ResourceJournal} from './journal.ts';
import {OwnedKeyClient} from './owned-key.ts';
import {OwnedModelClient, activation, fixtureIsAdvertised, ownedRuntimePods, remainingModelResources} from './owned-model.ts';
import {verifyIdentity, verifyCapabilities, verifyIdle, verifyDeploymentPins} from './preflight.ts';
import {requirePhase0Profile} from '../profiles/phase0-p0.ts';
import {poll} from './poll.ts';
import {requireSafe} from './errors.ts';

/** Shared foundation adapter: no GPU, host-maintenance or product-setting writes. */
export class LiveFoundation {
  readonly context: BrowserContext;
  readonly config: LabConfig;
  readonly journal: ResourceJournal;
  readonly snapshot: Awaited<ReturnType<typeof LiveFoundation.snapshot>>;
  readonly observer: KubectlObserver;
  readonly cleaner: KubernetesModelCleaner;
  readonly store: KubernetesLeaseStore;
  readonly lease: LabLease;
  readonly api;
  readonly keys: OwnedKeyClient;
  readonly journals: ResourceJournal[];
  readonly baselineKeyIds: Set<string>;
  private beatAt = Date.now();
  private beat: Promise<void> | undefined;
  private acquired = false;

  private constructor(context: BrowserContext, config: LabConfig, journal: ResourceJournal,
    snapshot: Awaited<ReturnType<typeof LiveFoundation.snapshot>>, baselineKeyIds: Set<string>) {
    this.context = context; this.config = config; this.journal = journal; this.snapshot = snapshot;
    this.observer = snapshot.observer;
    this.cleaner = new KubernetesModelCleaner(config.modelCleanupKubeconfig!, config.expected.applianceNamespace, config.requestTimeoutMs);
    this.store = new KubernetesLeaseStore(config.lock!.kubeconfig, config.lock!.namespace, config.lock!.name);
    this.lease = new LabLease(this.store, journal.runId, config.expected.applianceUid, Date.now, 120);
    this.api = snapshot.api;
    this.journals = [journal];
    this.keys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries, this.guard);
    this.baselineKeyIds = baselineKeyIds;
  }

  static async snapshot(context: BrowserContext, config: LabConfig) {
    const observer = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
    await observer.verifyConfiguration();
    const api = readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs);
    const [appliance, hosts, models, observed, nodes, pods, flux] = await Promise.all([
      api.appliance(), api.hostManagement(), api.models(),
      observer.get('appliances.appliance.magicstick.dev', config.expected.applianceNamespace, config.expected.applianceName),
      observer.list('nodes'), observer.list('pods'), observer.list('kustomizations.kustomize.toolkit.fluxcd.io', 'flux-system'),
    ]);
    verifyIdentity(config, appliance, observed, nodes, hosts.nodes);
    verifyCapabilities(config, models);
    await verifyDeploymentPins(config, observer, pods, flux);
    return {observer, api, appliance, hosts, models, observed, nodes, pods, flux};
  }

  static async open(browser: Browser, config: LabConfig, journal: ResourceJournal, loginOptions: RealLoginOptions = {}) {
    requirePhase0Profile(config);
    const context = await realLogin(browser, config, loginOptions);
    let live: LiveFoundation | undefined;
    try {
      const snapshot = await LiveFoundation.snapshot(context, config);
      verifyIdle(snapshot.hosts.nodes, snapshot.models, config);
      fixtureIsAdvertised(snapshot.models, config.smokeModel!);
      const readKeys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries,
        async () => { throw new Error('Read-only baseline'); });
      const baseline = new Set((await readKeys.list()).items.map(item => item.id));
      live = new LiveFoundation(context, config, journal, snapshot, baseline);
      await live.cleaner.verifyConfiguration();
      await live.lease.acquire(); live.acquired = true;
      return live;
    } catch (error) {
      if (live?.acquired) await live.lease.release();
      await context.close();
      throw error;
    }
  }

  guard = async () => {
    if (this.beat) return this.beat;
    this.beat = (async () => {
      if (Date.now() - this.beatAt > 15_000) { await this.lease.heartbeat(); this.beatAt = Date.now(); }
      else await this.lease.assertHeld();
    })().finally(() => { this.beat = undefined; });
    return this.beat;
  };

  async createKey(suffix: string) {
    const name = this.journal.prefix + suffix;
    await this.guard(); await this.journal.requested('key', name);
    const key = await this.keys.createCredential(name);
    await this.journal.owned('key', name, key.id);
    return key;
  }

  async createModel(suffix: string, journal = this.journal, fixture: LocalModelFixture = this.config.smokeModel!) {
    const name = journal.prefix + suffix;
    await this.guard(); await journal.requested('model', name);
    const client = new OwnedModelClient(this.context.request, this.config.dashboardUrl, this.config.requestTimeoutMs,
      name, fixture, journal.prefix, this.guard);
    const created = await client.create();
    await journal.owned('model', name, created.uid, created.generation);
    return {client, ...created};
  }

  async modelState(client: OwnedModelClient, uid: string) {
    await this.guard();
    const [models, observed, pods] = await Promise.all([client.models(), this.cleaner.find(client.name), this.observer.list('pods', 'ai')]);
    const item = activation(models, client.name);
    requireSafe(!item || item.metadata?.uid === uid, 'OWNERSHIP');
    requireSafe(!observed || observed.metadata.uid === uid, 'OWNERSHIP');
    return {models, item, observed, pods: ownedRuntimePods(pods, client.name)};
  }

  async waitReady(client: OwnedModelClient, uid: string, generation: number) {
    return poll(() => this.modelState(client, uid), value =>
      value.item?.metadata?.generation === generation && value.item.spec?.enabled === true && value.item.status?.phase === 'Ready' &&
      value.observed?.metadata.generation === generation && value.pods.some(pod =>
        pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')) &&
      value.models.models?.some(item => item.id === client.name) === true,
    {timeoutMs: 900_000, intervalMs: 1000, stage: 'model-ready'});
  }

  async cleanup(journal = this.journal) {
    const key = this.keys.adapter();
    const model = this.cleaner.adapter(journal.prefix, name => remainingModelResources(this.observer, this.api, name), this.guard);
    await journal.cleanup({key, model, app: key, identity: key}, this.guard);
  }

  /** Only for a no-resource fault proof, after the exact test replacement owner
   * has been CAS-released. The fenced Lease object itself is never revived. */
  async finishFencedProof() {
    requireSafe(this.journals.every(journal => journal.recoveryPlan().length === 0), 'CLEANUP');
    const current = await this.store.read();
    requireSafe(!current.spec.holderIdentity && current.metadata.labels['regression.magicstick.dev/appliance-uid'] === this.config.expected.applianceUid, 'CONFLICT');
    this.acquired = false;
  }

  async close() {
    try {
      if (this.acquired) {
        for (const journal of [...this.journals].reverse()) await this.cleanup(journal);
        const currentIds = new Set((await this.keys.list()).items.map(item => item.id));
        requireSafe([...this.baselineKeyIds].every(id => currentIds.has(id)) && this.journals.every(journal => journal.recoveryPlan().length === 0), 'CLEANUP');
        await this.lease.release(); this.acquired = false;
      }
    } finally { await this.context.close(); }
  }
}
