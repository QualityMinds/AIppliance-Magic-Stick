import {test, expect, type BrowserContext, type Page} from '@playwright/test';
import type {MemoryEstimate, ModelActivation} from '@magicstick/dashboard-contracts';
import {join} from 'node:path';
import {loadLabConfig, type LabConfig, type LocalModelFixture} from '../core/config.ts';
import {type ExactDashboardRequest} from '../core/auth.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {ResourceJournal, newRunId} from '../core/journal.ts';
import {OwnedModelClient, activation, editRevision, fixtureIsAdvertised} from '../core/owned-model.ts';
import {InferenceProbe} from '../core/inference.ts';
import {poll} from '../core/poll.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';
import {requirePhase2Profile} from '../profiles/phase2-p0.ts';
import {evidenceAnnotations, type Evidence} from '../core/evidence.ts';
import {readPrivate} from '../core/private-files.ts';

type Created = {client: OwnedModelClient; journal: ResourceJournal; name: string; uid: string; generation: number;
  fixture: LocalModelFixture; estimate: MemoryEstimate};
type JsonHttpResponse = {status(): number; json(): Promise<unknown>};

function responseActivation(value: unknown): ModelActivation {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) && 'activation' in value
    ? (value as {activation?: unknown}).activation : value;
  requireSafe(candidate && typeof candidate === 'object' && !Array.isArray(candidate), 'API');
  return candidate as ModelActivation;
}

function estimatorBody(fixture: LocalModelFixture, contextWindow = fixture.contextWindow, memoryRequiredMi?: number) {
  return {modelType: 'chat', contextWindow, maxOutputTokens: null, maxNumSeqs: 1,
    kvCacheType: fixture.kvCacheType, cpuOffloading: false,
    ...(memoryRequiredMi === undefined ? {} : {memoryRequiredMi})};
}

function creationEstimateBody(fixture: LocalModelFixture) {
  return {engine: fixture.engine, computeTarget: 'cpu', url: fixture.url, contextWindow: fixture.contextWindow,
    maxNumSeqs: 1, modelType: 'chat', kvCacheType: fixture.kvCacheType};
}

function alternateContext(current: number) { return current === 1024 ? 2048 : Math.max(256, Math.min(4096, Math.floor(current / 2))); }

test.describe.serial('Phase 2 installed CPU model control', () => {
  let config: LabConfig;
  let live: LiveFoundation | undefined;
  let context: BrowserContext;
  let allowed: ExactDashboardRequest[] = [];
  let inference: InferenceProbe;

  async function journal(label: string) {
    requireSafe(process.env.REGRESSION_RUN_DIR, 'CONFIG');
    const runId = newRunId();
    const item = await ResourceJournal.create(join(process.env.REGRESSION_RUN_DIR, `${label}-${runId}.journal.json`),
      runId, config.expected.applianceUid);
    live!.journals.push(item); return item;
  }

  async function exactRequest(method: ExactDashboardRequest['method'], path: string, body: unknown) {
    await live!.guard();
    const url = new URL(path, config.dashboardUrl);
    requireSafe(url.origin === config.dashboardUrl && url.pathname === path && !url.search && !url.hash, 'MUTATION');
    try { return await context.request.fetch(url.href, {method, headers: {Origin: config.dashboardUrl,
      'Content-Type': 'application/json', 'X-MagicStick-CSRF': 'dashboard'}, data: JSON.stringify(body),
    timeout: config.requestTimeoutMs, maxRedirects: 0, failOnStatusCode: false}); }
    catch { throw new HarnessError('API'); }
  }

  async function recordCreated(response: JsonHttpResponse, item: ResourceJournal, name: string, client?: OwnedModelClient) {
    let created: ModelActivation | undefined;
    if (response.status() >= 200 && response.status() < 300) {
      try { created = responseActivation(await response.json()); } catch { /* Resolve from Kubernetes below. */ }
    }
    const observed = created ?? await live!.cleaner.find(name);
    if (!observed && (response.status() < 200 || response.status() >= 300)) {
      await item.rejected('model', name); throw new HarnessError('API');
    }
    requireSafe(observed?.metadata?.name === name && observed.metadata.namespace === config.expected.applianceNamespace &&
      typeof observed.metadata.uid === 'string' && Number.isSafeInteger(observed.metadata.generation) &&
      Number(observed.metadata.generation) > 0, 'API');
    await item.owned('model', name, observed.metadata.uid, Number(observed.metadata.generation));
    client?.adopt(observed.metadata.uid);
    requireSafe(response.status() >= 200 && response.status() < 300, 'API');
    return {uid: observed.metadata.uid, generation: Number(observed.metadata.generation)};
  }

  async function createLocal(page: Page, fixture: LocalModelFixture, label: string): Promise<Created> {
    const item = await journal(label), name = item.prefix + label;
    let client = new OwnedModelClient(context.request, config.dashboardUrl, config.requestTimeoutMs, name,
      fixture, item.prefix, live!.guard);
    requireSafe(!(await live!.cleaner.find(name)) && !activation(await client.models(), name), 'OWNERSHIP');
    await expect(inference.advertised(name)).resolves.toBe(false);
    allowed = [{method: 'POST', path: '/api/models/estimate-memory', body: creationEstimateBody(fixture), mutating: false}];
    await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
    await page.getByRole('button', {name: 'Create', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Create Model'});
    await dialog.getByLabel('Inference Engine').selectOption(fixture.engine);
    await dialog.getByLabel('Hardware').selectOption('cpu');
    await dialog.getByLabel('Model source').selectOption('direct');
    await dialog.getByLabel('Context Size').fill(String(fixture.contextWindow));
    await dialog.getByLabel('Max Num Seqs').fill('1');
    await dialog.getByLabel('KV Cache').selectOption(fixture.kvCacheType!);
    const estimateResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models/estimate-memory' &&
      response.request().method() === 'POST');
    await dialog.getByLabel(fixture.engine === 'OLlama' ? 'Ollama model reference' : 'Hugging Face URL').fill(fixture.url);
    const estimateHttp = await estimateResponse;
    requireSafe(estimateHttp.status() === 200, 'API');
    const estimate = await estimateHttp.json() as MemoryEstimate;
    const currentModels = await client.models();
    const capacities = [...(currentModels.computeMemory?.devices ?? [])
      .filter(device => device.computeTarget === 'cpu' || device.id === 'cpu').map(device => device.unreservedMi),
    estimate.maximumMi].filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    requireSafe(capacities.length > 0 && fixture.memoryRequiredMi >= estimate.minimumMi &&
      fixture.memoryRequiredMi <= Math.max(...capacities), 'CAPABILITY');
    // The real UI accepts advisory estimate uncertainty when submitting. Capacity
    // and the model's minimum remain independently checked above.
    client = new OwnedModelClient(context.request, config.dashboardUrl, config.requestTimeoutMs, name,
      fixture, item.prefix, live!.guard, estimate.confidence !== 'high');
    await dialog.getByLabel('Name').fill(name);
    await dialog.getByLabel('RAM budget (MiB)').fill(String(fixture.memoryRequiredMi));
    const payload = client.payload();
    allowed = [{method: 'POST', path: '/api/models/local', body: payload}];
    await item.requested('model', name);
    const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models/local' &&
      response.request().method() === 'POST');
    await dialog.getByRole('button', {name: 'Add Local Model'}).click();
    const response = await responsePromise;
    const created = await recordCreated(response, item, name, client);
    allowed = [];
    return {client, journal: item, name, fixture, estimate, ...created};
  }

  async function updateGeneration(model: Created, response: JsonHttpResponse) {
    requireSafe(response.status() >= 200 && response.status() < 300, 'API');
    const updated = responseActivation(await response.json());
    requireSafe(updated.metadata?.uid === model.uid && Number.isSafeInteger(updated.metadata.generation) &&
      Number(updated.metadata.generation) > model.generation, 'API');
    await model.journal.modelGeneration(model.name, model.uid, model.generation, Number(updated.metadata.generation));
    model.generation = Number(updated.metadata.generation); return updated;
  }

  async function waitStopped(model: Created) {
    return poll(() => live!.modelState(model.client, model.uid), value => value.item?.spec?.enabled === false &&
      value.item.metadata?.generation === model.generation && value.pods.length === 0 &&
      !value.models.models?.some(entry => entry.id === model.name),
    {timeoutMs: 300_000, intervalMs: 1000, stage: 'model-stopped'});
  }

  async function exerciseLocal(fixture: LocalModelFixture, label: string) {
    const page = await context.newPage(); let model: Created | undefined;
    try {
      model = await createLocal(page, fixture, label);
      const starting = activation(await model.client.models(), model.name);
      requireSafe(starting?.metadata?.uid === model.uid && starting.spec?.local?.engine === fixture.engine &&
        starting.spec.local.computeTarget === 'cpu' && starting.spec.local.url === fixture.url &&
        starting.spec.local.kvCacheType === fixture.kvCacheType, 'API');
      const ready = await live!.waitReady(model.client, model.uid, model.generation);
      const readyItem = ready.item;
      requireSafe(readyItem && readyItem.status?.requestedKvCacheType === fixture.kvCacheType, 'API');
      requireSafe(typeof readyItem.status?.effectiveKvCacheType === 'string' &&
        readyItem.status.effectiveKvCacheType.length > 0, 'API');
      requireSafe(await inference.advertised(model.name), 'API'); await inference.chat(model.name);
      const logs = await model.client.logs();
      requireSafe(logs.model === model.name && logs.tailLines === 300 && logs.pods.length > 0, 'API');
      await page.reload({waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: `View logs for ${model.name}`}).click();
      await expect(page.getByRole('dialog', {name: `Runtime logs · ${model.name}`})).toBeVisible();
      await expect(page.getByRole('dialog', {name: `Runtime logs · ${model.name}`}).locator('pre').first()).not.toBeEmpty();
      await page.getByRole('dialog', {name: `Runtime logs · ${model.name}`}).getByRole('button', {name: 'Close dialog'}).click();

      const changedContext = alternateContext(fixture.contextWindow), changedMemory = fixture.memoryRequiredMi + 100;
      allowed = [
        {method: 'POST', path: `/api/models/${model.name}/estimate-memory`, body: estimatorBody(fixture, fixture.contextWindow, fixture.memoryRequiredMi), mutating: false},
        {method: 'POST', path: `/api/models/${model.name}/estimate-memory`, body: estimatorBody(fixture, changedContext, fixture.memoryRequiredMi), mutating: false},
        {method: 'POST', path: `/api/models/${model.name}/estimate-memory`, body: estimatorBody(fixture, changedContext, changedMemory), mutating: false},
        {method: 'POST', path: `/api/models/${model.name}/estimate-memory`, body: estimatorBody(fixture, 0, fixture.memoryRequiredMi), mutating: false},
      ];
      await page.getByRole('button', {name: `Edit ${model.name}`}).click();
      const dialog = page.getByRole('dialog', {name: `Edit Model · ${model.name}`});
      const save = dialog.getByRole('button', {name: 'Save changes'});
      await expect(save).toBeDisabled();
      const slider = dialog.getByRole('slider', {name: 'Memory reservation'});
      await expect(slider).toBeEnabled();
      const sliderMaximum = Number(await slider.getAttribute('max'));
      requireSafe(Number.isSafeInteger(sliderMaximum) && sliderMaximum >= changedMemory &&
        sliderMaximum % 100 === 0 && Number(await slider.getAttribute('min')) === 100, 'CAPABILITY');
      allowed.push({method: 'POST', path: `/api/models/${model.name}/estimate-memory`,
        body: estimatorBody(fixture, fixture.contextWindow, sliderMaximum), mutating: false});
      await slider.press('End');
      await expect(slider).toHaveValue(String(sliderMaximum));
      await expect(dialog.getByLabel('RAM budget (MiB)')).toHaveValue(String(sliderMaximum));
      await dialog.getByLabel('RAM budget (MiB)').fill(String(fixture.memoryRequiredMi));
      await expect(save).toBeDisabled();
      await dialog.getByLabel('Context Size').fill(String(changedContext)); await expect(save).toBeEnabled();
      await dialog.getByLabel('RAM budget (MiB)').fill(String(changedMemory));
      await expect(dialog.getByLabel('Context Size')).toHaveValue(String(changedContext));
      await expect(slider).toHaveValue(String(changedMemory));
      await dialog.getByLabel('RAM budget (MiB)').fill(String(fixture.memoryRequiredMi));
      await dialog.getByLabel('Context Size').fill('0'); await expect(save).toBeDisabled();
      await dialog.getByLabel('Context Size').fill(String(fixture.contextWindow)); await expect(save).toBeDisabled();
      await dialog.getByLabel('Context Size').fill(String(changedContext));
      await dialog.getByLabel('RAM budget (MiB)').fill(String(changedMemory));
      const current = activation(await model.client.models(), model.name);
      requireSafe(current?.metadata?.uid === model.uid && current.metadata.generation === model.generation, 'OWNERSHIP');
      const staleRevision = editRevision(current);
      const updateBody = {expectedRevision: staleRevision,
        local: {contextWindow: changedContext, memoryRequiredMi: changedMemory}};
      allowed.push({method: 'PUT', path: `/api/models/${model.name}`, body: updateBody});
      const updatePromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${model!.name}` &&
        response.request().method() === 'PUT');
      await expect(save).toBeEnabled(); await save.click();
      await updateGeneration(model, await updatePromise); allowed = [];
      const updatedReady = await live!.waitReady(model.client, model.uid, model.generation);
      requireSafe(updatedReady.item?.spec?.local?.contextWindow === changedContext &&
        updatedReady.item.spec.local.memoryRequiredMi === changedMemory, 'API');
      await inference.chat(model.name);
      await model.client.rejectsStaleContextUpdate(staleRevision, fixture.contextWindow);

      await page.reload({waitUntil: 'domcontentloaded'});
      allowed = [{method: 'POST', path: `/api/models/${model.name}/estimate-memory`,
        body: estimatorBody(fixture, changedContext, changedMemory), mutating: false}];
      await page.getByRole('button', {name: `Edit ${model.name}`}).click();
      await expect(page.getByRole('dialog', {name: `Edit Model · ${model.name}`}).getByLabel('Context Size')).toHaveValue(String(changedContext));
      await expect(page.getByRole('dialog', {name: `Edit Model · ${model.name}`}).getByLabel('RAM budget (MiB)')).toHaveValue(String(changedMemory));
      await page.getByRole('dialog', {name: `Edit Model · ${model.name}`}).getByRole('button', {name: 'Cancel'}).click();
      const beforeStop = activation(await model.client.models(), model.name)!;
      allowed = [{method: 'POST', path: `/api/models/${model.name}/stop`, body: {expectedRevision: editRevision(beforeStop)}}];
      const stopPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${model!.name}/stop`);
      await page.getByRole('button', {name: `Stop ${model.name}`}).click();
      await updateGeneration(model, await stopPromise); allowed = []; await waitStopped(model);
      requireSafe(!(await inference.advertised(model.name)), 'API'); await inference.refusesStopped(model.name);
      await page.reload({waitUntil: 'domcontentloaded'});
      await expect(page.getByRole('button', {name: `Start ${model.name}`})).toBeVisible();
      const beforeStart = activation(await model.client.models(), model.name)!;
      allowed = [{method: 'POST', path: `/api/models/${model.name}/start`, body: {expectedRevision: editRevision(beforeStart)}}];
      const startPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${model!.name}/start`);
      await page.getByRole('button', {name: `Start ${model.name}`}).click();
      await updateGeneration(model, await startPromise); allowed = [];
      const restartedReady = await live!.waitReady(model.client, model.uid, model.generation);
      requireSafe(restartedReady.item?.spec?.local?.contextWindow === changedContext &&
        restartedReady.item.spec.local.memoryRequiredMi === changedMemory, 'API');
      await inference.chat(model.name);
    } finally {
      allowed = [];
      if (model) { await live!.cleanup(model.journal); requireSafe(!(await inference.advertised(model.name)), 'CLEANUP'); }
      await page.close();
    }
  }

  test.beforeAll(async ({browser}) => {
    requireSafe(process.env.REGRESSION_CONFIG && process.env.REGRESSION_RUN_DIR && process.env.REGRESSION_RUN_ID, 'CONFIG');
    config = await loadLabConfig(process.env.REGRESSION_CONFIG); requirePhase2Profile(config);
    requireSafe(config.inferenceUrl && config.phase2, 'CONFIG');
    const root = await ResourceJournal.resume(join(process.env.REGRESSION_RUN_DIR, 'journal.json'), config.expected.applianceUid);
    live = await LiveFoundation.open(browser, config, root, {allowedDashboardRequests: () => allowed,
      assertMutationAllowed: async () => live!.guard(), inferenceOrigin: config.inferenceUrl});
    context = live.context;
    fixtureIsAdvertised(live.snapshot.models, config.phase2.ollamaModel);
    fixtureIsAdvertised(live.snapshot.models, config.phase2.vllmModel);
    const modules = live.snapshot.models.modules as Record<string, {enabled?: boolean}> | undefined;
    requireSafe(['kubeai', 'litellm', 'model-catalog'].every(id => modules?.[id]?.enabled === true), 'CAPABILITY');
    const liteLlmPage = await context.newPage();
    try { await liteLlmPage.goto(config.inferenceUrl + '/ui/playground/', {waitUntil: 'domcontentloaded', timeout: config.loginTimeoutMs});
      requireSafe(new URL(liteLlmPage.url()).origin === config.inferenceUrl, 'AUTH'); }
    finally { await liteLlmPage.close(); }
    const key = await live.createKey('phase2-key'); inference = new InferenceProbe(context.request, config.inferenceUrl, key.secret);
  });

  test.afterAll(async () => { allowed = []; await live?.close(); });

  const common = (engine: 'ollama' | 'vllm'): Evidence[] => [
    {id: 'LIFE-02', variant: `local-create-${engine}`, layer: 'A'},
    {id: 'LIFE-02', variant: `local-create-${engine}`, layer: 'E'},
    {id: 'LIFE-07', variant: `edit-${engine}`, layer: 'A'},
    {id: 'LIFE-07', variant: `edit-${engine}`, layer: 'E'},
    {id: 'LIFE-08', variant: `dirty-${engine}`, layer: 'E'},
    {id: 'LIFE-09', variant: `conflict-${engine}`, layer: 'A'},
    {id: 'LIFE-09', variant: `conflict-${engine}`, layer: 'E'},
    {id: 'LIFE-13', variant: `persistence-${engine}`, layer: 'A'},
    {id: 'LIFE-13', variant: `persistence-${engine}`, layer: 'E'},
    {id: 'ENG-01', variant: `engine-${engine}`, layer: 'A'},
    {id: 'ENG-03', variant: `kv-${engine}`, layer: 'A'},
    {id: 'ENG-03', variant: `kv-${engine}`, layer: 'E'},
    {id: 'MEM-06', variant: `slider-${engine}`, layer: 'E'},
    {id: 'LOG-01', variant: `logs-${engine}`, layer: 'A'},
    {id: 'LOG-01', variant: `logs-${engine}`, layer: 'E'},
  ];

  test('LIFE-02 LIFE-07 LIFE-08 LIFE-09 LIFE-13 ENG-01 ENG-02 ENG-03 MEM-06 ROUTE-02 LOG-01 CPU Ollama',
    evidenceAnnotations(...common('ollama'),
      {id: 'ENG-02', variant: 'alias-ollama', layer: 'A'},
      {id: 'ROUTE-02', variant: 'catalog-transitions', layer: 'A'}),
    () => exerciseLocal(config.phase2!.ollamaModel, 'ollama'));

  test('LIFE-02 LIFE-07 LIFE-08 LIFE-09 LIFE-13 ENG-01 ENG-03 MEM-06 LOG-01 CPU vLLM',
    evidenceAnnotations(...common('vllm')), () => exerciseLocal(config.phase2!.vllmModel, 'vllm'));

  test('ENG-10 unsupported target is rejected and raw runtime settings never enter saved intent', evidenceAnnotations(
    {id: 'ENG-10', variant: 'unsupported-request', layer: 'A'}), async () => {
    const item = await journal('unsupported'), name = item.prefix + 'unsupported';
    const fixture = config.phase2!.vllmModel;
    const local = {modelType: 'chat', computeTarget: 'cpu', engine: fixture.engine, url: fixture.url,
      contextWindow: fixture.contextWindow, maxNumSeqs: 1, kvCacheType: fixture.kvCacheType,
      memoryRequiredMi: fixture.memoryRequiredMi};
    const body = {name, enabled: false, targetNamespace: 'ai', local: {...local, computeTarget: 'regression-unsupported'}};
    await item.requested('model', name); const response = await exactRequest('POST', '/api/models/local', body);
    if (response.status() >= 200 && response.status() < 300) { await recordCreated(response, item, name); throw new HarnessError('API'); }
    requireSafe(response.status() < 500 && !(await live!.cleaner.find(name)), 'API');
    await item.rejected('model', name);

    // The owning API contract sanitizes unrecognized runtime keys; it need not
    // reject the otherwise valid definition. Keep this definition disabled and
    // independently inspect the persisted spec, not merely its HTTP status.
    const sanitized = await journal('sanitized'), sanitizedName = sanitized.prefix + 'sanitized';
    await sanitized.requested('model', sanitizedName);
    const injection = await exactRequest('POST', '/api/models/local', {name: sanitizedName, enabled: false,
      targetNamespace: 'ai', local: {...local, env: {REGRESSION_INJECTED: 'true'},
        args: ['--regression-injected'], resourceProfile: 'regression-injected:1'}});
    if (injection.status() >= 200 && injection.status() < 300) {
      await recordCreated(injection, sanitized, sanitizedName);
      const saved = await live!.cleaner.find(sanitizedName);
      const savedLocal = saved?.spec?.local as Record<string, unknown> | undefined;
      requireSafe(saved?.spec?.enabled === false && savedLocal?.computeTarget === 'cpu' &&
        savedLocal.engine === fixture.engine && savedLocal.url === fixture.url &&
        ['env', 'args', 'resourceProfile'].every(key => !Object.hasOwn(savedLocal, key)), 'API');
      await live!.cleanup(sanitized);
    } else {
      requireSafe(injection.status() >= 400 && injection.status() < 500 && !(await live!.cleaner.find(sanitizedName)), 'API');
      await sanitized.rejected('model', sanitizedName);
    }
  });

  test('MEM-05 API requires explicit memory-risk acceptance for a legal underbudget CPU definition', evidenceAnnotations(
    {id: 'MEM-05', variant: 'memory-risk', layer: 'A'}), async () => {
    const fixture = config.phase2!.ollamaModel;
    const estimateResponse = await exactRequest('POST', '/api/models/estimate-memory', creationEstimateBody(fixture));
    requireSafe(estimateResponse.status() === 200, 'API');
    const estimate = await estimateResponse.json() as MemoryEstimate;
    const risky = Math.max(100, Math.floor((estimate.minimumMi - 100) / 100) * 100);
    requireSafe(risky < estimate.minimumMi, 'CAPABILITY');
    const rejected = await journal('risk-reject'), rejectedName = rejected.prefix + 'risk-reject';
    const base = {enabled: false, targetNamespace: 'ai', local: {modelType: 'chat', computeTarget: 'cpu', engine: fixture.engine,
      url: fixture.url, contextWindow: fixture.contextWindow, maxNumSeqs: 1, kvCacheType: fixture.kvCacheType,
      memoryRequiredMi: risky}};
    await rejected.requested('model', rejectedName);
    const denied = await exactRequest('POST', '/api/models/local', {name: rejectedName, ...base});
    if (denied.status() >= 200 && denied.status() < 300) { await recordCreated(denied, rejected, rejectedName); throw new HarnessError('API'); }
    requireSafe(denied.status() < 500 && !(await live!.cleaner.find(rejectedName)), 'API');
    await rejected.rejected('model', rejectedName);
    const accepted = await journal('risk-accept'), acceptedName = accepted.prefix + 'risk-accept';
    await accepted.requested('model', acceptedName);
    const response = await exactRequest('POST', '/api/models/local', {name: acceptedName, ...base,
      local: {...base.local, allowMemoryRisk: true}});
    await recordCreated(response, accepted, acceptedName);
    const saved = await live!.cleaner.find(acceptedName);
    const savedLocal = saved?.spec?.local as Record<string, unknown> | undefined;
    requireSafe(saved?.spec?.enabled === false && savedLocal?.allowMemoryRisk === true &&
      savedLocal.memoryRequiredMi === risky, 'API');
    await live!.cleanup(accepted);
  });

  test('ROUTE-05 external provider create, edit, Stop and Start preserve the controlled route', evidenceAnnotations(
    {id: 'ROUTE-05', variant: 'external-route', layer: 'A'},
    {id: 'ROUTE-05', variant: 'external-route', layer: 'E'}), async () => {
    const item = await journal('external'), name = item.prefix + 'external';
    const fixture = config.phase2!.externalModel;
    // The controlled KubeAI provider does not authenticate, but its OpenAI
    // client still needs the same sentinel as the deployed kubeai_deployment.
    // A configured provider's credential remains private and opt-in.
    let providerKey = fixture.source === 'owned-ollama' ? 'none' :
      fixture.apiKeyFile ? (await readPrivate(fixture.apiKeyFile)).trim() : '';
    const providerJournal = fixture.source === 'owned-ollama' ? await journal('provider') : undefined;
    let provider: Awaited<ReturnType<LiveFoundation['createModel']>> | undefined;
    const page = await context.newPage();
    try {
      if (providerJournal) {
        provider = await live!.createModel('provider', providerJournal, config.phase2!.ollamaModel);
        await live!.waitReady(provider.client, provider.uid, provider.generation);
        await inference.chat(provider.client.name);
      }
      const providerModel = provider ? `openai/${provider.client.name}` : fixture.model;
      requireSafe(providerModel, 'CONFIG');
      const payload = {name, enabled: true, targetNamespace: 'ai', external: {model: providerModel,
        apiBase: fixture.apiBase, modelType: 'chat', contextWindow: fixture.contextWindow}, ...(providerKey ? {apiKey: providerKey} : {})};
      allowed = [{method: 'POST', path: '/api/models/external', body: payload}];
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: 'Create', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: 'Create Model'});
      await dialog.getByLabel('Location').selectOption('external');
      await dialog.getByLabel('Name').fill(name); await dialog.getByLabel('Provider Model').fill(providerModel);
      await dialog.getByLabel('API Base').fill(fixture.apiBase);
      await dialog.getByLabel('Context Size').fill(String(fixture.contextWindow));
      if (providerKey) await dialog.getByLabel('API Key').fill(providerKey);
      await item.requested('model', name);
      const createPromise = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models/external');
      await dialog.getByRole('button', {name: 'Add External Model'}).click();
      const created = await recordCreated(await createPromise, item, name); allowed = [];
      let generation = created.generation;
      await poll(() => live!.api.models(), payload => {
        const saved = activation(payload, name); return saved?.metadata?.uid === created.uid && saved.status?.phase === 'Ready' &&
          payload.models?.some(model => model.id === name) === true;
      }, {timeoutMs: 300_000, intervalMs: 1000, stage: 'external-ready'});
      requireSafe(await inference.advertised(name), 'API'); await inference.chat(name, provider?.client.name);
      const beforeEdit = activation(await live!.api.models(), name)!;
      const changedContext = fixture.contextWindow === 4096 ? 8192 : 4096;
      const editBody = {expectedRevision: editRevision(beforeEdit), external: {contextWindow: changedContext}};
      allowed = [{method: 'PUT', path: `/api/models/${name}`, body: editBody}];
      await page.getByRole('button', {name: `Edit ${name}`}).click();
      const edit = page.getByRole('dialog', {name: `Edit Model · ${name}`});
      await edit.getByLabel('Context Size').fill(String(changedContext));
      const editPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}` &&
        response.request().method() === 'PUT');
      await edit.getByRole('button', {name: 'Save changes'}).click();
      const edited = responseActivation(await (await editPromise).json());
      requireSafe(edited.metadata?.uid === created.uid && Number(edited.metadata.generation) > generation &&
        edited.spec?.external?.contextWindow === changedContext && edited.spec.external.apiBase === fixture.apiBase, 'API');
      await item.modelGeneration(name, created.uid, generation, Number(edited.metadata.generation)); generation = Number(edited.metadata.generation); allowed = [];
      const stopBody = {expectedRevision: editRevision(edited)};
      allowed = [{method: 'POST', path: `/api/models/${name}/stop`, body: stopBody}];
      const stopPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/stop`);
      await page.getByRole('button', {name: `Stop ${name}`}).click();
      const stopped = responseActivation(await (await stopPromise).json());
      requireSafe(stopped.metadata?.uid === created.uid && stopped.spec?.enabled === false && Number(stopped.metadata.generation) > generation, 'API');
      await item.modelGeneration(name, created.uid, generation, Number(stopped.metadata.generation)); generation = Number(stopped.metadata.generation); allowed = [];
      await poll(() => inference.advertised(name), value => value === false,
        {timeoutMs: 120_000, intervalMs: 1000, stage: 'external-stopped'});
      await inference.refusesStopped(name);
      if (provider) {
        await live!.waitReady(provider.client, provider.uid, provider.generation);
        await inference.chat(provider.client.name);
      }
      const startBody = {expectedRevision: editRevision(stopped)};
      allowed = [{method: 'POST', path: `/api/models/${name}/start`, body: startBody}];
      await page.reload({waitUntil: 'domcontentloaded'});
      const startPromise = page.waitForResponse(response => new URL(response.url()).pathname === `/api/models/${name}/start`);
      await page.getByRole('button', {name: `Start ${name}`}).click();
      const started = responseActivation(await (await startPromise).json());
      requireSafe(started.metadata?.uid === created.uid && started.spec?.enabled === true && Number(started.metadata.generation) > generation, 'API');
      await item.modelGeneration(name, created.uid, generation, Number(started.metadata.generation)); allowed = [];
      await poll(() => inference.advertised(name), value => value === true,
        {timeoutMs: 300_000, intervalMs: 1000, stage: 'external-ready'}); await inference.chat(name, provider?.client.name);
    } finally {
      allowed = []; providerKey = '';
      try { await live!.cleanup(item); }
      finally {
        try { if (providerJournal) await live!.cleanup(providerJournal); }
        finally { await page.close(); }
      }
    }
  });
});
