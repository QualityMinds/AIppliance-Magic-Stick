import type {APIRequestContext} from '@playwright/test';
import {MagicStickApi} from '@magicstick/dashboard-api-client';
import type {ModelActivation, ModelsPayload} from '@magicstick/dashboard-contracts';
import type {LocalModelFixture} from './config.ts';
import {HarnessError, requireSafe} from './errors.ts';
import type {KubectlObserver, KubeObject} from './observer.ts';

function modelName(name: string, prefix: string) {
  requireSafe(name.startsWith(prefix) && /^[a-z0-9][a-z0-9-]{0,62}$/.test(name), 'OWNERSHIP');
}

export function editRevision(item: ModelActivation) {
  const {uid, generation, resourceVersion} = item.metadata ?? {};
  return uid && Number.isSafeInteger(generation) && Number(generation) > 0
    ? `generation:${uid}:${generation}` : String(resourceVersion ?? '');
}

export function activation(payload: ModelsPayload, name: string) {
  const matches = payload.activations.filter(item => item.metadata?.name === name);
  requireSafe(matches.length <= 1, 'OWNERSHIP');
  return matches[0] ?? null;
}

/** Product API mutations are restricted to one unique CPU model owned by this run. */
export class OwnedModelClient {
  private readonly api: MagicStickApi;
  private ownedUid: string | undefined;
  private readonly request: APIRequestContext;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly allowMemoryRisk: boolean;
  readonly name: string;
  readonly fixture: LocalModelFixture;
  private readonly assertMutationAllowed: () => Promise<void>;
  constructor(request: APIRequestContext, baseUrl: string, timeoutMs: number, name: string,
    fixture: LocalModelFixture, prefix: string,
    assertMutationAllowed: () => Promise<void>, allowMemoryRisk = false) {
    this.request = request; this.baseUrl = baseUrl; this.timeoutMs = timeoutMs;
    this.name = name; this.fixture = fixture; this.assertMutationAllowed = assertMutationAllowed;
    this.allowMemoryRisk = allowMemoryRisk;
    modelName(name, prefix);
    const origin = new URL(baseUrl).origin;
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      const method = String(init.method ?? 'GET').toUpperCase();
      requireSafe(url.origin === origin && !url.hash, 'MUTATION');
      if (method === 'GET') {
        const logs = url.pathname === `/api/models/${encodeURIComponent(name)}/logs` &&
          url.searchParams.size === 1 && url.searchParams.get('tailLines') === '300';
        requireSafe((url.pathname === '/api/models' && !url.search) || logs, 'MUTATION');
      } else if (method === 'POST') {
        requireSafe(!url.search && typeof init.body === 'string', 'MUTATION');
        let body: unknown;
        try { body = JSON.parse(init.body); } catch { throw new HarnessError('MUTATION'); }
        if (url.pathname === '/api/models/local') {
          requireSafe(JSON.stringify(body) === JSON.stringify(this.createPayload()), 'MUTATION');
        } else if (['start', 'stop'].some(action => url.pathname === `/api/models/${encodeURIComponent(name)}/${action}`)) {
          const revision = (body as {expectedRevision?: unknown} | null)?.expectedRevision;
          const parts = typeof revision === 'string' ? /^generation:([^:]+):([1-9]\d*)$/.exec(revision) : null;
          requireSafe(this.ownedUid && body && typeof body === 'object' && !Array.isArray(body) &&
            Object.keys(body).length === 1 && parts?.[1] === this.ownedUid,
          'MUTATION');
        } else throw new HarnessError('MUTATION');
      } else throw new HarnessError('MUTATION');
      const headers = new Headers(init.headers);
      if (method !== 'GET') { await this.assertMutationAllowed(); headers.set('Origin', origin); }
      let response;
      try { response = await request.fetch(url.href, {method, headers: Object.fromEntries(headers.entries()),
        ...(init.body ? {data: String(init.body)} : {}), timeout: timeoutMs, maxRedirects: 0, failOnStatusCode: false}); }
      catch { throw new HarnessError('API'); }
      requireSafe(response.status() >= 200 && response.status() < 300 &&
        (response.headers()['content-type'] ?? '').includes('application/json'), 'API');
      const bytes = await response.body();
      requireSafe(bytes.length < 8 * 1024 * 1024, 'API');
      return new Response(bytes.toString('utf8'), {status: response.status(), headers: {'Content-Type': 'application/json'}});
    };
    this.api = new MagicStickApi({baseUrl, fetch: transport});
  }

  private createPayload() {
    return {name: this.name, enabled: true, targetNamespace: 'ai', local: {
      modelType: 'chat', computeTarget: this.fixture.computeTarget, engine: this.fixture.engine, url: this.fixture.url,
      contextWindow: this.fixture.contextWindow, maxNumSeqs: 1, memoryRequiredMi: this.fixture.memoryRequiredMi,
      ...(this.fixture.kvCacheType ? {kvCacheType: this.fixture.kvCacheType} : {}),
      ...(this.allowMemoryRisk ? {allowMemoryRisk: true} : {}),
    }};
  }

  /** Exact reviewed create intent used by the browser request fence. */
  payload() { return structuredClone(this.createPayload()); }

  async models() { return this.api.models(); }
  async logs() { return this.api.modelLogs(this.name); }
  async create(): Promise<{uid: string; generation: number}> {
    requireSafe(!activation(await this.models(), this.name), 'OWNERSHIP');
    let result: unknown;
    try { result = await this.api.createLocalModel(this.createPayload()); }
    catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('API'); }
    const metadata = (result as ModelActivation | null)?.metadata;
    requireSafe(metadata?.name === this.name && metadata.namespace === 'ai-system' && typeof metadata.uid === 'string' &&
      metadata.uid.length > 0 && Number.isSafeInteger(metadata.generation) && Number(metadata.generation) > 0, 'OWNERSHIP');
    this.ownedUid = metadata.uid;
    return {uid: metadata.uid, generation: Number(metadata.generation)};
  }

  adopt(uid: string) { requireSafe(uid.length > 0, 'OWNERSHIP'); this.ownedUid = uid; }

  async start(current: ModelActivation): Promise<{uid: string; generation: number}> {
    requireSafe(this.ownedUid && current.metadata?.uid === this.ownedUid && current.spec?.enabled === false &&
      current.metadata.name === this.name, 'OWNERSHIP');
    let result: {activation?: ModelActivation};
    try { result = await this.api.request<{activation?: ModelActivation}>(`/api/models/${encodeURIComponent(this.name)}/start`,
      {method: 'POST', body: JSON.stringify({expectedRevision: editRevision(current)})}); }
    catch (error) { if (error instanceof HarnessError) throw error; throw new HarnessError('API'); }
    const item = result.activation;
    requireSafe(item?.metadata?.uid === this.ownedUid && item.spec?.enabled === true &&
      Number.isSafeInteger(item.metadata.generation) && Number(item.metadata.generation) > Number(current.metadata.generation), 'API');
    return {uid: this.ownedUid, generation: Number(item.metadata.generation)};
  }

  async stop(current: ModelActivation): Promise<{uid: string; generation: number}> {
    requireSafe(this.ownedUid && current.metadata?.uid === this.ownedUid && current.spec?.enabled === true &&
      current.metadata.name === this.name, 'OWNERSHIP');
    const result = await this.api.request<{activation?: ModelActivation}>(`/api/models/${encodeURIComponent(this.name)}/stop`,
      {method: 'POST', body: JSON.stringify({expectedRevision: editRevision(current)})});
    const item = result.activation;
    requireSafe(item?.metadata?.uid === this.ownedUid && item.spec?.enabled === false &&
      Number.isSafeInteger(item.metadata.generation) && Number(item.metadata.generation) > Number(current.metadata.generation), 'API');
    return {uid: this.ownedUid, generation: Number(item.metadata.generation)};
  }

  async rejectsStaleContextUpdate(expectedRevision: string, contextWindow: number) {
    const stale = /^generation:([^:]+):([1-9]\d*)$/.exec(expectedRevision);
    requireSafe(this.ownedUid && stale?.[1] === this.ownedUid && Number.isSafeInteger(contextWindow) &&
      contextWindow >= 256 && contextWindow <= 4096, 'MUTATION');
    const current = activation(await this.models(), this.name);
    requireSafe(current?.metadata?.uid === this.ownedUid && editRevision(current) !== expectedRevision, 'OWNERSHIP');
    let response;
    await this.assertMutationAllowed();
    try {
      response = await this.request.fetch(`${new URL(this.baseUrl).origin}/api/models/${encodeURIComponent(this.name)}`, {
        method: 'PUT', headers: {Origin: new URL(this.baseUrl).origin, 'Content-Type': 'application/json',
          'X-MagicStick-CSRF': 'dashboard'},
        data: JSON.stringify({expectedRevision, local: {contextWindow}}), timeout: this.timeoutMs,
        maxRedirects: 0, failOnStatusCode: false,
      });
    } catch { throw new HarnessError('API'); }
    requireSafe(response.status() === 409, 'CONFLICT');
  }
}

export function ownedRuntimePods(pods: KubeObject[], name: string) {
  return pods.filter(pod => pod.metadata.namespace === 'ai' && pod.metadata.labels?.app === 'model' &&
    pod.metadata.labels.model === name &&
    pod.metadata.ownerReferences?.some(owner => owner.kind === 'Model' && owner.name === name && owner.controller === true));
}

export async function remainingModelResources(observer: KubectlObserver, client: Pick<OwnedModelClient, 'models'>, name: string) {
  const [pods, models] = await Promise.all([observer.list('pods', 'ai'), client.models()]);
  return {podCount: ownedRuntimePods(pods, name).length,
    catalogCount: (models.models ?? []).filter(item => item.id === name).length};
}

export function fixtureIsAdvertised(payload: ModelsPayload, fixture: LocalModelFixture) {
  const target = payload.computeTargets.targets.find(item => item.id === fixture.computeTarget);
  requireSafe(target?.available && target.engines?.includes(fixture.engine) &&
    target.engineAvailability?.[fixture.engine]?.available !== false, 'CAPABILITY');
  const variants = Object.values(payload.presets ?? {}).flatMap(preset => preset.variants ?? []);
  requireSafe(variants.some(variant => variant.engine === fixture.engine && variant.computeTarget === fixture.computeTarget &&
    (variant.url === fixture.url || (variant.artifacts ?? []).some(artifact => artifact.url === fixture.url))), 'CAPABILITY');
}
