import {test, expect, type APIRequestContext} from '@playwright/test';
import {mkdtemp, rm, writeFile, lstat, readFile, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createServer as secureServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {ModelsPayload, ManagedHost} from '@magicstick/dashboard-contracts';
import {parseLabConfig, loadLabConfig, type LabConfig} from '../core/config.ts';
import {HarnessError} from '../core/errors.ts';
import {ResourceJournal, newRunId, restoreRevision, type CleanupAdapter, type ResourceKind} from '../core/journal.ts';
import {LabLease, type LeaseStore, type Lease} from '../core/lease.ts';
import {readPrivate, writePrivate} from '../core/private-files.ts';
import {poll, currentReady} from '../core/poll.ts';
import {summarize, saveReport, redact, type CaseResult} from '../core/report.ts';
import {safeBaseline, verifiedEndpoint, verifyCapabilities, verifyIdentity, verifyIdle} from '../core/preflight.ts';
import {allowedOwnedStop, realLogin} from '../core/auth.ts';
import {readOnlyApi, readOnlyFetch} from '../core/transport.ts';
import {KubernetesLeaseStore, verifyObserverRules, type KubeObject} from '../core/observer.ts';
import {OwnedKeyClient} from '../core/owned-key.ts';
import {KubernetesModelCleaner, verifyModelCleanerRules} from '../core/model-cleanup.ts';
import {OwnedModelClient, activation, editRevision, fixtureIsAdvertised, ownedRuntimePods} from '../core/owned-model.ts';
import {InferenceProbe} from '../core/inference.ts';

let directory: string;
test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'magicstick-harness-')); });
test.afterEach(async () => { await rm(directory, {recursive: true, force: true}); });

function config(): LabConfig {
  return {version: 1, profile: 'preflight', dashboardUrl: 'https://dashboard.example.local', identityUrl: 'https://id.example.local',
    usernameFile: 'username.txt', passwordFile: 'password.txt', observerKubeconfig: 'observer.yaml', requestTimeoutMs: 500, loginTimeoutMs: 5000,
    expected: {applianceUid: 'appliance-uid', applianceNamespace: 'ai-system', applianceName: 'local', role: 'magicstick-admin',
      nodes: [{name: 'fixture-node', uid: 'node-uid'}], capabilities: [{target: 'cpu', engines: ['OLlama', 'VLLM']}], images: []}};
}
function host(): ManagedHost {
  return {name: 'fixture-node', nodeUid: 'node-uid', bootId: 'boot-uid', kernel: '7.0.0-test', available: true, message: 'Synthetic'};
}
function node(): KubeObject {
  return {metadata: {name: 'fixture-node', uid: 'node-uid'}, status: {nodeInfo: {bootID: 'boot-uid', kernelVersion: '7.0.0-test'}, conditions: [{type: 'Ready', status: 'True'}]}};
}
function models(): ModelsPayload { return {activations: [], presets: {}, computeTargets: {targets: [{id: 'cpu', available: true, engines: ['OLlama', 'VLLM']}]}}; }
function appliance() { return {metadata: {uid: 'appliance-uid', name: 'local', namespace: 'ai-system'}}; }
function lease(): Lease {
  return {kind: 'Lease', apiVersion: 'coordination.k8s.io/v1', metadata: {name: 'lab-lock', namespace: 'magicstick-regression', resourceVersion: '1',
    labels: {'regression.magicstick.dev/appliance-uid': 'appliance-uid'}}, spec: {}};
}
class MemoryLease implements LeaseStore {
  value = lease();
  async read() { return structuredClone(this.value); }
  async replace(value: Lease) {
    if (value.metadata.resourceVersion !== this.value.metadata.resourceVersion) throw new Error('synthetic CAS conflict');
    this.value = {...structuredClone(value), metadata: {...value.metadata, resourceVersion: String(Number(value.metadata.resourceVersion) + 1)}};
    return this.read();
  }
}

test('HAR-01 strict private config, HTTPS and required identity pins', async () => {
  expect(parseLabConfig(config(), directory).dashboardUrl).toBe(config().dashboardUrl);
  for (const url of ['http://example.local', 'https://admin:password@example.local', 'https://example.local/?token=value', 'https://example.local/#token']) {
    expect(() => parseLabConfig({...config(), dashboardUrl: url}, directory)).toThrow(HarnessError);
  }
  expect(() => parseLabConfig({...config(), expected: {...config().expected, nodes: []}}, directory)).toThrow(HarnessError);
  expect(() => parseLabConfig({...config(), profile: 'maintenance'}, directory)).toThrow(HarnessError);
  expect(() => parseLabConfig({...config(), observerKubeconfig: 'file\nargument'}, directory)).toThrow(HarnessError);
  const filename = join(directory, 'lab.json');
  await writePrivate(filename, config());
  expect((await loadLabConfig(filename)).usernameFile).toBe(join(directory, 'username.txt'));
});

test('HAR-01 untrusted TLS, wrong hostname and approved CA are distinct', async () => {
  const key = join(directory, 'key.pem'), certificate = join(directory, 'ca.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', certificate,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost']);
  const ca = await readFile(certificate, 'utf8');
  const server = secureServer({key: await readFile(key), cert: ca}, (_, response) => { response.writeHead(401); response.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  try {
    await expect(verifiedEndpoint(`https://localhost:${port}`, 2000)).rejects.toMatchObject({code: 'TLS'});
    await expect(verifiedEndpoint(`https://127.0.0.1:${port}`, 2000, ca)).rejects.toMatchObject({code: 'TLS'});
    await verifiedEndpoint(`https://localhost:${port}`, 2000, ca);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('LIFE-03 browser mutation fence accepts only Stop for the exact owned UID', () => {
  const origin = 'https://dashboard.example.local';
  const url = new URL(origin + '/api/models/reg-123-cpu/stop');
  const body = {expectedRevision: 'generation:owned-uid:2'};
  expect(allowedOwnedStop(url, 'POST', body, origin, 'reg-123-cpu', 'owned-uid')).toBe(true);
  expect(allowedOwnedStop(url, 'POST', body, origin, 'reg-123-cpu', 'replacement-uid')).toBe(false);
  expect(allowedOwnedStop(url, 'GET', body, origin, 'reg-123-cpu', 'owned-uid')).toBe(false);
  expect(allowedOwnedStop(new URL(url + '?force=true'), 'POST', body, origin, 'reg-123-cpu', 'owned-uid')).toBe(false);
  expect(allowedOwnedStop(url, 'POST', {...body, force: true}, origin, 'reg-123-cpu', 'owned-uid')).toBe(false);
});

test('HAR-02 identity and boot changes abort before any action', () => {
  verifyIdentity(config(), appliance(), appliance(), [node()], [host()]);
  expect(() => verifyIdentity(config(), {...appliance(), metadata: {...appliance().metadata, uid: 'replacement'}}, appliance(), [node()], [host()])).toThrow('[IDENTITY]');
  expect(() => verifyIdentity(config(), appliance(), appliance(), [node()], [{...host(), bootId: 'old-boot'}])).toThrow('[HOST]');
  expect(() => verifyIdentity({...config(), expected: {...config().expected, nodes: [{...config().expected.nodes[0]!, bootId: 'old-boot'}]}}, appliance(), appliance(), [node()], [host()])).toThrow('[HOST]');
});

test('HAR-02 a vanished provider cannot silently shrink the engine matrix', () => {
  verifyCapabilities(config(), models());
  expect(() => verifyCapabilities({...config(), expected: {...config().expected, capabilities: [{target: 'nvidia-gpu', engines: ['VLLM']}]}}, models())).toThrow('[CAPABILITY]');
  expect(() => verifyCapabilities(config(), {...models(), computeTargets: {targets: [{id: 'cpu', available: true, engines: ['OLlama']}]}})).toThrow('[CAPABILITY]');
  expect(() => verifyCapabilities(config(), {...models(), computeTargets: {targets: [{id: 'cpu', available: false, engines: ['OLlama', 'VLLM']}]}})).toThrow('[CAPABILITY]');
});

test('HAR-03 pending operation, active local model and busy updates block safely', () => {
  verifyIdle([host()], models(), config());
  expect(() => verifyIdle([{...host(), operation: {requestId: 'fixture', action: 'configure-gpu-memory', phase: 'Pending'}}], models(), config())).toThrow('[BUSY]');
  expect(() => verifyIdle([host()], {...models(), activations: [{spec: {type: 'local', enabled: true}}]}, config())).toThrow('[BUSY]');
  verifyIdle([host()], {...models(), activations: [{spec: {type: 'local', enabled: false}}]}, config());
});

test('HAR-03 excessive namespace-admin or Secret permissions cannot be used as observer', () => {
  const rule = {verbs: ['get', 'list', 'watch'], apiGroups: [''], resources: ['pods', 'nodes']};
  verifyObserverRules({status: {incomplete: false, resourceRules: [rule]}});
  for (const variant of [{...rule, verbs: ['*']}, {...rule, verbs: ['patch']}, {...rule, resources: ['secrets']}, {...rule, resources: ['*']},
    {...rule, resources: ['pods/exec']}, {...rule, resources: ['nodes/proxy']}, {...rule, resources: ['pods/*']}]) {
    expect(() => verifyObserverRules({status: {incomplete: false, resourceRules: [variant]}})).toThrow('[OBSERVER]');
  }
  expect(() => verifyObserverRules({status: {incomplete: true, resourceRules: []}})).toThrow('[OBSERVER]');
  expect(() => verifyObserverRules({status: {incomplete: false, resourceRules: [rule], nonResourceRules: [{verbs: ['post']}]}})).toThrow('[OBSERVER]');
});

test('HAR-04 independent owners race via CAS; exactly one gets the lab', async () => {
  const store = new MemoryLease();
  const first = new LabLease(store, newRunId(), 'appliance-uid'), second = new LabLease(store, newRunId(), 'appliance-uid');
  const results = await Promise.allSettled([first.acquire(), second.acquire()]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  const owner = results[0]!.status === 'fulfilled' ? first : second;
  expect(store.value.spec.renewTime).toMatch(/\.\d{6}Z$/);
  await owner.heartbeat(); await owner.release();
  expect(store.value.spec.holderIdentity).toBe('');
});

test('HAR-04 Kubernetes Lease update requests structured output', async () => {
  class FakeStore extends KubernetesLeaseStore {
    protected override async command(args: string[], input?: string) {
      expect(args).toEqual(['replace', '-f', '-', '-o', 'json']);
      expect(JSON.parse(input ?? '{}').metadata.name).toBe('lab-lock');
      return JSON.stringify(lease());
    }
  }
  const store = new FakeStore('unused', 'magicstick-regression', 'lab-lock');
  expect((await store.replace(lease())).metadata.name).toBe('lab-lock');
});

test('HAR-04 stale lease is not stolen, lost heartbeat blocks mutations', async () => {
  let now = 1_000_000;
  const store = new MemoryLease(), owner = new LabLease(store, newRunId(), 'appliance-uid', () => now, 60);
  await owner.acquire(); now += 61_000;
  await expect(owner.assertHeld()).rejects.toMatchObject({code: 'LOCK_LOST'});
  await expect(new LabLease(store, newRunId(), 'appliance-uid', () => now).acquire()).rejects.toMatchObject({code: 'LOCK_STALE'});
  expect(store.value.spec.holderIdentity).toBe(owner.owner);
});

test('HAR-04 replaced owner and wrong target prevent heartbeat/release', async () => {
  const store = new MemoryLease(), owner = new LabLease(store, newRunId(), 'appliance-uid');
  await owner.acquire(); store.value.spec.holderIdentity = 'another-owner';
  await expect(owner.heartbeat()).rejects.toMatchObject({code: 'LOCK_LOST'});
  await expect(owner.release()).rejects.toMatchObject({code: 'LOCK_LOST'});
  expect(store.value.spec.holderIdentity).toBe('another-owner');
  store.value.spec.holderIdentity = owner.owner;
  await expect(owner.assertHeld()).rejects.toMatchObject({code: 'LOCK_LOST'});
  await expect(new LabLease(new MemoryLease(), newRunId(), 'wrong-target').acquire()).rejects.toMatchObject({code: 'IDENTITY'});
  const alternate = new MemoryLease(); alternate.value.metadata.name = 'another-lock';
  await expect(new LabLease(alternate, newRunId(), 'appliance-uid').acquire()).rejects.toMatchObject({code: 'IDENTITY'});
});

test('HAR-04 a read failure between ownership check and heartbeat permanently fences the owner', async () => {
  const store = new MemoryLease(), owner = new LabLease(store, newRunId(), 'appliance-uid');
  await owner.acquire();
  const original = store.read.bind(store); let reads = 0;
  store.read = async () => { if (++reads === 2) throw new Error('synthetic unavailable API'); return original(); };
  await expect(owner.heartbeat()).rejects.toMatchObject({code: 'LOCK_LOST'});
  store.read = original;
  await expect(owner.assertHeld()).rejects.toMatchObject({code: 'LOCK_LOST'});
  expect(store.value.spec.holderIdentity).toBe(owner.owner);
});

function cleanupAdapters(resources: Map<string, string>, removed: string[]): Record<ResourceKind, CleanupAdapter> {
  const adapter: CleanupAdapter = {
    async lookup(entry) { const uid = resources.get(entry.name); return uid ? {uid} : null; },
    async removeIfUid(entry, uid) { if (resources.get(entry.name) !== uid) throw new HarnessError('OWNERSHIP'); resources.delete(entry.name); removed.push(entry.name); },
    async verifyRemoved(entry) { return !resources.has(entry.name); },
  };
  return {model: adapter, app: adapter, key: adapter, identity: adapter};
}

test('HAR-05 journal records only owned UIDs; changed-UID same-prefix resource survives', async () => {
  const journal = await ResourceJournal.create(join(directory, 'journal.json'), newRunId(), 'appliance-uid');
  const name = journal.prefix + 'model';
  await journal.requested('model', name); await journal.owned('model', name, 'original-uid');
  const resources = new Map([[name, 'replacement-uid'], ['unrelated-model', 'other-uid']]), removed: string[] = [];
  await expect(journal.cleanup(cleanupAdapters(resources, removed), async () => {})).rejects.toMatchObject({code: 'CLEANUP'});
  expect(removed).toEqual([]); expect(resources.size).toBe(2);
  expect((await lstat(join(directory, 'journal.json'))).mode & 0o077).toBe(0);
});

test('HAR-05 API-key adapter revokes only an exact run-owned immutable ID', async () => {
  const prefix = 'reg-' + newRunId().slice(4, 16) + '-';
  const id = 'a'.repeat(64), existingId = 'b'.repeat(64), name = prefix + 'key';
  const items = [{id: existingId, name: 'existing-key'}];
  const response = (status: number, value: unknown) => ({status: () => status,
    headers: () => ({'content-type': 'application/json'}), body: async () => Buffer.from(JSON.stringify(value))});
  const request = {fetch: async (url: string, options: {method: string; data?: string; headers: Record<string, string>}) => {
    expect(new URL(url).origin).toBe('https://dashboard.example.local');
    if (options.method === 'GET') return response(200, {items, total: items.length});
    expect(options.headers.origin).toBe('https://dashboard.example.local');
    expect(options.headers['x-magicstick-csrf']).toBe('dashboard');
    if (options.method === 'POST') {
      expect(JSON.parse(options.data ?? '{}')).toEqual({name});
      items.push({id, name});
      return response(201, {item: {id, name}, key: 'sk-synthetic-fixture'});
    }
    expect(options.method).toBe('DELETE');
    expect(new URL(url).pathname).toBe('/api/api-access/' + id);
    items.splice(items.findIndex(item => item.id === id), 1);
    return response(200, {deleted: id});
  }} as unknown as APIRequestContext;
  const client = new OwnedKeyClient(request, 'https://dashboard.example.local', 500, prefix, []);
  const entry = {kind: 'key' as const, name, uid: id, state: 'owned' as const};
  await expect(client.adapter().removeIfUid(entry, id)).rejects.toMatchObject({code: 'OWNERSHIP'});
  await expect(client.create('unrelated-key')).rejects.toMatchObject({code: 'OWNERSHIP'});
  expect(await client.create(name)).toBe(id);
  expect(await client.adapter().lookup(entry)).toEqual({uid: id});
  await client.adapter().removeIfUid(entry, id);
  expect(await client.adapter().verifyRemoved(entry)).toBe(true);
  expect(items).toEqual([{id: existingId, name: 'existing-key'}]);
});

test('HAR-06 failed scenario cleans only its owned fixtures; cleanup remains a separate gate', async () => {
  const journal = await ResourceJournal.create(join(directory, 'journal.json'), newRunId(), 'appliance-uid');
  const resources = new Map([['unrelated-model', 'keep-me']]), removed: string[] = [];
  for (const kind of ['model', 'app', 'key'] as const) {
    const name = journal.prefix + kind; await journal.requested(kind, name); await journal.owned(kind, name, kind + '-uid'); resources.set(name, kind + '-uid');
  }
  const originalFailure: CaseResult = {id: 'HAR-06', layer: 'fixture', outcome: 'Failed', reason: 'DEADLINE', durationMs: 1};
  await journal.cleanup(cleanupAdapters(resources, removed), async () => {});
  expect(resources).toEqual(new Map([['unrelated-model', 'keep-me']])); expect(removed).toHaveLength(3);
  expect(summarize(['HAR-06'], [originalFailure]).acceptable).toBe(false);
});

test('HAR-06 lost lease and atomic-delete conflict cannot delete a replacement', async () => {
  const journal = await ResourceJournal.create(join(directory, 'journal.json'), newRunId(), 'appliance-uid');
  const name = journal.prefix + 'model'; await journal.requested('model', name); await journal.owned('model', name, 'original');
  const resources = new Map([[name, 'original']]), removed: string[] = [];
  const adapters = cleanupAdapters(resources, removed), base = adapters.model.removeIfUid;
  adapters.model.removeIfUid = async (entry, uid) => { resources.set(name, 'replacement'); await base(entry, uid); };
  await expect(journal.cleanup(adapters, async () => {})).rejects.toMatchObject({code: 'CLEANUP'});
  expect(resources.get(name)).toBe('replacement'); expect(removed).toEqual([]);
});

test('HAR-06 lease loss before removal preserves the owned resource', async () => {
  const journal = await ResourceJournal.create(join(directory, 'journal.json'), newRunId(), 'appliance-uid');
  const name = journal.prefix + 'model'; await journal.requested('model', name); await journal.owned('model', name, 'original');
  const resources = new Map([[name, 'original']]), removed: string[] = []; let checks = 0;
  await expect(journal.cleanup(cleanupAdapters(resources, removed), async () => {
    if (++checks === 2) throw new HarnessError('LOCK_LOST');
  })).rejects.toMatchObject({code: 'CLEANUP'});
  expect(resources.get(name)).toBe('original'); expect(removed).toEqual([]);
  expect(journal.recoveryPlan()[0]?.state).toBe('blocked');
});

test('HAR-07 interrupted owned journal resumes, ambiguous creation is not retried', async () => {
  const filename = join(directory, 'journal.json'), journal = await ResourceJournal.create(filename, newRunId(), 'appliance-uid');
  const name = journal.prefix + 'model'; await journal.requested('model', name); await journal.owned('model', name, 'owned-uid');
  const resumed = await ResourceJournal.resume(filename, 'appliance-uid'), removed: string[] = [], resources = new Map([[name, 'owned-uid']]);
  await resumed.cleanup(cleanupAdapters(resources, removed), async () => {}); expect(removed).toEqual([name]);
  await expect(ResourceJournal.resume(filename, 'different-target')).rejects.toMatchObject({code: 'OWNERSHIP'});
  const pending = await ResourceJournal.create(join(directory, 'pending.json'), newRunId(), 'appliance-uid');
  await pending.requested('key', pending.prefix + 'key');
  expect(pending.recoveryPlan()[0]?.automaticallyRemovable).toBe(false);
  await expect(pending.cleanup(cleanupAdapters(resources, removed), async () => {})).rejects.toMatchObject({code: 'CLEANUP'});
  expect(removed).toEqual([name]);
});

test('HAR-05 model cleaner denies excess RBAC and uses atomic UID plus resourceVersion preconditions', async () => {
  const review = {status: {incomplete: false, resourceRules: [
    {apiGroups: ['appliance.magicstick.dev'], resources: ['modelactivations'], verbs: ['get', 'list', 'delete']},
    {apiGroups: ['authorization.k8s.io'], resources: ['selfsubjectrulesreviews'], verbs: ['create']},
  ]}};
  verifyModelCleanerRules(review);
  for (const extra of ['secrets', 'pods', 'modelactivations/status', '*']) {
    expect(() => verifyModelCleanerRules({status: {...review.status, resourceRules: [...review.status.resourceRules,
      {apiGroups: [''], resources: [extra], verbs: ['get']}]}})).toThrow('[OBSERVER]');
  }
  const name = 'reg-aabbccddeeff-cpu', uid = 'owned-model-uid';
  class FakeCleaner extends KubernetesModelCleaner {
    current = {metadata: {name, namespace: 'ai-system', uid, generation: 3, resourceVersion: '28',
      labels: {'app.kubernetes.io/managed-by': 'ai-appliance-dashboard'}}, spec: {type: 'local', targetNamespace: 'ai'}};
    deleted = false;
    override async find() { return this.deleted ? null : structuredClone(this.current); }
    protected override async command(args: string[], input?: string) {
      expect(args).toEqual(['delete', '--raw', `/apis/appliance.magicstick.dev/v1alpha1/namespaces/ai-system/modelactivations/${name}`, '-f', '-']);
      expect(JSON.parse(input ?? '{}').preconditions).toEqual({uid, resourceVersion: '28'});
      this.deleted = true; return '{}';
    }
  }
  const cleaner = new FakeCleaner('unused', 'ai-system');
  const entry = {kind: 'model' as const, name, uid, generation: 3, state: 'owned' as const};
  const adapter = cleaner.adapter('reg-aabbccddeeff-', async () => ({podCount: 0, catalogCount: 0}));
  expect(await adapter.lookup(entry)).toEqual({uid});
  await expect(adapter.removeIfUid({...entry, generation: 2}, uid)).rejects.toMatchObject({code: 'OWNERSHIP'});
  await adapter.removeIfUid(entry, uid);
  expect(await adapter.verifyRemoved(entry)).toBe(true);
});

test('HAR-07 blocked model cleanup can resume only at the journaled generation', async () => {
  const filename = join(directory, 'journal.json');
  const journal = await ResourceJournal.create(filename, newRunId(), 'appliance-uid');
  const name = journal.prefix + 'cpu';
  await journal.requested('model', name);
  await journal.owned('model', name, 'original-uid', 1);
  await journal.modelGeneration(name, 'original-uid', 1, 2);
  const resources = new Map([[name, 'original-uid']]), removed: string[] = [];
  await expect(journal.cleanup(cleanupAdapters(resources, removed), async () => { throw new HarnessError('LOCK_LOST'); }))
    .rejects.toMatchObject({code: 'CLEANUP'});
  const resumed = await ResourceJournal.resume(filename, 'appliance-uid');
  expect(resumed.recoveryPlan()[0]).toMatchObject({state: 'blocked', generation: 2, automaticallyRemovable: true});
  await resumed.cleanup(cleanupAdapters(resources, removed), async () => {});
  expect(removed).toEqual([name]);
  await expect(resumed.modelGeneration(name, 'original-uid', 2, 3)).rejects.toMatchObject({code: 'OWNERSHIP'});
});

test('LIFE-01 CPU smoke fixture is selected from the deployed catalog and API transport fences writes', async () => {
  const fixture = {engine: 'OLlama' as const, computeTarget: 'cpu' as const,
    url: 'ollama://qwen2.5:0.5b-instruct-q4_K_M', memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1 as const};
  const payload: ModelsPayload = {...models(), presets: {tiny: {variants: [{engine: 'OLlama', computeTarget: 'cpu',
    artifacts: [{url: fixture.url}]}]}}};
  fixtureIsAdvertised(payload, fixture);
  expect(() => fixtureIsAdvertised({...payload, presets: {}}, fixture)).toThrow('[CAPABILITY]');
  const prefix = 'reg-aabbccddeeff-', name = prefix + 'cpu', uid = 'model-uid';
  let active = false;
  const response = (value: unknown) => ({status: () => 200, headers: () => ({'content-type': 'application/json'}),
    body: async () => Buffer.from(JSON.stringify(value))});
  const request = {fetch: async (url: string, options: {method: string; data?: string; headers: Record<string, string>}) => {
    expect(new URL(url).origin).toBe('https://dashboard.example.local');
    if (options.method === 'GET') return response({...payload, activations: active ? [
      {metadata: {name, uid, generation: 1}, spec: {type: 'local', enabled: true, local: {engine: 'OLlama'}}}] : []});
    expect(options.headers.origin).toBe('https://dashboard.example.local');
    expect(options.headers['x-magicstick-csrf']).toBe('dashboard');
    expect(new URL(url).pathname).toBe('/api/models/local');
    expect(JSON.parse(options.data ?? '{}')).toEqual({name, enabled: true, targetNamespace: 'ai', local: {
      modelType: 'chat', computeTarget: 'cpu', engine: 'OLlama', url: fixture.url, contextWindow: 2048,
      maxNumSeqs: 1, memoryRequiredMi: 2048}});
    active = true; return response({metadata: {name, uid, namespace: 'ai-system', generation: 1}});
  }} as unknown as APIRequestContext;
  const client = new OwnedModelClient(request, 'https://dashboard.example.local', 500, name, fixture, prefix);
  expect(await client.create()).toEqual({uid, generation: 1});
  await expect(client.create()).rejects.toMatchObject({code: 'OWNERSHIP'});
  expect(editRevision({metadata: {uid, generation: 2}})).toBe(`generation:${uid}:2`);
  expect(activation({...payload, activations: []}, name)).toBeNull();
  expect(ownedRuntimePods([{metadata: {name: 'pod', namespace: 'ai', labels: {app: 'model', model: name},
    ownerReferences: [{uid: 'kubeai-uid', kind: 'Model', name, controller: true}]}}], name)).toHaveLength(1);
});

test('ROUTE-01 inference probe checks bounded chat response without exposing the key', async () => {
  const name = 'reg-aabbccddeeff-cpu';
  const request = {fetch: async (url: string, options: {method: string; headers: Record<string, string>}) => {
    expect(options.headers.Authorization).toBe('Bearer sk-fixture-private');
    if (url.endsWith('/v1/models')) return {status: () => 200, headers: () => ({'content-type': 'application/json'}),
      body: async () => Buffer.from('{}'), json: async () => ({data: [{id: name}]})};
    return {status: () => 200, headers: () => ({'content-type': 'application/json'}), body: async () => Buffer.from('{}'),
      json: async () => ({model: name, choices: [{message: {content: 'yes'}}]})};
  }} as unknown as APIRequestContext;
  const probe = new InferenceProbe(request, 'https://litellm.example.local', 'sk-fixture-private');
  expect(await probe.advertised(name)).toBe(true);
  await probe.chat(name);
});

test('HAR-07 symlinked journal and public-readable credentials are rejected', async () => {
  const target = join(directory, 'private.json'), link = join(directory, 'symlink.json');
  await writePrivate(target, {password: 'synthetic-secret'}); await symlink(target, link);
  await expect(readPrivate(link)).rejects.toMatchObject({code: 'PRIVATE_FILE'});
  await expect(writePrivate(link, {})).rejects.toMatchObject({code: 'PRIVATE_FILE'});
  await chmod(target, 0o644); await expect(readPrivate(target)).rejects.toMatchObject({code: 'PRIVATE_FILE'});
});

test('HAR-07 journal creation cannot overwrite recovery evidence; malformed ownership is rejected', async () => {
  const filename = join(directory, 'journal.json');
  const results = await Promise.allSettled([
    ResourceJournal.create(filename, newRunId(), 'appliance-uid'),
    ResourceJournal.create(filename, newRunId(), 'appliance-uid'),
  ]);
  expect(results.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  const before = await readPrivate(filename);
  await expect(ResourceJournal.create(filename, newRunId(), 'appliance-uid')).rejects.toMatchObject({code: 'PRIVATE_FILE'});
  expect(await readPrivate(filename)).toBe(before);
  const original = JSON.parse(before);
  await writePrivate(filename, {...original, entries: [{kind: 'model', name: original.prefix + 'model', uid: null, state: 'owned'}]});
  await expect(ResourceJournal.resume(filename, 'appliance-uid')).rejects.toMatchObject({code: 'OWNERSHIP'});
  await writePrivate(filename, null);
  await expect(ResourceJournal.resume(filename, 'appliance-uid')).rejects.toMatchObject({code: 'OWNERSHIP'});
});

test('HAR-08 human revision change prevents global restoration', async () => {
  let restored = false;
  await expect(restoreRevision({mode: 'exclusive'}, 'our-revision', {async currentRevision() { return 'human-edit'; },
    async restore() { restored = true; }}, async () => {})).rejects.toMatchObject({code: 'CONFLICT'});
  expect(restored).toBe(false);
  await restoreRevision({mode: 'exclusive'}, 'our-revision', {async currentRevision() { return 'our-revision'; },
    async restore(_, revision) { expect(revision).toBe('our-revision'); restored = true; }}, async () => {});
  expect(restored).toBe(true);
});

test('HAR-09 polling does not accept old Ready/generation, late evidence or read failures', async () => {
  let now = 0, reads = 0;
  const ready = (generation: number) => ({metadata: {uid: 'uid', generation: 2}, status: {conditions: [{type: 'Ready', status: 'True', observedGeneration: generation}]}});
  const value = await poll(async () => ready(++reads < 3 ? 1 : 2), item => currentReady(item, 'uid', 2),
    {timeoutMs: 1000, now: () => now, wait: async ms => { now += ms; }});
  expect(currentReady(value, 'uid', 2)).toBe(true); expect(reads).toBe(3);
  expect(currentReady(value, 'replacement', 2)).toBe(false);
  await expect(poll(async () => { now += 100; return ready(2); }, item => currentReady(item, 'uid', 2),
    {timeoutMs: 10, now: () => now})).rejects.toMatchObject({code: 'DEADLINE'});
  await expect(poll(async () => { throw new HarnessError('API'); }, () => true, {timeoutMs: 100})).rejects.toMatchObject({code: 'API'});
  await expect(poll(() => new Promise(() => {}), () => true, {timeoutMs: 50})).rejects.toMatchObject({code: 'DEADLINE'});
});

test('HAR-10 empty, missing, blocked, skipped and flaky results cannot produce green acceptance', async () => {
  const passed: CaseResult = {id: 'HAR-01', outcome: 'Passed', layer: 'fixture', durationMs: 10};
  expect(summarize(['HAR-01'], [passed]).acceptable).toBe(true);
  expect(summarize([], []).acceptable).toBe(false);
  expect(summarize(['HAR-01', 'HAR-02'], [passed]).missing).toEqual(['HAR-02']);
  for (const outcome of ['Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'] as const) {
    expect(summarize(['HAR-01'], [{...passed, outcome}]).acceptable).toBe(false);
  }
  await saveReport(directory, newRunId(), [{...passed, outcome: 'Blocked', reason: 'TLS'}], ['HAR-01', 'HAR-02']);
  const xml = await readFile(join(directory, 'junit.xml'), 'utf8');
  expect(xml).toContain('failures="2"'); expect(xml).toContain('name="HAR-02"');
});

test('HAR-11 reports allowlist fields and redact seeded credentials, headers, URLs and auth state', async () => {
  const secret = 'synthetic-secret', seeded = {authorization: 'Bearer ' + secret, cookie: secret, password: secret, invitation: secret,
    storageState: {cookies: [secret]}, nested: {message: `https://example.local/?access_token=${secret} Bearer ${secret}`}};
  expect(JSON.stringify(redact(seeded, [secret]))).not.toContain(secret);
  const result = {id: 'HAR-11', outcome: 'Passed', layer: 'fixture', durationMs: 1, raw: seeded, password: secret} as CaseResult;
  await saveReport(directory, newRunId(), [result], ['HAR-11'], secret);
  for (const filename of ['summary.json', 'summary.txt', 'junit.xml']) {
    const text = await readFile(join(directory, filename), 'utf8'); expect(text).not.toContain(secret); expect(text).not.toContain('storageState');
    expect((await lstat(join(directory, filename))).mode & 0o077).toBe(0);
  }
  const baseline = JSON.stringify(safeBaseline(config(), [node()], [], models(), []));
  expect(baseline).not.toContain('fixture-node'); expect(baseline).not.toContain('node-uid'); expect(baseline).not.toContain('appliance-uid');
});

test('HAR-01 HAR-11 real Chromium fixture login and shared API client; no product writes or traces', async ({browser}) => {
  // Synthetic loopback HTTP fixture only. Production configuration rejects HTTP.
  let dashboardUrl = '', identityUrl = '', loginPosted = false;
  const username = 'fixture-admin', password = 'synthetic-password';
  await writeFile(join(directory, 'username.txt'), username, {mode: 0o600});
  await writeFile(join(directory, 'password.txt'), password, {mode: 0o600});
  const identity = createServer((request, response) => {
    if (request.method === 'POST') {
      let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
        const form = new URLSearchParams(body); loginPosted = form.get('username') === username && form.get('password') === password;
        response.writeHead(302, {Location: dashboardUrl + '/?callback=fixture'}); response.end();
      }); return;
    }
    response.setHeader('Content-Type', 'text/html'); response.end(`<form action="${identityUrl}/login" method="post"><input id="username" name="username"><input id="password" name="password" type="password"><button id="kc-login">Sign in</button></form>`);
  });
  const dashboard = createServer((request, response) => {
    if (request.url?.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json');
      if (!request.headers.cookie?.includes('fixture-session=logged-in')) { response.writeHead(401); response.end('{}'); return; }
      response.end(JSON.stringify(request.url === '/api/session' ? {subject: 'fixture-subject', username, roles: ['magicstick-admin']} : appliance())); return;
    }
    if (loginPosted && request.url?.startsWith('/?callback=fixture')) {
      response.setHeader('Set-Cookie', 'fixture-session=logged-in; HttpOnly; SameSite=Lax; Path=/'); response.end('<h1>Synthetic dashboard</h1>'); return;
    }
    response.writeHead(302, {Location: identityUrl + '/login'}); response.end();
  });
  await new Promise<void>(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  await new Promise<void>(resolve => identity.listen(0, '127.0.0.1', resolve));
  dashboardUrl = `http://127.0.0.1:${(dashboard.address() as {port: number}).port}`;
  identityUrl = `http://127.0.0.1:${(identity.address() as {port: number}).port}`;
  try {
    const context = await realLogin(browser, {...config(), dashboardUrl, identityUrl, usernameFile: join(directory, 'username.txt'), passwordFile: join(directory, 'password.txt')});
    try {
      const api = readOnlyApi(context.request, dashboardUrl, 3000);
      expect((await api.session()).username).toBe(username);
      expect((await api.appliance()).metadata?.uid).toBe('appliance-uid');
      await expect(api.createLocalModel({name: 'must-not-be-created'})).rejects.toMatchObject({code: 'MUTATION'});
      await expect(api.removeModel('must-not-be-removed')).rejects.toMatchObject({code: 'MUTATION'});
      await expect(readOnlyFetch(context.request, dashboardUrl, 500)(identityUrl + '/api/session')).rejects.toMatchObject({code: 'MUTATION'});
    } finally { await context.close(); }
  } finally {
    await Promise.all([new Promise<void>(resolve => dashboard.close(() => resolve())), new Promise<void>(resolve => identity.close(() => resolve()))]);
  }
});
