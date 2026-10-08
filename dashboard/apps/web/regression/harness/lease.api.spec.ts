import {test, expect} from '@playwright/test';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {loadLabConfig} from '../core/config.ts';
import {KubernetesLeaseStore, KubectlObserver} from '../core/observer.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';
import {writePrivate} from '../core/private-files.ts';
import {restoreRevision} from '../core/journal.ts';
import {LabLease, type Lease} from '../core/lease.ts';
import {poll, currentReady} from '../core/poll.ts';
import {typeScriptWorkerArgs} from '../core/node-worker.ts';

function contender(index:1|2): Promise<{code: number | null; result: string}> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, typeScriptWorkerArgs(fileURLToPath(new URL('../lock-contender.mjs', import.meta.url))),
      {env: {...process.env,REGRESSION_LOCK_CONTENDER_INDEX:String(index)}, stdio: ['ignore', 'pipe', 'ignore']});
    let result = '';
    child.stdout.on('data', (chunk: Buffer) => { result += chunk.toString(); if (result.length > 128) child.kill('SIGKILL'); });
    child.once('error', () => resolve({code: 2, result: 'unexpected'}));
    child.once('close', code => resolve({code, result: result.trim()}));
  });
}

test('HAR-04 [p0:lease-race] separate runner processes race for one real appliance-scoped Lease', async () => {
  requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  requireSafe(config.lock, 'CONFIG');
  const store = new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name);
  const before = await store.read();
  requireSafe(before.metadata.labels['regression.magicstick.dev/appliance-uid'] === config.expected.applianceUid, 'IDENTITY');
  requireSafe(!before.spec.holderIdentity, 'LOCK_BUSY');
  const results = await Promise.all([contender(1), contender(2)]);
  requireSafe(process.env.REGRESSION_RUN_DIR, 'CONFIG');
  await writePrivate(join(process.env.REGRESSION_RUN_DIR, 'lock-outcomes.json'), results.map(item =>
    ({code: item.code, result: /^(won-and-released|busy|failed-[A-Z_]+|unexpected)$/.test(item.result) ? item.result : 'unexpected'})));
  if (!results.some(item => item.code === 0 && item.result === 'won-and-released')) throw new HarnessError('LOCK_LOST');
  expect(results.filter(item => item.code === 0 && item.result === 'won-and-released')).toHaveLength(1);
  expect(results.filter(item => item.code === 3 && item.result === 'busy')).toHaveLength(1);
  const after = await store.read();
  requireSafe(!after.spec.holderIdentity, 'LOCK_LOST');
});

test('HAR-08 [p0:revision-conflict] an intervening real API revision prevents automatic test-setting restoration', async () => {
  requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  requireSafe(config.lock, 'CONFIG');
  const store = new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name);
  requireSafe(process.env.REGRESSION_RUN_ID,'CONFIG');
  const owner = new LabLease(store, process.env.REGRESSION_RUN_ID, config.expected.applianceUid, Date.now, 60);
  await owner.acquire(process.env.REGRESSION_RUN_ID);
  const key = 'regression.magicstick.dev/revision-probe';
  type Annotated = Lease & {metadata: Lease['metadata'] & {annotations?: Record<string, string>}};
  let safeToRelease = false;
  try {
    const original = await store.read() as Annotated;
    requireSafe(!original.metadata.annotations?.[key], 'CONFLICT');
    const ours = await store.replace({...original, metadata: {...original.metadata,
      annotations: {...original.metadata.annotations, [key]: 'ours'}}} as Lease);
    const intervening = await store.replace({...ours, metadata: {...ours.metadata,
      annotations: {...(ours as Annotated).metadata.annotations, [key]: 'intervening'}}} as Lease);
    let restorationCalled = false;
    await expect(restoreRevision(original, ours.metadata.resourceVersion, {
      currentRevision: async () => (await store.read()).metadata.resourceVersion,
      restore: async () => { restorationCalled = true; },
    }, () => owner.assertHeld())).rejects.toMatchObject({code: 'CONFLICT'});
    expect(restorationCalled).toBe(false);
    const current = await store.read() as Annotated;
    requireSafe(current.metadata.resourceVersion === intervening.metadata.resourceVersion &&
      current.spec.holderIdentity === owner.owner && current.metadata.annotations?.[key] === 'intervening', 'CONFLICT');
    const annotations = {...current.metadata.annotations};
    delete annotations[key];
    await store.replace({...current, metadata: {...current.metadata, annotations}} as Lease);
    safeToRelease = true;
  } finally {
    if (safeToRelease) await owner.release();
  }
  const after = await store.read() as Annotated;
  requireSafe(!after.spec.holderIdentity && !after.metadata.annotations?.[key], 'CLEANUP');
});

test('HAR-09 [p0:flux-polling] live Flux polling rejects stale generations and has a bounded deadline', async () => {
  requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG);
  const expected = config.expected.flux;
  requireSafe(expected, 'CONFIG');
  // The Flux object is read through the independent observation account, not
  // through the Lease writer; there is no product or test-resource mutation.
  const reader = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
  const resource = 'kustomizations.kustomize.toolkit.fluxcd.io';
  const initial = await reader.get(resource, expected.namespace, expected.name);
  const uid = initial.metadata.uid, generation = initial.metadata.generation;
  requireSafe(uid && Number.isSafeInteger(generation) && generation! > 0 &&
    initial.status?.lastAppliedRevision === expected.revision && currentReady(initial, uid, generation!), 'REVISION');
  const stale = {...initial, status: {...initial.status, observedGeneration: generation! - 1,
    conditions: initial.status?.conditions?.map(item => ({...item, observedGeneration: generation! - 1}))}};
  let reads = 0;
  const accepted = await poll(async () => ++reads <= 2 ? stale : await reader.get(resource, expected.namespace, expected.name),
    item => currentReady(item, uid, generation!), {timeoutMs: 10_000, intervalMs: 100});
  expect(reads).toBeGreaterThan(2);
  expect(currentReady(accepted, uid, generation!)).toBe(true);
  await expect(poll(() => reader.get(resource, expected.namespace, expected.name),
    item => currentReady(item, uid, generation! + 1), {timeoutMs: 600, intervalMs: 100, stage: 'flux-ready'})).rejects.toMatchObject({code: 'DEADLINE', stage: 'flux-ready'});
});
