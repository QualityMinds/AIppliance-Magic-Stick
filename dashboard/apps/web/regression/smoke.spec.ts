import {test, expect, type BrowserContext} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {LabConfig} from './core/config.ts';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {loadLabConfig} from './core/config.ts';
import {realLogin} from './core/auth.ts';
import {readOnlyApi} from './core/transport.ts';
import {KubectlObserver, KubernetesLeaseStore} from './core/observer.ts';
import {KubernetesModelCleaner} from './core/model-cleanup.ts';
import {LabLease} from './core/lease.ts';
import {ResourceJournal} from './core/journal.ts';
import {OwnedKeyClient} from './core/owned-key.ts';
import {OwnedModelClient, activation, fixtureIsAdvertised, ownedRuntimePods, remainingModelResources} from './core/owned-model.ts';
import {InferenceProbe} from './core/inference.ts';
import {verifiedEndpoint, verifyCapabilities, verifyIdentity, verifyIdle} from './core/preflight.ts';
import {poll} from './core/poll.ts';
import {requireSafe} from './core/errors.ts';

test.describe.serial('installed CPU model smoke', () => {
  let config: LabConfig;
  let context: BrowserContext | undefined;
  let observer: KubectlObserver;
  let cleaner: KubernetesModelCleaner;
  let lock: LabLease | undefined;
  let journal: ResourceJournal;
  let keys: OwnedKeyClient;
  let model: OwnedModelClient;
  let inference: InferenceProbe;
  let keySecret: string | undefined;
  let name = '';
  let uid = '';
  let generation = 0;
  let baselineKeyIds = new Set<string>();
  let lockAcquired = false;
  let cleaned = false;
  let beatAt = 0;

  async function heartbeat() {
    requireSafe(lock, 'LOCK_LOST');
    if (Date.now() - beatAt > 15_000) { await lock.heartbeat(); beatAt = Date.now(); }
    else await lock.assertHeld();
  }

  async function modelState() {
    await heartbeat();
    const [models, observed, pods] = await Promise.all([
      model.models(), cleaner.find(name), observer.list('pods', 'ai'),
    ]);
    const item = activation(models, name);
    requireSafe(!item || item.metadata?.uid === uid, 'OWNERSHIP');
    requireSafe(!observed || observed.metadata.uid === uid, 'OWNERSHIP');
    return {models, observed, pods: ownedRuntimePods(pods, name), item};
  }

  async function waitReady() {
    return poll(async () => modelState(), value =>
      value.item?.metadata?.uid === uid && value.item.metadata.generation === generation &&
      value.item.spec?.enabled === true && value.item.status?.phase === 'Ready' &&
      value.observed?.metadata.generation === generation &&
      value.pods.some(pod => pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True')) &&
      (value.models.models ?? []).some(item => item.id === name),
    {timeoutMs: 900_000, intervalMs: 2000});
  }

  test.beforeAll(async ({browser}) => {
    requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR && process.env.REGRESSION_RUN_ID, 'CONFIG');
    config = await loadLabConfig(process.env.REGRESSION_CONFIG);
    requireSafe(config.lock && config.inferenceUrl && config.smokeModel && config.modelCleanupKubeconfig, 'CONFIG');
    const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined;
    await verifiedEndpoint(config.inferenceUrl, config.requestTimeoutMs, ca);
    context = await realLogin(browser, config, {allowedStopName: () => name || undefined,
      allowedStopUid: () => uid || undefined, inferenceOrigin: config.inferenceUrl});
    // The LiteLLM route has its own edge OIDC session. Establish it in the
    // authenticated browser before sending application-level sk- key requests.
    const liteLlmPage = await context.newPage();
    try {
      await liteLlmPage.goto(config.inferenceUrl + '/ui/playground/', {waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs});
      requireSafe(new URL(liteLlmPage.url()).origin === config.inferenceUrl, 'AUTH');
    } finally { await liteLlmPage.close(); }
    observer = new KubectlObserver(config.observerKubeconfig, config.requestTimeoutMs);
    cleaner = new KubernetesModelCleaner(config.modelCleanupKubeconfig, config.expected.applianceNamespace, config.requestTimeoutMs);
    await observer.verifyConfiguration(); await cleaner.verifyConfiguration();
    const api = readOnlyApi(context.request, config.dashboardUrl, config.requestTimeoutMs);
    const [appliance, hosts, models, observed, nodes] = await Promise.all([
      api.appliance(), api.hostManagement(), api.models(),
      observer.get('appliances.appliance.magicstick.dev', config.expected.applianceNamespace, config.expected.applianceName),
      observer.list('nodes'),
    ]);
    verifyIdentity(config, appliance, observed, nodes, hosts.nodes);
    verifyCapabilities(config, models); verifyIdle(hosts.nodes, models, config);
    fixtureIsAdvertised(models, config.smokeModel);
    const modules = models.modules as Record<string, {enabled?: boolean}> | undefined;
    requireSafe(['kubeai', 'litellm', 'model-catalog'].every(id => modules?.[id]?.enabled === true), 'CAPABILITY');
    journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
    keys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries);
    baselineKeyIds = new Set((await keys.list()).items.map(item => item.id));
    name = journal.prefix + 'cpu';
    model = new OwnedModelClient(context.request, config.dashboardUrl, config.requestTimeoutMs, name, config.smokeModel, journal.prefix);
    requireSafe(!(await cleaner.find(name)), 'OWNERSHIP');
    lock = new LabLease(new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name),
      process.env.REGRESSION_RUN_ID, config.expected.applianceUid, Date.now, 120);
    await lock.acquire(); lockAcquired = true; beatAt = Date.now();
  });

  test.afterAll(async () => {
    try {
      if (lockAcquired && lock && journal && keys && cleaner && model && observer) {
        await heartbeat();
        const keyAdapter = keys.adapter();
        const modelAdapter = cleaner.adapter(journal.prefix, modelName => remainingModelResources(observer, model, modelName), heartbeat);
        await journal.cleanup({key: keyAdapter, model: modelAdapter, app: keyAdapter, identity: keyAdapter}, heartbeat);
        const currentIds = new Set((await keys.list()).items.map(item => item.id));
        requireSafe([...baselineKeyIds].every(id => currentIds.has(id)) &&
          journal.entries.every(entry => entry.state === 'removed') &&
          journal.entries.filter(entry => entry.kind === 'key').every(entry => entry.uid && !currentIds.has(entry.uid)), 'CLEANUP');
        await lock.release(); cleaned = true;
      }
    } finally { keySecret = undefined; await context?.close(); }
    if (lockAcquired) requireSafe(cleaned, 'CLEANUP');
  });

  test('LIFE-01 API creates one run-owned CPU model and dashboard observes real Ready runtime', async () => {
    await heartbeat();
    const keyName = journal.prefix + 'smoke-key';
    await journal.requested('key', keyName);
    const key = await keys.createCredential(keyName);
    await journal.owned('key', keyName, key.id); keySecret = key.secret;
    inference = new InferenceProbe(context!.request, config.inferenceUrl!, keySecret);
    await journal.requested('model', name);
    const created = await model.create();
    uid = created.uid; generation = created.generation;
    await journal.owned('model', name, uid, generation);
    const state = await waitReady();
    requireSafe(state.item?.spec?.local?.engine === 'OLlama' && state.item.spec.local.computeTarget === 'cpu', 'API');
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('heading', {name: 'Installed Models'})).toBeVisible();
      await expect(page.getByRole('button', {name: `Stop ${name}`})).toBeVisible();
      await expect(page.getByRole('button', {name: `View logs for ${name}`})).toBeVisible();
      await page.getByRole('button', {name: `View logs for ${name}`}).click();
      await expect(page.getByRole('dialog', {name: `Runtime logs · ${name}`})).toBeVisible();
      const logs = await model.logs();
      requireSafe(logs.model === name && logs.pods.some(pod => state.pods.some(observed => observed.metadata.name === pod.name)), 'API');
      await page.getByRole('dialog', {name: `Runtime logs · ${name}`}).getByRole('button', {name: 'Close dialog'}).click();
    } finally { await page.close(); }
  });

  test('ROUTE-01 normal LiteLLM route answers a real bounded CPU chat request', async () => {
    await heartbeat(); requireSafe(keySecret && inference, 'CONFIG');
    expect(await inference.advertised(name)).toBe(true);
    await inference.chat(name);
  });

  test('LIFE-03 dashboard Stop withdraws the route and removes the owned runtime', async () => {
    await heartbeat();
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/stop` &&
        response.request().method() === 'POST');
      await page.getByRole('button', {name: `Stop ${name}`}).click();
      const response = await responsePromise;
      requireSafe(response.status() === 200, 'API');
      const body = await response.json() as {activation?: ModelActivation};
      const next = body.activation;
      requireSafe(next?.metadata?.uid === uid && next.spec?.enabled === false &&
        Number.isSafeInteger(next.metadata.generation) && Number(next.metadata.generation) > generation, 'API');
      await journal.modelGeneration(name, uid, generation, Number(next.metadata.generation));
      generation = Number(next.metadata.generation);
    } finally { await page.close(); }
    await poll(async () => modelState(), value => value.item?.spec?.enabled === false &&
      ['Disabled', 'Stopped'].includes(String(value.item?.status?.phase)) && value.pods.length === 0 &&
      !(value.models.models ?? []).some(item => item.id === name), {timeoutMs: 300_000, intervalMs: 1000});
    expect(await inference.advertised(name)).toBe(false);
    await inference.refusesStopped(name);
  });

  test('LIFE-04 API Start restores saved settings and routed inference', async () => {
    await heartbeat();
    const current = activation(await model.models(), name);
    requireSafe(current?.metadata?.uid === uid && current.metadata.generation === generation, 'OWNERSHIP');
    const started = await model.start(current);
    await journal.modelGeneration(name, uid, generation, started.generation);
    generation = started.generation;
    const state = await waitReady();
    requireSafe(state.item?.spec?.local?.url === config.smokeModel?.url, 'API');
    expect(await inference.advertised(name)).toBe(true);
    await inference.chat(name);
  });

  test('LIFE-06 removes only the journal-owned model, Pods, catalog entry and key', async () => {
    await heartbeat();
    const keyAdapter = keys.adapter();
    const modelAdapter = cleaner.adapter(journal.prefix, modelName => remainingModelResources(observer, model, modelName), heartbeat);
    await journal.cleanup({key: keyAdapter, model: modelAdapter, app: keyAdapter, identity: keyAdapter}, heartbeat);
    expect((await cleaner.find(name))).toBeNull();
    const remaining = await remainingModelResources(observer, model, name);
    expect(remaining).toEqual({podCount: 0, catalogCount: 0});
  });
});
