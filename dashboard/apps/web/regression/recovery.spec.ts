import {test, expect, type BrowserContext} from '@playwright/test';
import {loadLabConfig} from './core/config.ts';
import {realLogin} from './core/auth.ts';
import {readOnlyApi} from './core/transport.ts';
import {KubectlObserver, KubernetesLeaseStore} from './core/observer.ts';
import {KubernetesModelCleaner} from './core/model-cleanup.ts';
import {LabLease} from './core/lease.ts';
import {ResourceJournal} from './core/journal.ts';
import {OwnedKeyClient} from './core/owned-key.ts';
import {OwnedModelClient, remainingModelResources} from './core/owned-model.ts';
import {verifyCapabilities, verifyIdentity} from './core/preflight.ts';
import {requireSafe} from './core/errors.ts';

test('HAR-07 explicit recovery resumes one journal and removes only unchanged UID-owned resources', async ({browser}) => {
  requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RECOVERY_JOURNAL, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  requireSafe(config.lock && config.modelCleanupKubeconfig && config.smokeModel, 'CONFIG');
  const journal = await ResourceJournal.resume(process.env.REGRESSION_RECOVERY_JOURNAL, config.expected.applianceUid);
  requireSafe(journal.entries.length > 0 && journal.entries.every(entry => ['model', 'key'].includes(entry.kind)) &&
    journal.entries.filter(entry => entry.kind === 'model').length <= 1, 'OWNERSHIP');
  let context: BrowserContext | undefined, lock: LabLease | undefined, acquired = false, cleaned = false;
  try {
    context = await realLogin(browser, config);
    const observer = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
    const cleaner = new KubernetesModelCleaner(config.modelCleanupKubeconfig, config.expected.applianceNamespace, config.requestTimeoutMs);
    await observer.verifyConfiguration(); await cleaner.verifyConfiguration();
    const api = readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs);
    const [appliance, hosts, models, observed, nodes] = await Promise.all([
      api.appliance(), api.hostManagement(), api.models(),
      observer.get('appliances.appliance.magicstick.dev', config.expected.applianceNamespace, config.expected.applianceName),
      observer.list('nodes'),
    ]);
    verifyIdentity(config, appliance, observed, nodes, hosts.nodes);
    verifyCapabilities(config, models);
    const ownedNames = new Set(journal.entries.filter(entry => entry.kind === 'model').map(entry => entry.name));
    requireSafe(models.activations.every(item => item.spec?.type !== 'local' || item.spec.enabled === false ||
      ownedNames.has(item.metadata?.name ?? '')), 'BUSY');
    requireSafe(hosts.nodes.every(host => !host.updates?.busy && !host.software?.busy &&
      (!host.operation || ['Succeeded', 'Failed', 'Cancelled'].includes(host.operation.phase))), 'BUSY');
    const keys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries);
    const modelEntry = journal.entries.find(entry => entry.kind === 'model');
    const model = modelEntry ? new OwnedModelClient(context.request, config.dashboardUrl, config.requestTimeoutMs,
      modelEntry.name, config.smokeModel, journal.prefix) : undefined;
    if (modelEntry?.uid) model?.adopt(modelEntry.uid);
    lock = new LabLease(new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name),
      journal.runId, config.expected.applianceUid, Date.now, 120);
    await lock.acquire(); acquired = true;
    let beatAt = Date.now();
    const heartbeat = async () => {
      requireSafe(lock, 'LOCK_LOST');
      if (Date.now() - beatAt > 15_000) { await lock.heartbeat(); beatAt = Date.now(); }
      else await lock.assertHeld();
    };
    const keyAdapter = keys.adapter();
    const modelAdapter = model ? cleaner.adapter(journal.prefix, name => remainingModelResources(observer, model, name), heartbeat) : keyAdapter;
    await journal.cleanup({key: keyAdapter, model: modelAdapter, app: keyAdapter, identity: keyAdapter}, heartbeat);
    expect(journal.recoveryPlan()).toEqual([]);
    await lock.release(); cleaned = true;
  } finally {
    await context?.close();
    if (acquired) requireSafe(cleaned, 'CLEANUP');
  }
});
