import {test, expect, type Request} from '@playwright/test';
import {evidenceAnnotations} from '../core/evidence.ts';
import {fixturePage, origin} from '../fixtures/dashboard.ts';

const cpuModels = {
  activations: [], models: [], presets: {},
  computeTargets: {default: 'cpu', targets: [{id: 'cpu', kind: 'cpu', displayName: 'CPU', available: true,
    engines: ['OLlama', 'VLLM'], declaredEngines: ['OLlama', 'VLLM'], kvCacheTypes: {
      OLlama: [{value: 'f16', label: 'Standard - F16'}, {value: 'q8_0', label: 'Memory saving - Q8'}],
      VLLM: [{value: 'auto', label: 'Standard - model precision'}],
    }}]},
  computeMemory: {devices: [{id: 'cpu', kind: 'cpu', computeTarget: 'cpu', totalMi: 65536,
    freeMi: 60000, unreservedMi: 60000, metricsAvailable: true}]},
};
const estimate = {minimumMi: 6000, recommendedMi: 7000, maximumMi: 60000, computeTarget: 'cpu',
  weightsMi: 5000, kvCacheMi: 500, reserveMi: 500, headroomMi: 1000, downloadBytes: 4_000_000_000,
  confidence: 'high', calculations: {downloadBytes: {formula: 'repository bytes', substitution: '4,000,000,000 bytes'}}};

const common = (extra: Record<string, unknown> = {}) => ({
  '/api/models': cpuModels,
  '/api/model-discovery/popular': {provider: 'huggingface', results: [], total: 0},
  '/api/models/estimate-memory': estimate,
  ...extra,
});

test('DISC-01 ENG-07 create dialog switches location and engine without leaking incompatible fields', evidenceAnnotations(
  {id: 'DISC-01', variant: 'create-choice-browser', layer: 'B'},
  {id: 'ENG-07', variant: 'engine-switch-browser', layer: 'B'}), async ({page}) => {
  await fixturePage(page, common()); await page.goto(origin + '/#/models');
  await page.getByRole('button', {name: 'Create', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Model'});
  await expect(dialog.getByLabel('Location')).toHaveValue('local');
  await dialog.getByLabel('Inference Engine').selectOption('VLLM');
  await dialog.getByLabel('Model source').selectOption('direct');
  await dialog.getByLabel('Hugging Face URL').fill('hf://example/vllm');
  await expect(dialog.getByLabel('KV Cache')).toHaveValue('auto');
  await dialog.getByLabel('Inference Engine').selectOption('OLlama');
  await expect(dialog.getByLabel('Ollama model reference')).toHaveValue('');
  await expect(dialog.getByLabel('KV Cache')).toHaveValue('f16');
  await dialog.getByLabel('Location').selectOption('external');
  await expect(dialog.getByLabel('Provider Model')).toBeVisible();
  await expect(dialog.getByLabel('Inference Engine')).toHaveCount(0);
  await dialog.getByLabel('Location').selectOption('local');
  await expect(dialog.getByLabel('Inference Engine')).toBeVisible();
  await expect(dialog.getByLabel('Provider Model')).toHaveCount(0);
});

test('DISC-03 DISC-04 browser discovery sends exact policy context and keeps selected artifact provenance', evidenceAnnotations(
  {id: 'DISC-03', variant: 'hf-search-browser', layer: 'B'},
  {id: 'DISC-04', variant: 'hf-policy-browser', layer: 'B'}), async ({page}) => {
  const searches: URL[] = [], artifacts: URL[] = [];
  await fixturePage(page, common({
    '/api/model-discovery/search': (request: Request) => {
      searches.push(new URL(request.url()));
      return {provider: 'huggingface', total: 1, results: [{id: 'Qwen/Qwen3.8-9B', repo: 'Qwen/Qwen3.8-9B',
        modelMaxContext: 32768, revision: 'fixture-revision'}]};
    },
    '/api/model-discovery/artifacts': (request: Request) => {
      artifacts.push(new URL(request.url()));
      return {provider: 'huggingface', total: 1, baseModel: {id: 'Qwen/Qwen3.8-9B', repo: 'Qwen/Qwen3.8-9B', modelMaxContext: 32768},
        artifacts: [{id: 'fp8', repo: 'Qwen/Qwen3.8-9B-FP8', label: 'FP8 checkpoint',
          url: 'hf://Qwen/Qwen3.8-9B-FP8', revision: 'fixture-artifact', downloadBytes: 4_000_000_000}]};
    },
  }));
  await page.goto(origin + '/#/models'); await page.getByRole('button', {name: 'Create', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Model'});
  await dialog.getByLabel('Inference Engine').selectOption('VLLM');
  await dialog.getByPlaceholder('Qwen, GLM, DeepSeek…').fill('Qwen3.8');
  await dialog.getByRole('button', {name: 'Search', exact: true}).click();
  await expect(dialog.getByLabel('Matching model')).toHaveValue('Qwen/Qwen3.8-9B');
  await expect(dialog.getByLabel('Quantization / artifact')).toHaveValue('fp8');
  await expect(dialog.getByLabel('Selected URL')).toHaveValue('hf://Qwen/Qwen3.8-9B-FP8');
  await expect(dialog.getByText('Download: 4.00 GB')).toBeVisible();
  expect(Object.fromEntries(searches[0]!.searchParams)).toMatchObject({provider: 'huggingface', engine: 'VLLM',
    computeTarget: 'cpu', modelType: 'chat', q: 'Qwen3.8'});
  expect(Object.fromEntries(artifacts[0]!.searchParams)).toMatchObject({provider: 'huggingface', engine: 'VLLM',
    computeTarget: 'cpu', modelType: 'chat', repo: 'Qwen/Qwen3.8-9B'});
});

for (const selection of [
  {engine: 'OLlama', urlLabel: 'Ollama model reference', url: 'ollama://fixture:latest', variant: 'create-ollama-browser'},
  {engine: 'VLLM', urlLabel: 'Hugging Face URL', url: 'hf://example/fixture', variant: 'create-vllm-browser'},
] as const) {
  test(`LIFE-02 browser submits the reviewed ${selection.engine} CPU intent`, evidenceAnnotations(
    {id: 'LIFE-02', variant: selection.variant, layer: 'B'}), async ({page}) => {
    let saved: Record<string, unknown> | undefined;
    await fixturePage(page, common({'/api/models/local': async (request: Request) => {
      saved = request.postDataJSON() as Record<string, unknown>; return {metadata: {name: 'fixture-created'}};
    }}));
    await page.goto(origin + '/#/models'); await page.getByRole('button', {name: 'Create', exact: true}).click();
    const dialog = page.getByRole('dialog', {name: 'Create Model'});
    await dialog.getByLabel('Inference Engine').selectOption(selection.engine);
    await dialog.getByLabel('Model source').selectOption('direct');
    await dialog.getByLabel(selection.urlLabel).fill(selection.url);
    await expect(dialog.getByLabel('RAM budget (MiB)')).toHaveValue('7000');
    await dialog.getByRole('button', {name: 'Add Local Model'}).click();
    await expect(dialog).toHaveCount(0);
    expect(saved).toMatchObject({enabled: true, targetNamespace: 'ai', local: {
      engine: selection.engine, computeTarget: 'cpu', url: selection.url, memoryRequiredMi: 7000,
    }});
  });
}

test('LIFE-08 MEM-06 edit polling preserves a changed CPU budget and only enables a valid dirty draft', evidenceAnnotations(
  {id: 'LIFE-08', variant: 'dirty-browser', layer: 'B'},
  {id: 'MEM-06', variant: 'slider-browser', layer: 'B'}), async ({page}) => {
  await fixturePage(page, {
    '/api/models/fixture-cpu/estimate-memory': async () => {
      await new Promise(resolve => setTimeout(resolve, 80)); return estimate;
    },
  });
  await page.goto(origin + '/#/models'); await page.getByRole('button', {name: 'Edit fixture-cpu', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Edit Model · fixture-cpu'});
  const save = dialog.getByRole('button', {name: 'Save changes', exact: true});
  await expect(save).toBeDisabled();
  const budget = dialog.getByLabel('RAM budget (MiB)');
  const slider = dialog.getByRole('slider', {name: 'Memory reservation'});
  await expect(slider).toBeEnabled();
  const maximum = await slider.getAttribute('max');
  await slider.press('End');
  await expect(slider).toHaveValue(maximum!); await expect(budget).toHaveValue(maximum!);
  await budget.fill('3072'); await expect(save).toBeDisabled();
  await budget.fill('4100'); await expect(save).toBeEnabled();
  await expect(slider).toHaveValue('4100');
  await dialog.getByLabel('Context Size').fill('1024');
  await expect(budget).toHaveValue('4100'); await expect(save).toBeEnabled();
  await dialog.getByLabel('Context Size').fill('0'); await expect(save).toBeDisabled();
  await dialog.getByLabel('Context Size').fill('2048'); await budget.fill('3072'); await expect(save).toBeDisabled();
});

test('MEM-01 MEM-05 browser separates download size from memory and labels an accepted estimate risk', evidenceAnnotations(
  {id: 'MEM-01', variant: 'memory-breakdown-browser', layer: 'B'},
  {id: 'MEM-05', variant: 'risk-browser', layer: 'B'}), async ({page}) => {
  const constrained = {...cpuModels, computeMemory: {devices: [{...cpuModels.computeMemory.devices[0], unreservedMi: 4000}]}};
  await fixturePage(page, common({'/api/models': constrained, '/api/models/estimate-memory': {...estimate, maximumMi: 4000}}));
  await page.goto(origin + '/#/models'); await page.getByRole('button', {name: 'Create', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Create Model'});
  await dialog.getByLabel('Inference Engine').selectOption('VLLM'); await dialog.getByLabel('Model source').selectOption('direct');
  await dialog.getByLabel('Hugging Face URL').fill('hf://example/risky');
  await dialog.getByText('Breakdown', {exact: true}).click();
  await expect(dialog.getByText('Download (disk / network)')).toBeVisible();
  await expect(dialog.getByText('Download size is not added to memory.')).toBeVisible();
  await expect(dialog.getByText(/Memory warning/)).toBeVisible();
  await expect(dialog.getByRole('button', {name: /Add Local Model/})).toBeEnabled();
});

test('LIFE-12 failure card shows the reported stage and never presents the fixture as Ready', evidenceAnnotations(
  {id: 'LIFE-12', variant: 'failure-browser', layer: 'B'}), async ({page}) => {
  await fixturePage(page); await page.goto(origin + '/#/models');
  const card = page.locator('.panel').filter({hasText: 'fixture-cpu'});
  await expect(card.getByText('Degraded', {exact: true})).toBeVisible();
  await expect(card.locator('p.muted').filter({hasText: 'ImagePullBackOff: controlled fixture'})).toBeVisible();
  await expect(card.getByText('Ready', {exact: true})).toHaveCount(0);
});
