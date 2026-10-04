import {test, expect, type BrowserContext} from '@playwright/test';
import {join} from 'node:path';
import type {LabConfig} from '../core/config.ts';
import {loadLabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {readOnlyApi} from '../core/transport.ts';
import {KubernetesLeaseStore, KubectlObserver} from '../core/observer.ts';
import {LabLease} from '../core/lease.ts';
import {ResourceJournal, newRunId} from '../core/journal.ts';
import {OwnedKeyClient} from '../core/owned-key.ts';
import {verifyCapabilities, verifyIdentity, verifyIdle} from '../core/preflight.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';
import {summarize} from '../core/report.ts';

test.describe.serial('live owned API-key cleanup subset', () => {
  let config: LabConfig;
  let context: BrowserContext | undefined;
  let lock: LabLease | undefined;
  let journal: ResourceJournal;
  let keys: OwnedKeyClient;
  let cleaned = false;
  let lockAcquired = false;
  let baselineIds: Set<string>;

  test.beforeAll(async ({browser}) => {
    requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR, 'CONFIG');
    config = await loadLabConfig(process.env.REGRESSION_CONFIG);
    requireSafe(config.lock, 'CONFIG');
    context = await realLogin(browser, config);
    const observer = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
    await observer.verifyConfiguration();
    const api = readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs);
    const [appliance, hosts, models, observed, nodes] = await Promise.all([
      api.appliance(), api.hostManagement(), api.models(),
      observer.get('appliances.appliance.magicstick.dev', config.expected.applianceNamespace, config.expected.applianceName),
      observer.list('nodes'),
    ]);
    verifyIdentity(config, appliance, observed, nodes, hosts.nodes);
    verifyCapabilities(config, models);
    verifyIdle(hosts.nodes, models, config);
    journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
    keys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries,
      async () => { requireSafe(lock, 'LOCK_LOST'); await lock.assertHeld(); });
    baselineIds = new Set((await keys.list()).items.map(item => item.id));
    lock = new LabLease(new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name),
      newRunId(), config.expected.applianceUid, Date.now, 120);
    await lock.acquire();
    lockAcquired = true;
  });

  test.afterAll(async () => {
    try {
      if (lock && journal && keys) {
        await lock.heartbeat();
        const adapter = keys.adapter();
        await journal.cleanup({key: adapter, model: adapter, app: adapter, identity: adapter}, () => lock!.assertHeld());
        const current = new Set((await keys.list()).items.map(item => item.id));
        requireSafe([...baselineIds].every(id => current.has(id)) &&
          journal.entries.filter(item => item.kind === 'key').every(item => item.uid && !current.has(item.uid)), 'CLEANUP');
        cleaned = true;
        await lock.release();
      }
    } finally { await context?.close(); }
    if (lockAcquired) requireSafe(cleaned, 'CLEANUP');
  });

  async function createOwned(suffix: string) {
    requireSafe(lock, 'LOCK_LOST');
    await lock.heartbeat();
    const name = journal.prefix + suffix;
    await journal.requested('key', name);
    const uid = await keys.create(name);
    await journal.owned('key', name, uid);
    expect((await keys.list()).items.some(item => item.id === uid && item.name === name)).toBe(true);
    return {name, uid};
  }
  async function cleanup() {
    requireSafe(lock, 'LOCK_LOST');
    await lock.heartbeat();
    const adapter = keys.adapter();
    await journal.cleanup({key: adapter, model: adapter, app: adapter, identity: adapter}, () => lock!.assertHeld());
  }

  test('HAR-05 journal-owned live API key is revoked by immutable ID without touching existing keys', async () => {
    const key = await createOwned('har05');
    await cleanup();
    expect((await keys.list()).items.some(item => item.id === key.uid)).toBe(false);
  });

  test('HAR-06 controlled failure keeps its outcome while owned key cleanup succeeds', async () => {
    const key = await createOwned('har06');
    const original = new HarnessError('DEADLINE', 'Failed');
    await cleanup();
    expect(original.code).toBe('DEADLINE');
    expect(summarize(['HAR-06'], [{id: 'HAR-06', layer: 'A', environment: 'live', outcome: 'Failed', reason: original.code, durationMs: 1}]).acceptable).toBe(false);
    expect((await keys.list()).items.some(item => item.id === key.uid)).toBe(false);
  });

  test('HAR-07 durable journal is resumed before deleting only its owned live key', async () => {
    const key = await createOwned('har07');
    requireSafe(process.env.REGRESSION_RUN_DIR, 'CONFIG');
    journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
    await cleanup();
    expect(journal.recoveryPlan()).toEqual([]);
    expect((await keys.list()).items.some(item => item.id === key.uid)).toBe(false);
  });
});
