import {test, expect, type APIRequestContext,type BrowserContext} from '@playwright/test';
import {mkdtemp, rm, writeFile, lstat, readFile, chmod, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
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
import {summarize, saveReport, liveReportScope, redact, stepCases, type CaseResult} from '../core/report.ts';
import {safeBaseline, verifiedEndpoint, verifyCapabilities, verifyIdentity, verifyIdle} from '../core/preflight.ts';
import {allowedExactDashboardRequest, allowedOwnedContextEdit, allowedOwnedEstimate, allowedOwnedStart, allowedOwnedStop, allowedOwnedKeyChange, realLogin,openInferenceSession} from '../core/auth.ts';
import {failureOutcome} from '../reporter.ts';
import {readOnlyApi, readOnlyFetch} from '../core/transport.ts';
import {KubernetesLeaseStore, verifyObserverRules, type KubeObject} from '../core/observer.ts';
import {OwnedKeyClient} from '../core/owned-key.ts';
import {KubernetesModelCleaner, verifyModelCleanerRules} from '../core/model-cleanup.ts';
import {ModelCreateRejected, OwnedModelClient, activation, editRevision, fixtureIsAdvertised, hasRuntimeCrashLoop, ownedRuntimePods} from '../core/owned-model.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {InferenceProbe} from '../core/inference.ts';
import {phase0Ids, phase0Variants, phase0Coverage, requirePhase0Profile, type Phase0Variant} from '../profiles/phase0-p0.ts';
import {phase1Ids, phase1Variants, phase1Requirements, phase1Coverage} from '../profiles/phase1-p0.ts';
import {phase2Coverage, phase2Ids, phase2ModelCases, phase2ModelIds, phase2Requirements, phase2Variants, requirePhase2Profile} from '../profiles/phase2-p0.ts';
import {fileLayer} from '../core/evidence.ts';
import {typeScriptWorkerArgs} from '../core/node-worker.ts';

let directory: string;
test.beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'magicstick-harness-')); });
test.afterEach(async () => { await rm(directory, {recursive: true, force: true}); });

function config(): LabConfig {
  return {version: 1, profile: 'preflight', dashboardUrl: 'https://dashboard.example.local', identityUrl: 'https://id.example.local',
    usernameFile: 'username.txt', passwordFile: 'password.txt', observerKubeconfig: 'observer.yaml', requestTimeoutMs: 500, loginTimeoutMs: 5000,
    expected: {applianceUid: 'appliance-uid', applianceNamespace: 'ai-system', applianceName: 'local', role: 'magicstick-admin',
      nodes: [{name: 'fixture-node', uid: 'node-uid'}], capabilities: [{target: 'cpu', engines: ['OLlama', 'VLLM']}], images: []}};
}
function phase2Config(): LabConfig {
  const value = config();
  value.inferenceUrl = 'https://inference.example.local';
  value.lock = {namespace: 'magicstick-regression', name: 'lab-lock', kubeconfig: 'locker.yaml'};
  value.modelCleanupKubeconfig = 'cleaner.yaml';
  value.smokeModel = {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://synthetic:latest',
    memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1};
  value.phase2 = {
    ollamaModel: {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://synthetic:latest', memoryRequiredMi: 2000,
      contextWindow: 2048, maxNumSeqs: 1, kvCacheType: 'f16'},
    vllmModel: {engine: 'VLLM', computeTarget: 'cpu', url: 'hf://example/synthetic', memoryRequiredMi: 4100,
      contextWindow: 2048, maxNumSeqs: 1, kvCacheType: 'auto'},
    failureModel: {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://missing/synthetic:never',
      memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1, expectedReason: 'model download failed'},
    externalModel: {model: 'provider/synthetic', apiBase: 'https://provider.example.local/v1', contextWindow: 4096},
    discovery: {query: 'synthetic', repo: 'example/synthetic', artifactUrl: 'hf://example/synthetic'},
  };
  value.expected.nodes[0]!.bootId = 'boot-uid';
  value.expected.flux = {namespace: 'flux-system', name: 'flux-system', revision: 'sha1:' + 'a'.repeat(40)};
  value.expected.images = ['web', 'api'].map(container => ({namespace: 'fixture', deployment: container, container,
    digest: 'sha256:' + 'b'.repeat(64)}));
  return value;
}
function host(): ManagedHost {
  return {name: 'fixture-node', nodeUid: 'node-uid', bootId: 'boot-uid', kernel: '7.0.0-test', available: true, message: 'Synthetic'};
}
function node(): KubeObject {
  return {metadata: {name: 'fixture-node', uid: 'node-uid'}, status: {nodeInfo: {bootID: 'boot-uid', kernelVersion: '7.0.0-test'}, conditions: [{type: 'Ready', status: 'True'}]}};
}
function models(): ModelsPayload { return {activations: [], presets: {}, computeTargets: {targets: [{id: 'cpu', available: true, engines: ['OLlama', 'VLLM']}]}}; }
// Exercise the real create orchestration with inert adapters, without opening a
// browser session or granting any cluster credentials to an isolated test.
function creationFoundation(request: APIRequestContext, journal: ResourceJournal,
  find: (name: string) => Promise<KubeObject | null> = async () => null,
  guard: () => Promise<void> = async () => {}) {
  return Object.assign(Object.create(LiveFoundation.prototype), {
    context: {request}, config: phase2Config(), journal, cleaner: {find}, guard,
  }) as LiveFoundation;
}
function jsonResponse(value: unknown, status = 200) {
  return {status: () => status, headers: () => ({'content-type': 'application/json'}),
    body: async () => Buffer.from(JSON.stringify(value))};
}
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

test('HAR-02 complete Phase 0 refuses inventory-only source, image or boot profiles', () => {
  const selection = config();
  expect(() => requirePhase0Profile(selection)).toThrow('[CONFIG]');
  selection.lock = {namespace: 'magicstick-regression', name: 'lab-lock', kubeconfig: 'locker.yaml'};
  selection.modelCleanupKubeconfig = 'cleaner.yaml'; selection.inferenceUrl = 'https://inference.example.local';
  selection.smokeModel = {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://synthetic', memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1};
  selection.expected.nodes[0]!.bootId = 'boot-uid';
  selection.expected.flux = {namespace: 'flux-system', name: 'flux-system', revision: 'sha1:' + 'a'.repeat(40)};
  selection.expected.images = ['web', 'api'].map(container => ({namespace: 'fixture', deployment: container, container, digest: 'sha256:' + 'b'.repeat(64)}));
  requirePhase0Profile(selection);
  for (const field of ['images', 'flux'] as const) {
    const missing = structuredClone(selection);
    if (field === 'images') missing.expected.images = []; else delete missing.expected.flux;
    expect(() => requirePhase0Profile(missing)).toThrow('[CONFIG]');
  }
});

test('HAR-04 key and model transport guards prevent requests after heartbeat failure', async () => {
  const prefix = 'reg-aabbccddeeff-', name = prefix + 'cpu';
  let writes = 0;
  const request = {fetch: async (_url: string, options: {method: string}) => {
    if (options.method !== 'GET') writes++;
    return {status: () => 200, headers: () => ({'content-type': 'application/json'}), body: async () => Buffer.from(JSON.stringify(models()))};
  }} as unknown as APIRequestContext;
  const guard = async () => { throw new HarnessError('LOCK_LOST'); };
  const keys = new OwnedKeyClient(request, 'https://dashboard.example.local', 500, prefix, [], guard);
  const model = new OwnedModelClient(request, 'https://dashboard.example.local', 500, name,
    {engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://synthetic', memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1}, prefix, guard);
  await expect(keys.create(prefix + 'key')).rejects.toMatchObject({code: 'LOCK_LOST'});
  await expect(model.create()).rejects.toMatchObject({code: 'LOCK_LOST'});
  expect(writes).toBe(0);
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

test('KEY-01, KEY-03 UI key fence rejects other names, IDs, hosts and extra fields', () => {
  const origin = 'https://dashboard.example.local', name = 'reg-aabbccddeeff-key', id = 'owned-key-0123456789';
  const create = new URL(origin + '/api/api-access'), remove = new URL(origin + '/api/api-access/' + id);
  expect(allowedOwnedKeyChange(create, 'POST', {name}, origin, name)).toBe(true);
  expect(allowedOwnedKeyChange(create, 'POST', {name: 'unrelated'}, origin, name)).toBe(false);
  expect(allowedOwnedKeyChange(create, 'POST', {name, role: 'admin'}, origin, name)).toBe(false);
  expect(allowedOwnedKeyChange(new URL(create + '?force=true'), 'POST', {name}, origin, name)).toBe(false);
  expect(allowedOwnedKeyChange(remove, 'DELETE', null, origin, undefined, id)).toBe(true);
  expect(allowedOwnedKeyChange(remove, 'DELETE', {}, origin, undefined, id)).toBe(false);
  expect(allowedOwnedKeyChange(remove, 'DELETE', null, origin, undefined, 'other-key-0123456789')).toBe(false);
  expect(allowedOwnedKeyChange(remove, 'DELETE', null, 'https://other.example.local', undefined, id)).toBe(false);
});

test('KEY-01 browser key adoption requires the exact requested name and immutable ID', () => {
  const prefix = 'reg-aabbccddeeff-', name = prefix + 'key';
  const keys = new OwnedKeyClient({} as APIRequestContext, 'https://dashboard.example.local', 100, prefix, [], async () => {});
  const response = {item: {id: 'owned-key-0123456789', name}, key: 'sk-synthetic-never-live'};
  expect(keys.adoptCredential(name, response).id).toBe(response.item.id);
  expect(() => keys.adoptCredential(name, {...response, item: {...response.item, name: 'unrelated'}})).toThrow('[API]');
  expect(() => keys.adoptCredential(name, {...response, item: {...response.item, id: '../other'}})).toThrow('[API]');
  expect(() => keys.adoptCredential('unrelated-key', response)).toThrow('[OWNERSHIP]');
});

test('HAR-10 Phase 1 requires every Test-ID variant and canonical layer and fails incomplete JUnit', async () => {
  for (const [suffix, layer] of [['unit', 'U'], ['contract', 'C'], ['browser', 'B'], ['api', 'A'], ['e2e', 'E']]) {
    expect(fileLayer(`domain/behavior.${suffix}.spec.ts`)).toBe(layer);
  }
  expect(fileLayer('phase1.spec.ts')).toBeUndefined();
  const cases: CaseResult[] = phase1Requirements.map(item => ({id: item.id, variant: item.variant,
    layer: item.layer, environment: item.environment, outcome: 'Passed', durationMs: 1}));
  expect((await saveReport(directory, newRunId(), cases, phase1Ids, 'a'.repeat(40), 'phase1')).fullPhase1Accepted).toBe(true);
  expect(JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')).version).toBe(2);
  await expect(saveReport(directory, newRunId(), [{id: 'HAR-10', layer: 'U', environment: 'live', outcome: 'Passed', durationMs: 1}], ['HAR-10'])).rejects.toThrow('[CONFIG]');
  for (const variant of Object.keys(phase1Variants)) {
    expect(phase1Coverage(cases.filter(item => item.variant !== variant)).complete).toBe(false);
  }
  for (let index = 0; index < cases.length; index++) {
    expect(phase1Coverage(cases.filter((_item, selected) => selected !== index)).complete).toBe(false);
  }
  expect(phase1Coverage(cases.map(item => ({...item, layer: 'A', environment: 'live'}))).complete).toBe(false);
  expect(phase1Coverage([...cases, {...cases[0]!, outcome: 'Flaky'}]).complete).toBe(false);
  expect(phase1Coverage(stepCases(cases, 1, true, false)).complete).toBe(false);
  expect(phase1Coverage(stepCases(cases, 0, false, false)).complete).toBe(false);
  const blocked: CaseResult[] = [{id: 'HAR-01', outcome: 'Blocked', layer: 'A', environment: 'live', durationMs: 1, reason: 'AUTH'}];
  expect(stepCases(blocked, 1, false, false)).toEqual(blocked);
  const partial = await saveReport(directory, newRunId(), cases.filter(item => item.variant !== 'ui-start'), phase1Ids, 'a'.repeat(40), 'phase1');
  expect(partial.acceptable).toBe(false); expect(partial.fullPhase1Accepted).toBe(false);
  expect(await readFile(join(directory, 'junit.xml'), 'utf8')).toContain('LIFE-04/ui-start');
  expect(await readFile(join(directory, 'junit.xml'), 'utf8')).toContain('<skipped type="Blocked"');
});

test('ROUTE-06 auth-negative probe cannot accept a success or model-not-found as key rejection', async () => {
  let status = 401;
  const seen: Array<Record<string, string>> = [];
  const request = {fetch: async (_url: string, options: {headers: Record<string, string>}) => {
    seen.push(options.headers);
    return {status: () => status, headers: () => ({'content-type': 'application/json'}),
      body: async () => Buffer.from('{"error":"synthetic"}'), json: async () => ({error: 'synthetic'})};
  }} as unknown as APIRequestContext;
  const probe = new InferenceProbe(request, 'https://inference.example.local', 'sk-synthetic-never-live');
  await probe.refusesUnauthorized('fixture', 'missing'); expect(seen[0]?.Authorization).toBeUndefined();
  await probe.refusesUnauthorized('fixture', 'invalid'); expect(seen[1]?.Authorization).toBe('Bearer sk-magicstick-regression-invalid');
  await probe.refusesUnauthorized('fixture', 'revoked'); expect(seen[2]?.Authorization).toBe('Bearer sk-synthetic-never-live');
  for (const wrong of [200, 400, 404, 500]) {
    status = wrong; await expect(probe.refusesUnauthorized('fixture', 'invalid')).rejects.toMatchObject({code: 'AUTH'});
  }
});

test('LIFE-07, LIFE-04 browser fence accepts only the owned CPU edit, estimate and Start', () => {
  const origin = 'https://dashboard.example.local', name = 'reg-123-cpu', uid = 'owned-uid';
  const revision = {expectedRevision: `generation:${uid}:2`};
  const edit = new URL(`${origin}/api/models/${name}`);
  const estimate = new URL(`${edit}/estimate-memory`);
  const start = new URL(`${edit}/start`);
  const editBody = {...revision, local: {contextWindow: 1024}};
  const estimateBody = {modelType: 'chat', contextWindow: 1024, maxOutputTokens: null,
    maxNumSeqs: 1, kvCacheType: 'f16', cpuOffloading: false, memoryRequiredMi: 2048};
  expect(allowedOwnedContextEdit(edit, 'PUT', editBody, origin, name, uid, 1024)).toBe(true);
  expect(allowedOwnedContextEdit(edit, 'PUT', {...editBody, local: {contextWindow: 1024, allowMemoryRisk: true}},
    origin, name, uid, 1024)).toBe(true);
  expect(allowedOwnedContextEdit(edit, 'PUT', editBody, origin, name, 'replacement-uid', 1024)).toBe(false);
  expect(allowedOwnedContextEdit(edit, 'PUT', {...editBody, local: {contextWindow: 1024, engine: 'VLLM'}}, origin, name, uid, 1024)).toBe(false);
  expect(allowedOwnedContextEdit(edit, 'PUT', {...editBody, local: {contextWindow: 1024, allowMemoryRisk: false}},
    origin, name, uid, 1024)).toBe(false);
  expect(allowedOwnedContextEdit(edit, 'PUT', editBody, origin, name, uid, 2048)).toBe(false);
  expect(allowedOwnedEstimate(estimate, 'POST', estimateBody, origin, name, uid, 2048)).toBe(true);
  expect(allowedOwnedEstimate(estimate, 'POST', {...estimateBody, contextWindow: 0}, origin, name, uid, 2048)).toBe(true);
  expect(allowedOwnedEstimate(estimate, 'POST', {...estimateBody, contextWindow: -1}, origin, name, uid, 2048)).toBe(false);
  expect(allowedOwnedEstimate(estimate, 'POST', {...estimateBody, contextWindow: 4097}, origin, name, uid, 2048)).toBe(false);
  expect(allowedOwnedEstimate(estimate, 'POST', {...estimateBody, memoryRequiredMi: 4096}, origin, name, uid, 2048)).toBe(false);
  expect(allowedOwnedEstimate(estimate, 'POST', {...estimateBody, cpuOffloading: true}, origin, name, uid, 2048)).toBe(false);
  expect(allowedOwnedStart(start, 'POST', revision, origin, name, uid)).toBe(true);
  expect(allowedOwnedStart(start, 'POST', {...revision, force: true}, origin, name, uid)).toBe(false);
  expect(allowedOwnedStart(start, 'POST', revision, origin, name, 'replacement-uid')).toBe(false);
});

test('HAR-10 live report scope distinguishes model edits from read-only preflight', () => {
  expect(liveReportScope('model-edit')).toContain('model edit');
  expect(liveReportScope('model-edit')).not.toContain('read-only');
  expect(liveReportScope('preflight')).toBe('read-only live preflight');
});

test('HAR-04 exact Phase 2 browser fence permits one reviewed request and rejects near matches', () => {
  const origin = 'https://dashboard.example.local';
  const expected = [{method: 'POST' as const, path: '/api/models/local', body: {
    name: 'reg-123-vllm', enabled: true, targetNamespace: 'ai', local: {engine: 'VLLM', computeTarget: 'cpu',
      url: 'hf://example/synthetic', contextWindow: 2048, maxNumSeqs: 1, kvCacheType: 'auto', memoryRequiredMi: 4096},
  }}];
  const url = new URL(origin + '/api/models/local');
  expect(allowedExactDashboardRequest(url, 'POST', structuredClone(expected[0]!.body), origin, expected)).toBe(expected[0]);
  expect(allowedExactDashboardRequest(url, 'POST', {...expected[0]!.body, enabled: false}, origin, expected)).toBeUndefined();
  expect(allowedExactDashboardRequest(new URL(url + '?force=true'), 'POST', expected[0]!.body, origin, expected)).toBeUndefined();
  expect(allowedExactDashboardRequest(url, 'PUT', expected[0]!.body, origin, expected)).toBeUndefined();
  expect(allowedExactDashboardRequest(url, 'POST', expected[0]!.body, 'https://other.example.local', expected)).toBeUndefined();
});

test('HAR-10 Phase 2 profile is strict and every exact variant-layer tuple is mandatory', async () => {
  const selection = phase2Config(); requirePhase2Profile(selection);
  const parsed = parseLabConfig(selection, directory); requirePhase2Profile(parsed);
  expect(parsed.phase2?.externalModel.apiBase).toBe('https://provider.example.local/v1');
  const owned = {...selection, phase2: {...selection.phase2!, externalModel: {
    source: 'owned-ollama', apiBase: 'http://kubeai.ai.svc.cluster.local/openai/v1', contextWindow: 4096,
  }}};
  expect(parseLabConfig(owned, directory).phase2?.externalModel.source).toBe('owned-ollama');
  for (const apiBase of ['http://provider.invalid/openai/v1', 'http://kubeai.ai.svc.cluster.local:8080/openai/v1',
    'http://kubeai.ai.svc.cluster.local/admin', 'http://user:secret@kubeai.ai.svc.cluster.local/openai/v1']) {
    expect(() => parseLabConfig({...owned, phase2: {...owned.phase2, externalModel: {...owned.phase2.externalModel, apiBase}}}, directory)).toThrow('[CONFIG]');
  }
  expect(() => parseLabConfig({...owned, phase2: {...owned.phase2, externalModel: {...owned.phase2.externalModel,
    model: 'someone-elses-model'}}}, directory)).toThrow('[CONFIG]');
  for (const invalid of [
    {...selection, phase2: {...selection.phase2!, externalModel: {...selection.phase2!.externalModel, apiBase: 'http://provider.invalid/v1'}}},
    {...selection, phase2: {...selection.phase2!, failureModel: {...selection.phase2!.failureModel, expectedReason: 'x'}}},
    {...selection, phase2: {...selection.phase2!, discovery: {...selection.phase2!.discovery, repo: '../escape'}}},
  ]) expect(() => parseLabConfig(invalid, directory)).toThrow('[CONFIG]');
  const cases: CaseResult[] = phase2Requirements.map(item => ({id: item.id, variant: item.variant,
    layer: item.layer, environment: item.environment, outcome: 'Passed', durationMs: 1}));
  expect(phase2Coverage(cases).complete).toBe(true);
  expect((await saveReport(directory, newRunId(), cases, phase2Ids, 'a'.repeat(40), 'phase2')).fullPhase2Accepted).toBe(true);
  const noFinalPreflight = await saveReport(directory, newRunId(), cases.filter(item => item.variant !== 'final-idle'),
    phase2Ids, 'a'.repeat(40), 'phase2');
  expect(noFinalPreflight.fullPhase2Accepted).toBe(false);
  expect(phase2ModelIds).not.toContain('DISC-01');
  expect(phase2ModelIds).not.toContain('HAR-03');
  expect(Object.keys(phase2ModelCases)).toEqual(['ollama', 'vllm', 'admission', 'memory-risk', 'external']);
  for (const selection of Object.values(phase2ModelCases)) {
    expect(selection.ids.every(id => phase2ModelIds.includes(id))).toBe(true);
  }
  for (const [selection, title] of [
    ['admission', 'ENG-10 unsupported target is rejected and raw runtime settings never enter saved intent'],
    ['memory-risk', 'MEM-05 API requires explicit memory-risk acceptance for a legal underbudget CPU definition'],
    ['external', 'ROUTE-05 external provider create, edit, Stop and Start preserve the controlled route'],
  ] as const) {
    // Playwright applies grep to the full title including the describe prefix.
    expect(new RegExp(phase2ModelCases[selection].grep).test('Phase 2 installed CPU model control ' + title)).toBe(true);
  }
  for (const variant of Object.keys(phase2Variants)) {
    expect(phase2Coverage(cases.filter(item => item.variant !== variant)).complete).toBe(false);
  }
  for (let index = 0; index < cases.length; index++) {
    expect(phase2Coverage(cases.filter((_item, selected) => selected !== index)).complete).toBe(false);
  }
  expect(phase2Coverage([...cases, {...cases[0]!, outcome: 'Flaky'}]).complete).toBe(false);
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

test('HAR-04 bounded maintenance reservation keeps one owner and returns to the ordinary deadline', async () => {
  let now=1_000_000;
  const store=new MemoryLease(),owner=new LabLease(store,newRunId(),'appliance-uid',()=>now,120);
  await owner.acquire();
  await expect(owner.reserveOfflineWindow(2101)).rejects.toMatchObject({code:'CONFIG'});
  await owner.reserveOfflineWindow(2100);
  await expect(owner.reserveOfflineWindow(2100)).rejects.toMatchObject({code:'CONFIG'});
  now+=600_000;await owner.assertHeld();
  await expect(new LabLease(store,newRunId(),'appliance-uid',()=>now).acquire()).rejects.toMatchObject({code:'LOCK_BUSY'});
  await owner.finishOfflineWindow();expect(store.value.spec.leaseDurationSeconds).toBe(120);
  await owner.release();expect(store.value.spec.holderIdentity).toBe('');
});

test('HAR-04 maintenance expiry or replacement cannot revive ownership for cleanup', async () => {
  for(const kind of ['expired','replaced']) {
    let now=1_000_000;
    const store=new MemoryLease(),owner=new LabLease(store,newRunId(),'appliance-uid',()=>now,120);
    await owner.acquire();await owner.reserveOfflineWindow(2100);
    if(kind === 'expired')now+=2100_000;else store.value.spec.holderIdentity='another-owner';
    await expect(owner.finishOfflineWindow()).rejects.toMatchObject({code:'LOCK_LOST'});
    await expect(owner.heartbeat()).rejects.toMatchObject({code:'LOCK_LOST'});
    await expect(owner.release()).rejects.toMatchObject({code:'LOCK_LOST'});
    expect(store.value.spec.holderIdentity).toBe(kind === 'expired' ? owner.owner : 'another-owner');
  }
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
  const client = new OwnedKeyClient(request, 'https://dashboard.example.local', 500, prefix, [], async () => {});
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
  const originalFailure: CaseResult = {id: 'HAR-06', layer: 'U', environment: 'fixture', outcome: 'Failed', reason: 'DEADLINE', durationMs: 1};
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
  const rejected = await ResourceJournal.create(join(directory, 'rejected.json'), newRunId(), 'appliance-uid');
  const rejectedName = rejected.prefix + 'model'; await rejected.requested('model', rejectedName);
  await rejected.rejected('model', rejectedName);
  expect(rejected.recoveryPlan()).toEqual([]);
  await expect(rejected.rejected('model', rejectedName)).rejects.toMatchObject({code: 'OWNERSHIP'});
  const resumedRejected = await ResourceJournal.resume(rejected.filename, 'appliance-uid');
  expect(resumedRejected.entries).toEqual([{kind: 'model', name: rejectedName, uid: null, state: 'removed'}]);
  await resumedRejected.cleanup(cleanupAdapters(resources, removed), async () => {});
  expect(removed).toEqual([name]);
});

test('LIFE-12 RAM-risk opt-in is explicit and does not change normal model-create defaults', async () => {
  for (const allowMemoryRisk of [false, true]) {
    const journal = await ResourceJournal.create(join(directory, `risk-${allowMemoryRisk}.json`), newRunId(), 'appliance-uid');
    const name = journal.prefix + 'cpu'; let creates = 0;
    const request = {fetch: async (_url: string, options: {method: string; data?: string}) => {
      if (options.method === 'GET') return jsonResponse(models());
      const local = JSON.parse(options.data ?? '{}').local;
      expect(local.allowMemoryRisk).toBe(allowMemoryRisk ? true : undefined);
      expect(local.computeTarget).toBe('cpu'); expect(local.memoryRequiredMi).toBe(2048);
      creates++;
      return jsonResponse({metadata: {name, namespace: 'ai-system', uid: 'owned-uid', generation: 1}});
    }} as unknown as APIRequestContext;
    const live = creationFoundation(request, journal);
    const created = allowMemoryRisk
      ? await live.createModel('cpu', journal, live.config.smokeModel!, {allowMemoryRisk: true})
      : await live.createModel('cpu');
    expect(created.uid).toBe('owned-uid'); expect(creates).toBe(1);
    expect(journal.entries[0]).toMatchObject({state: 'owned', uid: 'owned-uid', generation: 1});
  }
});

test('HAR-07 definite model admission rejection is independently verified and survives journal resume', async () => {
  for (const status of [400, 401, 403, 404, 409, 422]) {
    const journal = await ResourceJournal.create(join(directory, `rejected-${status}.json`), newRunId(), 'appliance-uid');
    const name = journal.prefix + 'cpu'; let creates = 0, lookups = 0;
    const request = {fetch: async (_url: string, options: {method: string}) => {
      if (options.method === 'GET') return jsonResponse(models());
      creates++;
      return {...jsonResponse({}, status), body: async () => { throw new Error('Private upstream detail must not be read'); }};
    }} as unknown as APIRequestContext;
    const live = creationFoundation(request, journal, async actual => { expect(actual).toBe(name); lookups++; return null; });
    let rejection: unknown;
    try { await live.createModel('cpu'); } catch (error) { rejection = error; }
    expect(rejection).toBeInstanceOf(ModelCreateRejected);
    expect(rejection).toMatchObject({code: 'API', httpStatus: status});
    expect(String(rejection)).not.toContain('Private upstream detail');
    expect(creates).toBe(1); expect(lookups).toBe(1);
    const resumed = await ResourceJournal.resume(journal.filename, 'appliance-uid');
    expect(resumed.entries).toEqual([{kind: 'model', name, state: 'removed', uid: null}]);
    expect(resumed.recoveryPlan()).toEqual([]);
    const removed: string[] = [], resources = new Map([['unrelated', 'keep']]);
    await resumed.cleanup(cleanupAdapters(resources, removed), async () => {});
    expect(removed).toEqual([]); expect(resources.get('unrelated')).toBe('keep');
  }
});

test('HAR-07 timeout, server failure, throttling and malformed success retain ambiguous create ownership', async () => {
  for (const scenario of ['network', '500', '408', '429', 'html-400', 'malformed-success']) {
    const journal = await ResourceJournal.create(join(directory, `ambiguous-${scenario}.json`), newRunId(), 'appliance-uid');
    let creates = 0, lookups = 0;
    const request = {fetch: async (_url: string, options: {method: string}) => {
      if (options.method === 'GET') return jsonResponse(models());
      creates++;
      if (scenario === 'network') throw new Error('Private network detail');
      if (scenario === 'html-400') return {...jsonResponse({}, 400), headers: () => ({'content-type': 'text/html'})};
      return jsonResponse({}, scenario === 'malformed-success' ? 200 : Number(scenario));
    }} as unknown as APIRequestContext;
    const live = creationFoundation(request, journal, async () => { lookups++; return null; });
    await expect(live.createModel('cpu')).rejects.toBeInstanceOf(HarnessError);
    expect(creates).toBe(1); expect(lookups).toBe(0);
    expect(journal.entries[0]).toMatchObject({state: 'requested', uid: null});
    const removed: string[] = [];
    await expect(journal.cleanup(cleanupAdapters(new Map(), removed), async () => {})).rejects.toMatchObject({code: 'CLEANUP'});
    expect(removed).toEqual([]); expect(journal.recoveryPlan()[0]?.automaticallyRemovable).toBe(false);
  }
});

test('HAR-07 rejected create cannot adopt another UID or skip independent lookup and lease guards', async () => {
  for (const scenario of ['replacement', 'lookup-failure', 'lease-lost']) {
    const journal = await ResourceJournal.create(join(directory, `fenced-${scenario}.json`), newRunId(), 'appliance-uid');
    const name = journal.prefix + 'cpu'; let guards = 0, lookups = 0;
    const request = {fetch: async (_url: string, options: {method: string}) =>
      options.method === 'GET' ? jsonResponse(models()) : jsonResponse({}, 409)} as unknown as APIRequestContext;
    const live = creationFoundation(request, journal, async () => {
      lookups++;
      if (scenario === 'lookup-failure') throw new HarnessError('OBSERVER');
      return {metadata: {name, uid: 'someone-else'}};
    }, async () => { if (++guards === 3 && scenario === 'lease-lost') throw new HarnessError('LOCK_LOST'); });
    await expect(live.createModel('cpu')).rejects.toBeInstanceOf(HarnessError);
    expect(lookups).toBe(scenario === 'lease-lost' ? 0 : 1);
    expect(journal.entries[0]).toMatchObject({state: 'requested', uid: null});
    expect(journal.recoveryPlan()[0]?.automaticallyRemovable).toBe(false);
  }
});

test('LIFE-12 CrashLoop proof requires repeated failed Pod restarts, not slow startup or a Ready Pod', () => {
  const pod: KubeObject = {metadata: {name: 'synthetic-pod'}, status: {containerStatuses: [{name: 'server', restartCount: 3,
    state: {waiting: {reason: 'CrashLoopBackOff'}}, lastState: {terminated: {exitCode: 1}}}]}};
  expect(hasRuntimeCrashLoop(pod)).toBe(true);
  for (const restartCount of [0, 1, 2]) {
    const transient = structuredClone(pod); transient.status!.containerStatuses![0]!.restartCount = restartCount;
    expect(hasRuntimeCrashLoop(transient)).toBe(false);
  }
  const retry = structuredClone(pod); retry.status!.containerStatuses![0]!.state = {};
  expect(hasRuntimeCrashLoop(retry)).toBe(true);
  const slow = structuredClone(retry); slow.status!.containerStatuses![0]!.lastState = {};
  expect(hasRuntimeCrashLoop(slow)).toBe(false);
  const ready = structuredClone(pod); ready.status!.conditions = [{type: 'Ready', status: 'True'}];
  expect(hasRuntimeCrashLoop(ready)).toBe(false);
  const completed = structuredClone(pod); completed.status!.containerStatuses![0]!.state = {terminated: {exitCode: 0}};
  expect(hasRuntimeCrashLoop(completed)).toBe(false);
  const init = structuredClone(pod); init.status!.initContainerStatuses = init.status!.containerStatuses; delete init.status!.containerStatuses;
  expect(hasRuntimeCrashLoop(init)).toBe(true);
  const bounded = phase2Config(); bounded.phase2!.failureModel.memoryRequiredMi = 8193;
  expect(() => requirePhase2Profile(bounded)).toThrow('[CONFIG]');
  bounded.phase2!.failureModel.memoryRequiredMi = 2048; bounded.phase2!.failureModel.contextWindow = 4097;
  expect(() => requirePhase2Profile(bounded)).toThrow('[CONFIG]');
});

test('HAR-07 interruption worker imports successfully but refuses a non-IPC invocation before any lab access', async () => {
  let exit: unknown;
  try {
    await promisify(execFile)(process.execPath, typeScriptWorkerArgs(
      fileURLToPath(new URL('../interruption-worker.mjs', import.meta.url))),
    {env: {...process.env, REGRESSION_CONFIG: '', REGRESSION_RUN_DIR: ''}, timeout: 10_000});
  } catch (error) { exit = (error as {code?: unknown}).code; }
  expect(exit).toBe(2);
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
    current: KubeObject = {metadata: {name, namespace: 'ai-system', uid, generation: 3, resourceVersion: '28',
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
  cleaner.current.spec = {type: 'external', targetNamespace: 'ai'}; cleaner.deleted = false;
  expect(await adapter.lookup(entry)).toEqual({uid});
  await adapter.removeIfUid(entry, uid); expect(await adapter.verifyRemoved(entry)).toBe(true);
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
  const client = new OwnedModelClient(request, 'https://dashboard.example.local', 500, name, fixture, prefix, async () => {});
  expect(await client.create()).toEqual({uid, generation: 1});
  await expect(client.create()).rejects.toMatchObject({code: 'OWNERSHIP'});
  expect(editRevision({metadata: {uid, generation: 2}})).toBe(`generation:${uid}:2`);
  expect(activation({...payload, activations: []}, name)).toBeNull();
  expect(ownedRuntimePods([{metadata: {name: 'pod', namespace: 'ai', labels: {app: 'model', model: name},
    ownerReferences: [{uid: 'kubeai-uid', kind: 'Model', name, controller: true}]}}], name)).toHaveLength(1);
});

test('LIFE-09 stale model update sends the dashboard CSRF header and accepts only conflict', async () => {
  const prefix = 'reg-aabbccddeeff-', name = prefix + 'cpu', uid = 'model-uid';
  const fixture = {engine: 'OLlama' as const, computeTarget: 'cpu' as const,
    url: 'ollama://qwen2.5:0.5b-instruct-q4_K_M', memoryRequiredMi: 2048, contextWindow: 2048, maxNumSeqs: 1 as const};
  let status = 409;
  const request = {fetch: async (url: string, options: {method: string; headers: Record<string, string>; data?: string}) => {
    expect(new URL(url).pathname).toBe(options.method === 'GET' ? '/api/models' : `/api/models/${name}`);
    if (options.method === 'GET') return {status: () => 200, headers: () => ({'content-type': 'application/json'}),
      body: async () => Buffer.from(JSON.stringify({...models(), activations: [{metadata: {name, uid, generation: 2},
        spec: {type: 'local', enabled: true, local: {engine: 'OLlama', contextWindow: 1024}}}]}))};
    expect(options.method).toBe('PUT');
    expect(options.headers['X-MagicStick-CSRF']).toBe('dashboard');
    expect(options.headers.Origin).toBe('https://dashboard.example.local');
    expect(JSON.parse(options.data ?? '{}')).toEqual({expectedRevision: `generation:${uid}:1`, local: {contextWindow: 2048}});
    return {status: () => status};
  }} as unknown as APIRequestContext;
  const client = new OwnedModelClient(request, 'https://dashboard.example.local', 500, name, fixture, prefix, async () => {});
  client.adopt(uid);
  await client.rejectsStaleContextUpdate(`generation:${uid}:1`, 2048);
  status = 200;
  await expect(client.rejectsStaleContextUpdate(`generation:${uid}:1`, 2048)).rejects.toMatchObject({code: 'CONFLICT'});
  await expect(client.rejectsStaleContextUpdate('generation:replacement-uid:1', 2048)).rejects.toMatchObject({code: 'MUTATION'});
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

test('HAR-02 LiteLLM uses the actual SSO route before GPU work; a redirect is not an inference session',async ()=>{
  const origin='https://inference.example.local';let url=origin+'/ui/playground/',status=200,closed=0;
  const context={newPage:async()=>({goto:async(path:string)=>{expect(path).toBe(origin+'/ui/playground/');return {status:()=>status};},
    url:()=>url,close:async()=>{closed++;}})} as unknown as BrowserContext;
  await openInferenceSession(context,origin,500);expect(closed).toBe(1);
  url='https://id.example.local/login';
  await expect(openInferenceSession(context,origin,500)).rejects.toMatchObject({code:'AUTH',stage:'login-session'});
  url=origin+'/ui/playground/';status=302;
  await expect(openInferenceSession(context,origin,500)).rejects.toMatchObject({code:'AUTH'});expect(closed).toBe(3);
});

test('HAR-10 API inference failures retain a Failed outcome and bounded diagnostics without response or key data',async ()=>{
  const messages=[new HarnessError('API','Failed','model-inference').message];
  expect(failureOutcome('API',messages)).toBe('Failed');
  expect(failureOutcome('API',[new HarnessError('API').message])).toBe('Failed');
  const seen:unknown[]=[];
  const request={fetch:async()=>({status:()=>302,headers:()=>({'content-type':'text/html'}),
    body:async()=>Buffer.from('<html>synthetic private upstream</html>')})} as unknown as APIRequestContext;
  const probe=new InferenceProbe(request,'https://inference.example.local','sk-synthetic-private');
  await expect(probe.chat('reg-fixture',undefined,8,async value=>{seen.push(value);})).rejects.toMatchObject({code:'API'});
  expect(seen).toEqual([{httpStatus:302,hasContent:false,modelMatches:false,failure:'non-json'}]);
  const failed={fetch:async()=>{throw new Error('TLS certificate failure containing sk-synthetic-private');}} as unknown as APIRequestContext;
  await expect(new InferenceProbe(failed,'https://inference.example.local','sk-synthetic-private')
    .chat('reg-fixture',undefined,8,async value=>{seen.push(value);})).rejects.toMatchObject({code:'API'});
  expect(seen[1]).toEqual({httpStatus:0,hasContent:false,modelMatches:false,failure:'transport',transportReason:'tls'});
  expect(JSON.stringify(seen)).not.toMatch(/sk-synthetic-private|upstream/);
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
  await expect(poll(() => new Promise(() => {}), () => true, {timeoutMs: 50, stage: 'model-ready'})).rejects.toMatchObject({code: 'DEADLINE', stage: 'model-ready'});
});

test('HAR-10 empty, missing, blocked, skipped and flaky results cannot produce green acceptance', async () => {
  const passed: CaseResult = {id: 'HAR-01', outcome: 'Passed', layer: 'U', environment: 'fixture', durationMs: 10};
  expect(summarize(['HAR-01'], [passed]).acceptable).toBe(true);
  expect(summarize([], []).acceptable).toBe(false);
  expect(summarize(['HAR-01', 'HAR-02'], [passed]).missing).toEqual(['HAR-02']);
  for (const outcome of ['Failed', 'Blocked', 'Skipped', 'Not run', 'Flaky'] as const) {
    expect(summarize(['HAR-01'], [{...passed, outcome}]).acceptable).toBe(false);
  }
  await saveReport(directory, newRunId(), [{...passed, outcome: 'Blocked', reason: 'TLS'}], ['HAR-01', 'HAR-02']);
  const xml = await readFile(join(directory, 'junit.xml'), 'utf8');
  expect(xml).toContain('failures="0"');expect(xml).toContain('skipped="2"');expect(xml).toContain('name="HAR-02"');
});

test('HAR-10 full Phase 0 requires every fixture ID and live variant including final idle', async () => {
  const fixtures: CaseResult[] = phase0Ids.map(id => ({id, outcome: 'Passed', layer: 'U', environment: 'fixture', durationMs: 1}));
  const live: CaseResult[] = Object.entries(phase0Variants).map(([variant, id]) =>
    ({id, variant: variant as Phase0Variant, layer: 'A', environment: 'live', outcome: 'Passed', durationMs: 1}));
  expect(phase0Coverage(fixtures).complete).toBe(false);
  const cases = [...fixtures, ...live];
  expect((await saveReport(directory, newRunId(), cases, phase0Ids, 'a'.repeat(40), 'phase0')).fullPhase0Accepted).toBe(true);
  for (const variant of Object.keys(phase0Variants)) {
    expect(phase0Coverage(cases.filter(item => item.variant !== variant)).complete).toBe(false);
  }
  expect(phase0Coverage(cases.filter(item => item.id !== 'HAR-11')).complete).toBe(false);
  expect(phase0Coverage([...cases, {...fixtures[0]!, outcome: 'Flaky'}]).complete).toBe(false);
  const partial = await saveReport(directory, newRunId(), cases.filter(item => item.variant !== 'final-idle'), phase0Ids, 'a'.repeat(40), 'phase0');
  expect(partial.fullPhase0Accepted).toBe(false);
  expect(partial.acceptable).toBe(false);
  const report = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8'));
  expect(report.phase0Coverage.missingVariants).toEqual(['final-idle']);
  expect(await readFile(join(directory, 'junit.xml'), 'utf8')).toContain('skipped="1"');
});

test('HAR-11 reports allowlist fields and redact seeded credentials, headers, URLs and auth state', async () => {
  const secret = 'synthetic-secret', seeded = {authorization: 'Bearer ' + secret, cookie: secret, password: secret, invitation: secret,
    storageState: {cookies: [secret]}, nested: {message: `https://example.local/?access_token=${secret} Bearer ${secret}`}};
  expect(JSON.stringify(redact(seeded, [secret]))).not.toContain(secret);
  const result = {id: 'HAR-11', outcome: 'Passed', layer: 'U', environment: 'fixture', durationMs: 1, raw: seeded, password: secret} as CaseResult;
  await saveReport(directory, newRunId(), [result], ['HAR-11'], secret);
  for (const filename of ['summary.json', 'summary.txt', 'junit.xml']) {
    const text = await readFile(join(directory, filename), 'utf8'); expect(text).not.toContain(secret); expect(text).not.toContain('storageState');
    expect((await lstat(join(directory, filename))).mode & 0o077).toBe(0);
  }
  const baseline = JSON.stringify(safeBaseline(config(), [node()], [], models(), []));
  expect(baseline).not.toContain('fixture-node'); expect(baseline).not.toContain('node-uid'); expect(baseline).not.toContain('appliance-uid');
});

test('HAR-01 HAR-11 [layer:B] real Chromium fixture login and shared API client; no product writes or traces', async ({browser}) => {
  // Synthetic loopback HTTP fixture only. Production configuration rejects HTTP.
  let dashboardUrl = '', identityUrl = '', loginPosted = false, identityUnavailable = false;
  const username = 'fixture-admin', password = 'synthetic-password';
  await writeFile(join(directory, 'username.txt'), username, {mode: 0o600});
  await writeFile(join(directory, 'password.txt'), password, {mode: 0o600});
  const identity = createServer((request, response) => {
    if (identityUnavailable) { response.writeHead(503); response.end('Synthetic unavailable identity'); return; }
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
    identityUnavailable = true;
    await expect(realLogin(browser, {...config(), dashboardUrl, identityUrl,
      usernameFile: join(directory, 'username.txt'), passwordFile: join(directory, 'password.txt')}))
      .rejects.toMatchObject({code: 'AUTH', stage: 'login-form'});
  } finally {
    await Promise.all([new Promise<void>(resolve => dashboard.close(() => resolve())), new Promise<void>(resolve => identity.close(() => resolve()))]);
  }
});
