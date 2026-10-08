import {type Page, type Request} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export const origin = 'https://dashboard.example.local';
const activation = {
  metadata: {name: 'fixture-cpu', namespace: 'ai-system', uid: 'fixture-model-uid', generation: 1},
  spec: {type: 'local', enabled: true, targetNamespace: 'ai', local: {engine: 'OLlama', computeTarget: 'cpu',
    url: 'ollama://fixture', contextWindow: 2048, maxNumSeqs: 1, memoryRequiredMi: 3072}},
  status: {phase: 'Degraded', message: 'ImagePullBackOff: controlled fixture', engine: 'OLlama', computeTarget: 'cpu'},
};
const models = {activations: [activation], models: [], presets: {},
  computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', available: true, engines: ['OLlama'],
    kvCacheTypes: {OLlama: [{value: 'f16', label: 'F16'}]}}]},
  computeMemory: {devices: [{id: 'unknown-gpu', kind: 'gpu', name: 'Fixture NVIDIA', computeTarget: 'nvidia-gpu',
    totalMi: null, freeMi: null, unreservedMi: null, metricsAvailable: false}]}};
const payloads: Record<string, unknown> = {
  '/api/session': {subject: 'fixture-admin', username: 'fixture-admin', roles: ['magicstick-admin']},
  '/api/appliance': {metadata: {name: 'local'}, status: {phase: 'Ready'}},
  '/api/modules': {modules: {litellm: {enabled: true, displayName: 'Fixture runtime', status: {phase: 'Degraded',
    message: 'Fixture module health failed'}}}, catalogJson: {modules: {}}},
  '/api/instances': {instances: {}}, '/api/models': models,
  '/api/settings': {}, '/api/api-access': {items: [], total: 0, endpoints: []},
  '/api/status': {pods: [], services: [], httpRoutes: [], hardwareOperators: {}, fluxKustomizations: [
    {namespace: 'flux-system', name: 'fixture-flux', conditions: [{type: 'Ready', status: 'False', reason: 'FixtureReconcileFailed'}]},
  ]},
};

/** Render the real bundled application against isolated, public-safe API data. */
export async function fixturePage(page: Page, extra: Record<string, unknown> = {}) {
  const dist = resolve('dist');
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { await route.abort(); return; }
    const values = {...payloads, ...extra};
    if (Object.hasOwn(values, url.pathname)) {
      const value = values[url.pathname];
      const result = typeof value === 'function' ? await (value as (request: Request) => unknown)(request) : value;
      await route.fulfill({status: 200, contentType: 'application/json', body: JSON.stringify(result)}); return;
    }
    if (!['GET', 'HEAD'].includes(request.method())) { await route.abort(); return; }
    const asset = /^\/assets\/[a-zA-Z0-9_.-]+\.(js|css)$/.exec(url.pathname);
    if (asset) {
      await route.fulfill({status: 200, contentType: asset[1] === 'js' ? 'application/javascript' : 'text/css',
        body: await readFile(resolve(dist, '.' + url.pathname))}); return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      await route.fulfill({status: 200, contentType: 'text/html', body: await readFile(resolve(dist, 'index.html'))}); return;
    }
    await route.fulfill({status: 404, body: ''});
  });
}
