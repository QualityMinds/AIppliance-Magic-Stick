import {test, expect, type APIRequestContext} from '@playwright/test';
import type {DiscoveryArtifactsPayload, DiscoverySearchPayload} from '@magicstick/dashboard-contracts';
import {loadLabConfig} from '../core/config.ts';
import {realLogin, type ExactDashboardRequest} from '../core/auth.ts';
import {LiveFoundation} from '../core/live-foundation.ts';
import {requirePhase2Profile} from '../profiles/phase2-p0.ts';
import {evidenceAnnotations} from '../core/evidence.ts';
import {HarnessError, requireSafe} from '../core/errors.ts';

async function discoveryGet<T>(request: APIRequestContext, dashboardUrl: string, path: string, params: URLSearchParams,
  timeoutMs: number): Promise<T> {
  const url = new URL(path, dashboardUrl); url.search = params.toString();
  requireSafe(url.origin === dashboardUrl && ['/api/model-discovery/search', '/api/model-discovery/artifacts'].includes(url.pathname), 'MUTATION');
  let response;
  try { response = await request.get(url.href, {timeout: timeoutMs, maxRedirects: 0, failOnStatusCode: false}); }
  catch { throw new HarnessError('API'); }
  requireSafe(response.status() === 200 && (response.headers()['content-type'] ?? '').includes('application/json'), 'API');
  const bytes = await response.body(); requireSafe(bytes.length < 8 * 1024 * 1024, 'API');
  try { return JSON.parse(bytes.toString('utf8')) as T; } catch { throw new HarnessError('API'); }
}

test('DISC-01 DISC-03 installed create choices and paged Hugging Face discovery preserve the pinned artifact', evidenceAnnotations(
  {id: 'DISC-01', variant: 'create-choice-live', layer: 'E'},
  {id: 'DISC-03', variant: 'hf-search-live', layer: 'A'},
  {id: 'DISC-03', variant: 'hf-search-live', layer: 'E'}), async ({browser}) => {
  requireSafe(process.env.REGRESSION_CONFIG, 'CONFIG');
  const config = await loadLabConfig(process.env.REGRESSION_CONFIG); requirePhase2Profile(config);
  const profile = config.phase2!;
  const allowed: ExactDashboardRequest[] = [];
  const context = await realLogin(browser, config, {allowedDashboardRequests: () => allowed});
  try {
    await LiveFoundation.snapshot(context, config);
    const common = {provider: 'huggingface', engine: 'VLLM', computeTarget: 'cpu', modelType: 'chat'};
    const firstParams = new URLSearchParams({...common, q: profile.discovery.query, limit: '20'});
    const first = await discoveryGet<DiscoverySearchPayload>(context.request, config.dashboardUrl,
      '/api/model-discovery/search', firstParams, config.requestTimeoutMs);
    requireSafe(Array.isArray(first.results) && typeof first.nextCursor === 'string' && first.nextCursor.length > 0, 'API');
    const secondParams = new URLSearchParams({...common, q: profile.discovery.query, limit: '20', cursor: first.nextCursor});
    const second = await discoveryGet<DiscoverySearchPayload>(context.request, config.dashboardUrl,
      '/api/model-discovery/search', secondParams, config.requestTimeoutMs);
    const repos = [...first.results, ...second.results].map(item => item.repo);
    requireSafe(repos.includes(profile.discovery.repo) && new Set(repos).size === repos.length, 'API');
    const artifactParams = new URLSearchParams({...common, repo: profile.discovery.repo, limit: '20'});
    const artifacts = await discoveryGet<DiscoveryArtifactsPayload>(context.request, config.dashboardUrl,
      '/api/model-discovery/artifacts', artifactParams, config.requestTimeoutMs);
    const selected = artifacts.artifacts.find(item => item.url === profile.discovery.artifactUrl);
    requireSafe(selected?.id && selected.revision && Number(selected.downloadBytes ?? 0) > 0, 'API');
    const contextWindow = Number(selected.modelMaxContext ?? artifacts.baseModel?.modelMaxContext ?? profile.vllmModel.contextWindow);
    requireSafe(Number.isSafeInteger(contextWindow) && contextWindow > 0, 'API');
    allowed.push({method: 'POST', path: '/api/models/estimate-memory', mutating: false, body: {
      engine: 'VLLM', computeTarget: 'cpu', url: profile.discovery.artifactUrl, contextWindow, maxNumSeqs: 1,
      modelType: 'chat', kvCacheType: profile.vllmModel.kvCacheType,
    }});

    const page = await context.newPage();
    try {
      await page.goto(config.dashboardUrl + '/#/models', {waitUntil: 'domcontentloaded'});
      await page.getByRole('button', {name: 'Create', exact: true}).click();
      const dialog = page.getByRole('dialog', {name: 'Create Model'});
      await dialog.getByLabel('Location').selectOption('external');
      await expect(dialog.getByLabel('Provider Model')).toBeVisible();
      await dialog.getByLabel('Location').selectOption('local');
      await dialog.getByLabel('Inference Engine').selectOption('VLLM');
      await expect(dialog.getByLabel('Hardware')).toHaveValue('cpu');
      await dialog.getByPlaceholder('Qwen, GLM, DeepSeek…').fill(profile.discovery.query);
      await dialog.getByRole('button', {name: 'Search', exact: true}).click();
      await expect(dialog.getByRole('button', {name: 'Load more models'})).toBeVisible();
      await dialog.getByRole('button', {name: 'Load more models'}).click();
      await dialog.getByLabel('Matching model').selectOption(profile.discovery.repo);
      await dialog.getByLabel('Quantization / artifact').selectOption(selected.id);
      await expect(dialog.getByLabel('Selected URL')).toHaveValue(profile.discovery.artifactUrl);
      await expect(dialog.getByText(new RegExp(String(selected.revision).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeVisible();
      await expect(dialog.getByText(/Download:/)).toBeVisible();
      await dialog.getByRole('button', {name: 'Cancel'}).click();
    } finally { await page.close(); }
  } finally { await context.close(); }
});
