import {test, expect, type Browser} from '@playwright/test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {loadLabConfig, type LabConfig} from '../core/config.ts';
import {ResourceJournal, newRunId} from '../core/journal.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {verifyIdentity, verifyCapabilities, verifyIdle, verifyDeploymentPins, verifiedEndpoint} from '../core/preflight.ts';
import {requireSafe, HarnessError} from '../core/errors.ts';
import {privateDirectory} from '../core/private-files.ts';
import {poll} from '../core/poll.ts';
import {OwnedModelClient} from '../core/owned-model.ts';
import {KubernetesLeaseStore} from '../core/observer.ts';
import {LabLease} from '../core/lease.ts';
import {realLogin} from '../core/auth.ts';
import {typeScriptWorkerArgs} from '../core/node-worker.ts';

let config: LabConfig;
let journal: ResourceJournal;
test.describe.configure({mode: 'serial'});
test.beforeAll(async () => {
  requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR, 'CONFIG');
  config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
});

async function withLive(browser: Browser, action: (live: LiveFoundation) => Promise<void>) {
  const live = await LiveFoundation.open(browser, config, journal);
  try { await action(live); } finally { await live.close(); }
}

test('HAR-02 [p0:negative-preflight] wrong appliance, node, boot, capabilities, source and image pins abort on actual evidence', async ({browser}) => {
  const store = new KubernetesLeaseStore(config.lock!.kubeconfig, config.lock!.namespace, config.lock!.name);
  const before = await store.read(); requireSafe(!before.spec.holderIdentity, 'LOCK_BUSY');
  const context = await realLogin(browser, config);
  try {
    const snapshot = await LiveFoundation.snapshot(context, config);
    const identity = (selection: LabConfig) => verifyIdentity(selection, snapshot.appliance, snapshot.observed, snapshot.nodes, snapshot.hosts.nodes);
    const wrongAppliance = structuredClone(config); wrongAppliance.expected.applianceUid += '-wrong';
    expect(() => identity(wrongAppliance)).toThrow('[IDENTITY]');
    const wrongNode = structuredClone(config); wrongNode.expected.nodes[0]!.uid += '-wrong';
    expect(() => identity(wrongNode)).toThrow('[IDENTITY]');
    const wrongBoot = structuredClone(config); wrongBoot.expected.nodes[0]!.bootId += '-wrong';
    expect(() => identity(wrongBoot)).toThrow('[HOST]');
    const missing = structuredClone(config); missing.expected.capabilities.push({target: 'missing-test-gpu', engines: ['VLLM']});
    expect(() => verifyCapabilities(missing, snapshot.models)).toThrow('[CAPABILITY]');
    const wrongSource = structuredClone(config); wrongSource.expected.flux!.revision = 'sha1:' + '0'.repeat(40);
    await expect(verifyDeploymentPins(wrongSource, snapshot.observer, snapshot.pods, snapshot.flux)).rejects.toMatchObject({code: 'REVISION'});
    const wrongImage = structuredClone(config); wrongImage.expected.images[0]!.digest = 'sha256:' + '0'.repeat(64);
    await expect(verifyDeploymentPins(wrongImage, snapshot.observer, snapshot.pods, snapshot.flux)).rejects.toMatchObject({code: 'REVISION'});
    expect(journal.recoveryPlan()).toEqual([]);
    const after = await store.read();
    expect(after.metadata.resourceVersion).toBe(before.metadata.resourceVersion);
    expect(after.spec.holderIdentity).toBeFalsy();
  } finally { await context.close(); }
});

test('HAR-03 [p0:offline-busy-abort] offline endpoint and host plus actual active test model and held Lease block without forced cleanup', async ({browser}) => {
  // A bound but closed loopback port, never an arbitrary external host.
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); requireSafe(address && typeof address === 'object', 'CONFIG');
  await new Promise<void>(resolve => server.close(() => resolve()));
  await expect(verifiedEndpoint(`https://127.0.0.1:${address.port}/`, 500)).rejects.toMatchObject({code: 'TLS', outcome: 'Blocked'});
  await withLive(browser, async live => {
    const offline = structuredClone(live.snapshot.hosts.nodes); offline[0]!.available = false;
    expect(() => verifyIdentity(config, live.snapshot.appliance, live.snapshot.observed, live.snapshot.nodes, offline)).toThrow('[HOST]');
    const pending = structuredClone(live.snapshot.hosts.nodes); pending[0]!.updates = {...pending[0]!.updates, busy: true} as typeof pending[0]['updates'];
    expect(() => verifyIdle(pending, live.snapshot.models, config)).toThrow('[BUSY]');
    const owned = await live.createModel('busy-cpu');
    const current = await live.api.models();
    expect(() => verifyIdle(live.snapshot.hosts.nodes, current, config)).toThrow('[BUSY]');
    const contender = new LabLease(live.store, newRunId(), config.expected.applianceUid);
    await expect(contender.acquire()).rejects.toMatchObject({code: 'LOCK_BUSY', outcome: 'Blocked'});
    expect((await live.cleaner.find(owned.client.name))?.metadata.uid).toBe(owned.uid);
    await live.lease.assertHeld();
  });
});

test('HAR-04 [p0:mutation-fencing] replaced live Lease fences actual key and model transports before requests', async ({browser}) => {
  await withLive(browser, async live => {
    const before = await live.store.read();
    const displaced = newRunId();
    await live.store.replace({...before, spec: {...before.spec, holderIdentity: displaced}});
    const keyName = journal.prefix + 'must-not-create-key';
    const modelName = journal.prefix + 'must-not-create-model';
    try {
      await expect(live.keys.create(keyName)).rejects.toMatchObject({code: 'LOCK_LOST'});
      const client = new OwnedModelClient(live.context.request, config.dashboardUrl, config.requestTimeoutMs, modelName,
        config.smokeModel!, journal.prefix, live.guard);
      await expect(client.create()).rejects.toMatchObject({code: 'LOCK_LOST'});
      expect((await live.keys.list()).items.some(item => item.name === keyName)).toBe(false);
      expect(await live.cleaner.find(modelName)).toBeNull();
    } finally {
      const current = await live.store.read();
      requireSafe(current.spec.holderIdentity === displaced && current.metadata.labels['regression.magicstick.dev/appliance-uid'] === config.expected.applianceUid, 'CONFLICT');
      await live.store.replace({...current, spec: {...current.spec, holderIdentity: ''}});
      // Fencing is permanent: re-establishing the server value cannot revive it.
      await expect(live.lease.acquire()).rejects.toMatchObject({code: 'LOCK_LOST'});
      await live.finishFencedProof();
    }
    // close() must not try to revive this fenced instance. No resources were created.
  });
});

test('HAR-05 [p0:uid-replacement] same-name replacement ModelActivation survives the original journal cleanup', async ({browser}) => {
  await withLive(browser, async live => {
    const original = await live.createModel('replace-cpu');
    await live.cleanup();
    const replacementJournal = await ResourceJournal.create(join(process.env.REGRESSION_RUN_DIR!, 'replacement-journal.json'), journal.runId, config.expected.applianceUid);
    live.journals.push(replacementJournal);
    const replacement = await live.createModel('replace-cpu', replacementJournal);
    expect(replacement.uid).not.toBe(original.uid);
    const staleJournal = await ResourceJournal.create(join(process.env.REGRESSION_RUN_DIR!, 'stale-journal.json'), journal.runId, config.expected.applianceUid);
    await staleJournal.requested('model', original.client.name);
    await staleJournal.owned('model', original.client.name, original.uid, original.generation);
    live.journals.splice(1, 0, staleJournal);
    await expect(live.cleanup(staleJournal)).rejects.toMatchObject({code: 'CLEANUP'});
    expect((await live.cleaner.find(replacement.client.name))?.metadata.uid).toBe(replacement.uid);
    expect(staleJournal.recoveryPlan()[0]?.state).toBe('blocked');
    await live.cleanup(replacementJournal); await live.cleanup(staleJournal);
  });
});

test('HAR-06 [p0:failure-cleanup] failure after live key and Ready model preserves original stage and removes intent, Pod, route and key', async ({browser}) => {
  await withLive(browser, async live => {
    const key = await live.createKey('failure-key');
    const owned = await live.createModel('failure-cpu');
    await live.waitReady(owned.client, owned.uid, owned.generation);
    let original: unknown;
    try { throw new HarnessError('DEADLINE', 'Failed', 'model-ready'); }
    catch (error) { original = error; }
    finally { await live.cleanup(); }
    expect(original).toMatchObject({code: 'DEADLINE', outcome: 'Failed', stage: 'model-ready'});
    expect(journal.recoveryPlan()).toEqual([]);
    expect((await live.keys.list()).items.some(item => item.id === key.id)).toBe(false);
  });
});

test('HAR-09 [p0:model-generation] delayed model status cannot satisfy a new generation and reports the stalled stage', async ({browser}) => {
  await withLive(browser, async live => {
    const owned = await live.createModel('generation-cpu');
    const ready = await live.waitReady(owned.client, owned.uid, owned.generation);
    requireSafe(ready.item, 'API');
    const stopped = await owned.client.stop(ready.item);
    await journal.modelGeneration(owned.client.name, owned.uid, owned.generation, stopped.generation);
    const disabled = await poll(() => live.modelState(owned.client, owned.uid), item =>
      item.item?.metadata?.generation === stopped.generation && item.item.spec?.enabled === false && item.pods.length === 0,
    {timeoutMs: 300_000, intervalMs: 1000, stage: 'model-stopped'});
    requireSafe(disabled.item, 'API');
    const restarted = await owned.client.start(disabled.item);
    await journal.modelGeneration(owned.client.name, owned.uid, stopped.generation, restarted.generation);
    const accepts = (item: typeof ready) => item.item?.metadata?.generation === restarted.generation &&
      item.item.spec?.enabled === true && item.item.status?.phase === 'Ready' && item.observed?.metadata.generation === restarted.generation &&
      item.pods.some(pod => pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True'));
    await expect(poll(async () => ready, accepts, {timeoutMs: 300, stage: 'model-ready'})).rejects.toMatchObject({code: 'DEADLINE', stage: 'model-ready'});
    let reads = 0;
    await poll(async () => ++reads <= 2 ? ready : live.modelState(owned.client, owned.uid), accepts,
      {timeoutMs: 900_000, intervalMs: 1000, stage: 'model-ready'});
    expect(reads).toBeGreaterThan(2);
  });
});

test('HAR-07 [p0:process-recovery] killed owned runner is independently recovered from its durable key/model journal', async ({browser}) => {
  const runId = newRunId(), directory = join('/private/runs', runId);
  await privateDirectory(directory);
  const childJournal = await ResourceJournal.create(join(directory, 'journal.json'), runId, config.expected.applianceUid);
  const child = spawn(process.execPath, typeScriptWorkerArgs(fileURLToPath(new URL('../interruption-worker.mjs', import.meta.url))),
    {env: {...process.env, REGRESSION_RUN_DIR: directory, REGRESSION_RUN_ID: runId}, stdio: ['ignore', 'ignore', 'ignore', 'ipc']});
  const closed = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => child.once('close', (code, signal) => resolve({code, signal})));
  let barrier = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new HarnessError('DEADLINE', 'Failed', 'recovery-barrier')), 1_000_000);
      child.once('error', () => { clearTimeout(timer); reject(new HarnessError('UNEXPECTED')); });
      child.once('close', () => { clearTimeout(timer); reject(new HarnessError('CLEANUP')); });
      child.once('message', message => {
        clearTimeout(timer);
        if ((message as {event?: unknown})?.event === 'journaled') { barrier = true; resolve(); }
        else reject(new HarnessError('CLEANUP'));
      });
    });
    const recorded = await ResourceJournal.resume(childJournal.filename, config.expected.applianceUid);
    requireSafe(recorded.entries.length === 2 && recorded.entries.every(item => item.uid && item.state === 'owned'), 'OWNERSHIP');
    child.kill('SIGKILL');
    expect((await closed).signal).toBe('SIGKILL');
    // Exactly this child is proven dead. This does not implement stale-lock theft.
    const store = new KubernetesLeaseStore(config.lock!.kubeconfig, config.lock!.namespace, config.lock!.name);
    const lease = await store.read();
    requireSafe(lease.spec.holderIdentity === runId && lease.metadata.labels['regression.magicstick.dev/appliance-uid'] === config.expected.applianceUid, 'CONFLICT');
    await store.replace({...lease, spec: {...lease.spec, holderIdentity: ''}});
    const recovery = spawn(process.execPath, ['regression/launch.mjs', 'recover', recorded.filename],
      {env: process.env, stdio: ['ignore', 'ignore', 'ignore']});
    const exit = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { recovery.kill('SIGTERM'); reject(new HarnessError('DEADLINE', 'Failed', 'cleanup')); }, 500_000);
      recovery.once('error', () => { clearTimeout(timer); reject(new HarnessError('UNEXPECTED')); });
      recovery.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    expect(exit).toBe(0);
    expect((await ResourceJournal.resume(recorded.filename, config.expected.applianceUid)).recoveryPlan()).toEqual([]);
    expect((await store.read()).spec.holderIdentity).toBeFalsy();
    // Read-only independent post-recovery observation; no new resources.
    const live = await LiveFoundation.open(browser, config, journal);
    try {
      for (const entry of recorded.entries) {
        if (entry.kind === 'model') expect(await live.cleaner.find(entry.name)).toBeNull();
        if (entry.kind === 'key') expect((await live.keys.list()).items.some(item => item.id === entry.uid)).toBe(false);
      }
    } finally { await live.close(); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await closed; }
    // A failure before the durable barrier is never guessed/retried. The journal
    // and test Lease stay visible for explicit owner inspection if needed.
    requireSafe(barrier, 'CLEANUP');
  }
});
