import type {Browser, BrowserContext} from '@playwright/test';
import type {LabConfig, RuntimeModelFixture} from './config.ts';
import {realLogin, type RealLoginOptions} from './auth.ts';
import {readOnlyApi} from './transport.ts';
import {KubernetesLeaseStore, KubectlObserver} from './observer.ts';
import {KubernetesModelCleaner} from './model-cleanup.ts';
import {LabLease} from './lease.ts';
import {ResourceJournal, type CleanupAdapter} from './journal.ts';
import {OwnedKeyClient} from './owned-key.ts';
import {ModelCreateRejected, OwnedModelClient, activation, ownedRuntimePods, remainingModelResources} from './owned-model.ts';
import {verifyIdentity, verifyCapabilities, verifyIdle, verifyDeploymentPins} from './preflight.ts';
import {requirePhase0Profile} from '../profiles/phase0-p0.ts';
import {poll} from './poll.ts';
import {requireSafe} from './errors.ts';
import {registeredLab} from './lab-policy.ts';

/** Shared foundation adapter: no GPU, host-maintenance or product-setting writes. */
export class LiveFoundation {
  private restorations:Array<()=>Promise<void>>=[];
  registerRestoration(action:()=>Promise<void>) {
    this.restorations.push(action);
    return ()=>{this.restorations=this.restorations.filter(item=>item !== action);};
  }
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
  private readonly domainCleanup:Partial<Record<'app'|'identity',CleanupAdapter>>={};

  registerDomainCleanup(kind:'app'|'identity',adapter:CleanupAdapter) {
    requireSafe(!this.domainCleanup[kind] || this.journal.entries.filter(entry=>entry.kind === kind).every(entry=>entry.state === 'removed'),'OWNERSHIP');
    this.domainCleanup[kind]=adapter;
  }

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
    await registeredLab(config,observer);
    verifyCapabilities(config, models);
    await verifyDeploymentPins(config, observer, pods, flux);
    return {observer, api, appliance, hosts, models, observed, nodes, pods, flux};
  }

  static async open(browser: Browser, config: LabConfig, journal: ResourceJournal, loginOptions: RealLoginOptions = {}) {
    // Base API/identity tests do not need a usable CPU inference fixture.
    requireSafe(config.lock && config.modelCleanupKubeconfig && config.expected.images.length >= 2,'PREREQUISITE');
    const context = await realLogin(browser, config, loginOptions);
    let live: LiveFoundation | undefined;
    try {
      const snapshot = await LiveFoundation.snapshot(context, config);
      verifyIdle(snapshot.hosts.nodes, snapshot.models, config);
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

  /** Explicit process recovery only. No expired-holder takeover and no adoption
   * by prefix: every surviving definition must match the recorded UID/spec generation. */
  static async recover(browser:Browser,config:LabConfig,journal:ResourceJournal) {
    requirePhase0Profile(config);
    requireSafe(journal.entries.length <= 64 && journal.entries.every(e=>['model','key'].includes(e.kind)),'OWNERSHIP');
    const context=await realLogin(browser,config);let live:LiveFoundation|undefined;
    try {
      const snapshot=await LiveFoundation.snapshot(context,config);
      const ownedNames=new Set(journal.entries.filter(e=>e.kind === 'model' && e.state !== 'removed').map(e=>e.name));
      for(const item of snapshot.models.activations.filter(a=>ownedNames.has(a.metadata?.name ?? ''))) {
        const entry=journal.entries.find(e=>e.kind === 'model' && e.name === item.metadata?.name);
        requireSafe(entry?.uid && entry.uid === item.metadata?.uid && entry.generation === item.metadata?.generation,'OWNERSHIP');
      }
      verifyIdle(snapshot.hosts.nodes,{...snapshot.models,activations:snapshot.models.activations.filter(a=>!ownedNames.has(a.metadata?.name ?? ''))},config);
      const readKeys=new OwnedKeyClient(context.request,config.dashboardUrl,config.requestTimeoutMs,journal.prefix,journal.entries,async()=>{throw new Error('Read-only baseline');});
      const ownedKeyIds=new Set(journal.entries.filter(e=>e.kind === 'key' && e.uid).map(e=>e.uid));
      const baseline=new Set((await readKeys.list()).items.map(k=>k.id).filter(id=>!ownedKeyIds.has(id)));
      live=new LiveFoundation(context,config,journal,snapshot,baseline);await live.cleaner.verifyConfiguration();
      await live.lease.acquire();live.acquired=true;return live;
    } catch(error) {if(live?.acquired) await live.lease.release();await context.close();throw error;}
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

  async createModel(suffix: string, journal = this.journal, fixture: RuntimeModelFixture = this.config.smokeModel!,
    options: {allowMemoryRisk?: boolean} = {}) {
    const name = journal.prefix + suffix;
    const client = new OwnedModelClient(this.context.request, this.config.dashboardUrl, this.config.requestTimeoutMs,
      name, fixture, journal.prefix, this.guard, options.allowMemoryRisk === true);
    await this.guard(); await journal.requested('model', name);
    let created;
    try { created = await client.create(); }
    catch (error) {
      if (error instanceof ModelCreateRejected) {
        await this.guard();
        // Never infer ownership from a name or treat a timeout as a rejection.
        // Independent absence is required before cleanup can skip this intent.
        if (!(await this.cleaner.find(name))) await journal.rejected('model', name);
      }
      throw error;
    }
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

  async cleanup(journal = this.journal, only?: {kind: 'model'|'app'|'identity'|'key'; name: string}) {
    const key = this.keys.adapter();
    const model = this.cleaner.adapter(journal.prefix, name => remainingModelResources(this.observer, this.api, name), this.guard);
    const unavailable:CleanupAdapter={lookup:async()=>{throw new Error('Unregistered cleanup domain');},
      removeIfUid:async()=>{throw new Error('Unregistered cleanup domain');},verifyRemoved:async()=>false};
    await journal.cleanup({key, model, app: this.domainCleanup.app ?? unavailable,
      identity: this.domainCleanup.identity ?? unavailable}, this.guard, only);
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
        for(const restore of [...this.restorations].reverse())await restore();
        this.restorations=[];
        for (const journal of [...this.journals].reverse()) await this.cleanup(journal);
        const currentIds = new Set((await this.keys.list()).items.map(item => item.id));
        requireSafe([...this.baselineKeyIds].every(id => currentIds.has(id)) && this.journals.every(journal => journal.recoveryPlan().length === 0), 'CLEANUP');
        await this.lease.release(); this.acquired = false;
      }
    } finally { await this.context.close(); }
  }
}
