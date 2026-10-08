import {test, expect, type BrowserContext} from '@playwright/test';
import {join} from 'node:path';
import {readFile} from 'node:fs/promises';
import type {LabConfig} from '../core/config.ts';
import type {ModelActivation} from '@magicstick/dashboard-contracts';
import {loadLabConfig} from '../core/config.ts';
import {realLogin} from '../core/auth.ts';
import {readOnlyApi} from '../core/transport.ts';
import {KubectlObserver, KubernetesLeaseStore} from '../core/observer.ts';
import {KubernetesModelCleaner} from '../core/model-cleanup.ts';
import {LabLease} from '../core/lease.ts';
import {ResourceJournal} from '../core/journal.ts';
import {OwnedKeyClient} from '../core/owned-key.ts';
import {OwnedModelClient, activation, editRevision, fixtureIsAdvertised, ownedRuntimePods, remainingModelResources} from '../core/owned-model.ts';
import {InferenceProbe} from '../core/inference.ts';
import {verifiedEndpoint, verifyCapabilities, verifyIdentity, verifyIdle} from '../core/preflight.ts';
import {poll} from '../core/poll.ts';
import {requireSafe} from '../core/errors.ts';
import {requirePhase1Profile} from '../profiles/phase1-p0.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import type {CpuScenario} from '../core/cpu-scenario.ts';
import {registerKeyCreation, registerKeySecrecy, registerKeyRevocation} from '../api-access/keys.cases.ts';
import {registerNavigation} from '../navigation/navigation.cases.ts';
import {registerReadyLogs, registerLogTransport} from '../observability/logs.cases.ts';
import {registerModelDraft} from '../models/forms.cases.ts';
import {cpuWorkflowProfile} from '../profiles/selections.ts';
import {writePrivate} from '../core/private-files.ts';

const {edit: modelEditRun, phase1: phase1Run} = cpuWorkflowProfile(process.env.REGRESSION_MODE);
const title = (id: string, variant: string, text: string, layers = 'A+E') => `${id}${phase1Run ? ` [p1:${variant}]` : ''} [layer:${layers}] ${text}`;

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
  let keyId = '', keyName = '';
  let allowedKeyName: string | undefined, allowedKeyId: string | undefined;
  let blockedWrites = 0;
  const blockedMutations: Array<{method: string; path: string}> = [];
  let name = '';
  let uid = '';
  let generation = 0;
  let baselineKeyIds = new Set<string>();
  let lockAcquired = false;
  let cleaned = false;
  let beatAt = 0;
  let allowedEditContextWindow: number | undefined;
  let allowedStart = false;
  let staleRevision = '';
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatInFlight: Promise<void> | undefined;
  let leaseFailed = false;

  function editedContextWindow() {
    requireSafe(config.smokeModel, 'CONFIG');
    const initial = config.smokeModel.contextWindow;
    return initial === 256 ? 512 : Math.max(256, Math.floor(initial / 2));
  }

  async function heartbeat() {
    requireSafe(!leaseFailed, 'LOCK_LOST');
    if (heartbeatInFlight) return heartbeatInFlight;
    heartbeatInFlight = checkHeartbeat().finally(() => { heartbeatInFlight = undefined; });
    return heartbeatInFlight;
  }

  async function checkHeartbeat() {
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
    {timeoutMs: 900_000, intervalMs: 2000, stage: 'model-ready'});
  }

  const scenario: CpuScenario = {
    title, heartbeat, modelState, editedContextWindow,
    get config() { return config; },
    get context() { return context!; },
    get observer() { return observer; },
    get journal() { return journal; },
    get keys() { return keys; },
    get model() { return model; },
    get inference() { return inference; },
    get name() { return name; },
    get uid() { return uid; },
    get generation() { return generation; },
    get keyName() { return keyName; }, set keyName(value: string) { keyName = value; },
    get keyId() { return keyId; }, set keyId(value: string) { keyId = value; },
    get keySecret() { return keySecret; }, set keySecret(value: string | undefined) { keySecret = value; },
    get allowedKeyName() { return allowedKeyName; }, set allowedKeyName(value: string | undefined) { allowedKeyName = value; },
    get allowedKeyId() { return allowedKeyId; }, set allowedKeyId(value: string | undefined) { allowedKeyId = value; },
    get blockedWrites() { return blockedWrites; },
  };

  test.beforeAll(async ({browser}) => {
    requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR && process.env.REGRESSION_RUN_ID, 'CONFIG');
    config = await loadLabConfig(process.env.REGRESSION_CONFIG);
    if (phase1Run) requirePhase1Profile(config);
    requireSafe(config.lock && config.inferenceUrl && config.smokeModel && config.modelCleanupKubeconfig, 'CONFIG');
    const ca = config.caFile ? await readFile(config.caFile, 'utf8') : undefined;
    await verifiedEndpoint(config.inferenceUrl, config.requestTimeoutMs, ca);
    context = await realLogin(browser, config, {allowedStopName: () => name || undefined,
      allowedStopUid: () => uid || undefined, allowedStart: () => (modelEditRun || phase1Run) && allowedStart,
      allowedEditContextWindow: () => modelEditRun ? allowedEditContextWindow : undefined,
      allowedEstimateMemoryMi: () => modelEditRun || phase1Run ? config.smokeModel?.memoryRequiredMi : undefined,
      allowedKeyName: () => phase1Run ? allowedKeyName : undefined,
      allowedKeyId: () => phase1Run ? allowedKeyId : undefined,
      onBlockedMutation: request => {
        blockedWrites++;
        blockedMutations.push(request);
      },
      assertMutationAllowed: heartbeat,
      inferenceOrigin: config.inferenceUrl});
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
    if (phase1Run) await LiveFoundation.snapshot(context, config);
    fixtureIsAdvertised(models, config.smokeModel);
    const modules = models.modules as Record<string, {enabled?: boolean}> | undefined;
    requireSafe(['kubeai', 'litellm', 'model-catalog'].every(id => modules?.[id]?.enabled === true), 'CAPABILITY');
    journal = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
    keys = new OwnedKeyClient(context.request, config.dashboardUrl, config.requestTimeoutMs, journal.prefix, journal.entries, heartbeat);
    baselineKeyIds = new Set((await keys.list()).items.map(item => item.id));
    name = journal.prefix + 'cpu';
    model = new OwnedModelClient(context.request, config.dashboardUrl, config.requestTimeoutMs, name, config.smokeModel, journal.prefix, heartbeat);
    requireSafe(!(await cleaner.find(name)), 'OWNERSHIP');
    lock = new LabLease(new KubernetesLeaseStore(config.lock.kubeconfig, config.lock.namespace, config.lock.name),
      process.env.REGRESSION_RUN_ID, config.expected.applianceUid, Date.now, 120);
    await lock.acquire(process.env.REGRESSION_RUN_ID); lockAcquired = true; beatAt = Date.now();
    heartbeatTimer = setInterval(() => { void heartbeat().catch(() => { leaseFailed = true; }); }, 10_000);
  });

  test.afterAll(async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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

  if (phase1Run) {
    registerKeyCreation(scenario);

    registerKeySecrecy(scenario);

    registerNavigation(scenario);
  }

  test(title('LIFE-01', 'api-cpu-create', 'API creates one run-owned CPU model and dashboard observes real Ready runtime'), async () => {
    await heartbeat();
    if (!phase1Run) {
      const name = journal.prefix + 'smoke-key';
      await journal.requested('key', name);
      const key = await keys.createCredential(name);
      await journal.owned('key', name, key.id); keySecret = key.secret;
    }
    requireSafe(keySecret, 'CONFIG');
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

  test(title('ROUTE-01', 'cpu-chat', 'normal LiteLLM route answers a real bounded CPU chat request'), async () => {
    await heartbeat(); requireSafe(keySecret && inference, 'CONFIG');
    expect(await inference.advertised(name)).toBe(true);
    await inference.chat(name);
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('button', {name: `Stop ${name}`})).toBeVisible();
      await expect(page.getByText('Model is available in the generated model catalog.', {exact: true})).toBeVisible();
    } finally { await page.close(); }
  });

  if (phase1Run) {
    registerReadyLogs(scenario);

    registerLogTransport(scenario);

    registerModelDraft(scenario);

    for (const kind of ['missing', 'invalid'] as const) {
      test(title('ROUTE-06', kind + '-key', `${kind} inference credential is denied for the real Ready model`, 'A'), async () => {
        await heartbeat(); await inference.refusesUnauthorized(name, kind);
      });
    }
    test(title('ROUTE-06', 'unknown-route', 'an unknown run-unique model cannot route to a different backend', 'A'), async () => {
      await heartbeat(); await inference.refusesStopped(journal.prefix + 'absent');
    });
  }

  if (modelEditRun) {
    test('LIFE-08 unchanged, reverted and invalid browser edits stay unsaved through polling', async () => {
      await heartbeat(); requireSafe(config.smokeModel, 'CONFIG');
      const initial = config.smokeModel.contextWindow, changed = editedContextWindow();
      const page = await context!.newPage();
      try {
        await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
        await page.getByRole('button', {name: `Edit ${name}`}).click();
        const dialog = page.getByRole('dialog', {name: `Edit Model · ${name}`});
        const field = dialog.getByLabel('Context Size');
        const save = dialog.getByRole('button', {name: 'Save changes'});
        await expect(field).toHaveValue(String(initial));
        await expect(save).toBeDisabled();
        await field.fill(String(changed));
        await expect(save).toBeEnabled();
        const refresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models' &&
          response.request().method() === 'GET', {timeout: 25_000});
        await refresh;
        await expect(field).toHaveValue(String(changed));
        await expect(save).toBeEnabled();
        await field.fill(String(initial));
        await expect(save).toBeDisabled();
        await field.fill('0');
        await expect(save).toBeDisabled();
        await dialog.getByRole('button', {name: 'Cancel'}).click();
      } finally { await page.close(); }
      const unchanged = activation(await model.models(), name);
      requireSafe(unchanged?.metadata?.uid === uid && unchanged.metadata.generation === generation &&
        unchanged.spec?.local?.contextWindow === initial, 'API');
    });

    test('LIFE-07 browser edit persists the owned context and recovers routed inference', async () => {
      await heartbeat(); requireSafe(config.smokeModel, 'CONFIG');
      const before = activation(await model.models(), name);
      requireSafe(before?.metadata?.uid === uid && before.metadata.generation === generation, 'OWNERSHIP');
      staleRevision = editRevision(before);
      const changed = editedContextWindow();
      const page = await context!.newPage();
      try {
        await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded', timeout: 30_000});
        const edit = page.getByRole('button', {name: `Edit ${name}`});
        await expect(edit).toBeVisible({timeout: 20_000});
        await edit.click({timeout: 20_000});
        const dialog = page.getByRole('dialog', {name: `Edit Model · ${name}`});
        await dialog.getByLabel('Context Size').fill(String(changed), {timeout: 20_000});
        await expect(dialog.getByRole('button', {name: 'Save changes'})).toBeEnabled({timeout: 30_000});
        allowedEditContextWindow = changed;
        const requestPromise = page.waitForRequest(request => new URL(request.url()).pathname === `/api/models/${name}` &&
          request.method() === 'PUT', {timeout: 20_000});
        await dialog.getByRole('button', {name: 'Save changes'}).click({timeout: 20_000});
        const request = await requestPromise;
        const response = await request.response();
        requireSafe(response, 'MUTATION');
        requireSafe(response.status() === 200, 'API');
        const updated = await response.json() as ModelActivation;
        requireSafe(updated.metadata?.uid === uid && Number.isSafeInteger(updated.metadata.generation) &&
          Number(updated.metadata.generation) > generation && updated.spec?.local?.contextWindow === changed, 'API');
        await journal.modelGeneration(name, uid, generation, Number(updated.metadata.generation));
        generation = Number(updated.metadata.generation);
      } finally { allowedEditContextWindow = undefined; await page.close(); }
      const state = await waitReady();
      requireSafe(state.item?.spec?.local?.contextWindow === changed &&
        state.item.spec.local.engine === 'OLlama' && state.item.spec.local.computeTarget === 'cpu' &&
        state.item.spec.local.url === config.smokeModel.url, 'API');
      await inference.chat(name);
    });

    test('LIFE-09 stale spec revision cannot overwrite the browser edit', async () => {
      await heartbeat(); requireSafe(config.smokeModel && staleRevision, 'CONFIG');
      await model.rejectsStaleContextUpdate(staleRevision, config.smokeModel.contextWindow);
      const state = await modelState();
      requireSafe(state.item?.metadata?.uid === uid && state.item.metadata.generation === generation &&
        state.item.spec?.local?.contextWindow === editedContextWindow(), 'CONFLICT');
    });
  }

  test(title('LIFE-03', 'ui-stop', 'dashboard Stop withdraws the route and removes the owned runtime'), async () => {
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
      !(value.models.models ?? []).some(item => item.id === name), {timeoutMs: 300_000, intervalMs: 1000, stage: 'model-stopped'});
    expect(await inference.advertised(name)).toBe(false);
    await inference.refusesStopped(name);
  });

  if (phase1Run) test(title('ROUTE-06', 'stopped-route', 'a stopped definition retains settings but no advertised or serving route', 'A'), async () => {
    await heartbeat(); requireSafe(config.smokeModel, 'CONFIG');
    const current = activation(await model.models(), name);
    requireSafe(current?.metadata?.uid === uid && current.spec?.enabled === false &&
      current.spec?.local?.url === config.smokeModel.url && current.spec.local.contextWindow === config.smokeModel.contextWindow, 'API');
    expect(await inference.advertised(name)).toBe(false); await inference.refusesStopped(name);
  });

  test(title('LIFE-04', 'api-start', 'API or browser Start restores saved settings and routed inference'), async () => {
    await heartbeat();
    const current = activation(await model.models(), name);
    requireSafe(current?.metadata?.uid === uid && current.metadata.generation === generation, 'OWNERSHIP');
    if (modelEditRun) {
      const page = await context!.newPage();
      allowedStart = true;
      try {
        await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/start` &&
          response.request().method() === 'POST');
        await page.getByRole('button', {name: `Start ${name}`}).click();
        const response = await responsePromise;
        requireSafe(response.status() === 200, 'API');
        const body = await response.json() as {activation?: ModelActivation};
        const next = body.activation;
        requireSafe(next?.metadata?.uid === uid && next.spec?.enabled === true &&
          Number.isSafeInteger(next.metadata.generation) && Number(next.metadata.generation) > generation, 'API');
        await journal.modelGeneration(name, uid, generation, Number(next.metadata.generation));
        generation = Number(next.metadata.generation);
      } finally { allowedStart = false; await page.close(); }
    } else {
      const started = await model.start(current);
      await journal.modelGeneration(name, uid, generation, started.generation);
      generation = started.generation;
    }
    const state = await waitReady();
    requireSafe(state.item?.spec?.local?.url === config.smokeModel?.url &&
      (!modelEditRun || state.item?.spec?.local?.contextWindow === editedContextWindow()), 'API');
    expect(await inference.advertised(name)).toBe(true);
    await inference.chat(name);
    const page = await context!.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('button', {name: `Stop ${name}`})).toBeVisible();
    } finally { await page.close(); }
  });

  if (phase1Run) {
    test(title('LIFE-04', 'ui-start', 'a separate browser Start cycle preserves the owned model identity and settings'), async () => {
      await heartbeat(); const current = activation(await model.models(), name);
      requireSafe(current?.metadata?.uid === uid && current.metadata.generation === generation, 'OWNERSHIP');
      const stopped = await model.stop(current); await journal.modelGeneration(name, uid, generation, stopped.generation); generation = stopped.generation;
      await poll(() => modelState(), value => value.item?.spec?.enabled === false &&
        ['Disabled', 'Stopped'].includes(String(value.item.status?.phase)) && value.pods.length === 0 &&
        !value.models.models?.some(item => item.id === name), {timeoutMs: 300_000, intervalMs: 1000, stage: 'model-stopped'});
      const page = await context!.newPage(); allowedStart = true;
      try {
        await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
        const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/start` &&
          response.request().method() === 'POST');
        await page.getByRole('button', {name: `Start ${name}`}).click(); const response = await responsePromise;
        requireSafe(response.status() === 200, 'API'); const next = (await response.json() as {activation?: ModelActivation}).activation;
        requireSafe(next?.metadata?.uid === uid && next.spec?.enabled === true && Number(next.metadata.generation) > generation, 'API');
        await journal.modelGeneration(name, uid, generation, Number(next.metadata.generation)); generation = Number(next.metadata.generation);
      } finally { allowedStart = false; await page.close(); }
      const state = await waitReady();
      requireSafe(config.smokeModel && state.item?.spec?.local?.url === config.smokeModel.url &&
        state.item?.spec?.local?.contextWindow === config.smokeModel.contextWindow, 'API');
      await inference.chat(name);
    });

    registerKeyRevocation(scenario);

    test(title('ROUTE-06', 'revoked-key', 'a revoked inference key is denied for the still-Ready model', 'A'), async () => {
      await heartbeat(); await inference.refusesUnauthorized(name, 'revoked');
    });
  }

  test(title('LIFE-06', 'owned-remove', 'removes only the journal-owned model, Pods, catalog entry and key'), async () => {
    await heartbeat();
    const keyAdapter = keys.adapter();
    const modelAdapter = cleaner.adapter(journal.prefix, modelName => remainingModelResources(observer, model, modelName), heartbeat);
    await journal.cleanup({key: keyAdapter, model: modelAdapter, app: keyAdapter, identity: keyAdapter}, heartbeat);
    expect((await cleaner.find(name))).toBeNull();
    const remaining = await remainingModelResources(observer, model, name);
    expect(remaining).toEqual({podCount: 0, catalogCount: 0});
    if (phase1Run) {
      const page = await context!.newPage();
      try {
        await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
        await expect(page.getByRole('heading', {name: 'Installed Models'})).toBeVisible();
        await expect(page.getByRole('heading', {name, exact: true})).toHaveCount(0);
        if (blockedMutations.length) {
          requireSafe(process.env.REGRESSION_RUN_DIR, 'CONFIG');
          await writePrivate(join(process.env.REGRESSION_RUN_DIR, 'blocked-mutations.json'), blockedMutations);
        }
        requireSafe(blockedWrites === 0, 'MUTATION');
      } finally { await page.close(); }
    }
  });
});
