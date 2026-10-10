import {describe, expect, it} from 'vitest';
import {initialLocalModelDraft, localModelChanges, localModelConfigurationPolicy, localModelCreatePayload, modelEditRevision} from '@magicstick/dashboard-core';
import type {ModelActivation, ModelsPayload} from '@magicstick/dashboard-contracts';

const models: ModelsPayload = {activations: [], models: [], presets: {}, computeTargets: {
  targets: [{id: 'cpu', available: true, engines: ['VLLM', 'OLlama']}], engineCatalog: {VLLM: {realtimeProfiles: {
    omni: {displayName: 'Omni', model: 'example/omni', description: 'fixture', gpuCounts: [1, 2],
      defaultContextWindow: 8192, defaultSystemMemoryMi: 16384, sourceRevision: 'fixture'},
  }}}, realtimeDevices: [{profile: 'omni', node: 'fixture-node', name: 'Fixture GPU', supported: true, reason: '',
    computeTarget: 'nvidia-gpu', gpuCount: 2, freeGpuCount: 2, gpuMemoryMi: 48000, systemMemoryMi: 65536}],
}};
const saved = (local: Record<string, unknown>): ModelActivation => ({metadata: {name: 'saved', uid: 'fixture-uid', generation: 3, resourceVersion: '27'},
  spec: {type: 'local', enabled: true, local: {engine: 'VLLM', computeTarget: 'nvidia-gpu', url: 'hf://example/model',
    contextWindow: 4096, maxNumSeqs: 1, modelType: 'chat', vram: '8Gi', ...local}}});

describe('shared local model intent', () => {
  it.each(['VLLM', 'OLlama'])('preserves unchanged, changed and reverted legacy %s settings', (engine) => {
    const initial = initialLocalModelDraft(models, engine, saved({engine}));
    expect(initial.kind).toBe('standard');
    if (initial.kind !== 'standard') throw new Error('standard fixture');
    expect(initial.selectedMi).toBe(8192);
    expect(localModelChanges(initial, {...initial})).toEqual({});
    expect(localModelChanges(initial, {...initial, contextWindow: 8192})).toEqual({contextWindow: 8192});
    expect(localModelChanges(initial, {...initial, contextWindow: 4096})).toEqual({});
    expect(localModelChanges(initial, {...initial, maxOutputTokens: '256'})).toEqual({maxOutputTokens: 256});
    const withOutput = {...initial, maxOutputTokens: '256'};
    expect(localModelChanges(withOutput, initial)).toEqual({maxOutputTokens: null});
  });
  it('preserves source, custom image and restart nonce when changing only Omni context', () => {
    const activation = saved({url: 'hf://example/custom', realtime: {profile: 'omni', gpuNode: 'fixture-node', gpuCount: 1,
      systemMemoryMi: 16384, gpuMemoryFraction: .75, thinkerCpuOffloadGiB: 4, runtimeImage: 'example.local/omni:test', restartNonce: 'keep'}});
    const initial = initialLocalModelDraft(models, 'VLLM-Omni', activation);
    expect(initial.url).toBe('hf://example/custom');
    expect(localModelChanges(initial, initial)).toEqual({});
    expect(localModelChanges(initial, {...initial, contextWindow: 2048})).toEqual({contextWindow: 2048});
    if (initial.kind !== 'omni') throw new Error('omni fixture');
    expect(localModelChanges(initial, {...initial, realtime: {...initial.realtime, gpuMemoryFraction: .9}})).toEqual({
      realtime: {...initial.realtime, gpuMemoryFraction: .9},
    });
  });
  it('whitelists Omni intent even when stale ordinary fields are present', () => {
    const draft = {...initialLocalModelDraft(models, 'VLLM-Omni'), name: 'omni', url: 'https://huggingface.co/example/omni/',
      kvCacheType: 'fp8', selectedMi: 32000, presetId: 'old', cpuOffloading: true};
    const payload = localModelCreatePayload(draft, {vllm: {parallelism: 'tensor'}, allowMemoryRisk: true,
      cpuResources: {requestMillicores: 1500, limitMillicores: 0}});
    expect(payload.local).toEqual({engine: 'VLLM', computeTarget: 'nvidia-gpu', modelType: 'chat', url: 'hf://example/omni',
      contextWindow: 8192, maxNumSeqs: 1, cpuResources: {requestMillicores: 1500, limitMillicores: 0},
      realtime: expect.objectContaining({profile: 'omni', gpuCount: 1, gpuMemoryFraction: .9})});
  });
  it('serializes CPU changes and explicit reset independently of engine memory fields', () => {
    const initial = initialLocalModelDraft(models, 'VLLM-Omni', saved({realtime: {profile: 'omni', gpuNode: 'fixture-node', gpuCount: 1,
      systemMemoryMi: 16384, gpuMemoryFraction: .9, thinkerCpuOffloadGiB: 0}}));
    expect(localModelChanges(initial, initial, {cpuChanged: true, cpuResources: {requestMillicores: 500, limitMillicores: 0}}))
      .toEqual({cpuResources: {requestMillicores: 500, limitMillicores: 0}});
    expect(localModelChanges(initial, initial, {cpuChanged: true, cpuResources: null})).toEqual({cpuResources: null});
  });
  it('keeps GPU identities stable despite reordered fields and changed display names', () => {
    const initial = initialLocalModelDraft(models, 'VLLM', saved({gpuDevice: {uuid: 'GPU-1', nodeUid: 'node-uid', nodeName: 'old-name'}}));
    if (initial.kind !== 'standard') throw new Error('standard fixture');
    expect(localModelChanges(initial, {...initial, gpuDevices: [{nodeUid: 'node-uid', uuid: 'GPU-1', nodeName: 'new-name'}]})).toEqual({});
    const automatic = localModelChanges(initial, {...initial, gpuDevices: []});
    expect(automatic).toEqual({gpuDevice: null, gpuDeployment: null});
  });
  it('rejects engine, target and Omni-profile changes during editing', () => {
    const initial = initialLocalModelDraft(models, 'VLLM');
    if (initial.kind !== 'standard') throw new Error('standard fixture');
    expect(() => localModelChanges(initial, {...initial, engine: 'OLlama'})).toThrow('engine and hardware');
    expect(() => localModelChanges(initial, {...initial, computeTarget: 'other'})).toThrow('engine and hardware');
    const omni = initialLocalModelDraft(models, 'VLLM-Omni');
    if (omni.kind !== 'omni') throw new Error('omni fixture');
    expect(() => localModelChanges(omni, {...omni, realtime: {...omni.realtime, profile: 'other'}})).toThrow('profile');
  });
  it('uses catalog presentation policy and preserves older installed catalog behavior', () => {
    expect(localModelConfigurationPolicy(models, 'OLlama')).toMatchObject({memory: 'estimate', discovery: 'artifacts'});
    expect(localModelConfigurationPolicy(models, 'VLLM', 'omni')).toMatchObject({memory: 'staged', sources: ['search', 'direct']});
    const data = structuredClone(models);
    data.computeTargets.engineCatalog!.VLLM!.configuration = {memory: 'estimate', discovery: 'artifacts', task: 'detect', sources: ['direct'], maxOutputTokens: false};
    expect(localModelConfigurationPolicy(data, 'VLLM').sources).toEqual(['direct']);
  });
  it('uses generation fences before resourceVersion and rejects a missing edit identity', () => {
    expect(modelEditRevision(saved({}))).toBe('generation:fixture-uid:3');
    expect(modelEditRevision({metadata: {resourceVersion: '17'}})).toBe('17');
    expect(modelEditRevision({})).toBe('');
  });
});
