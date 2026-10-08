import {test, expect} from '@playwright/test';
import {recordedApi} from '../fixtures/api-client.ts';

test('LIFE-01 [p1:create-contract] local CPU/Ollama intent retains its engine-specific saved values', async () => {
  const {api, requests} = recordedApi({metadata: {name: 'fixture-cpu'}});
  const intent = {name: 'fixture-cpu', engine: 'OLlama', computeTarget: 'cpu', url: 'ollama://fixture',
    contextWindow: 2048, maxNumSeqs: 1, memoryRequiredMi: 3072};
  await api.createLocalModel(intent);
  expect(requests[0]?.path).toBe('/api/models/local'); expect(requests[0]?.init.method).toBe('POST');
  expect(JSON.parse(String(requests[0]?.init.body))).toEqual(intent);
});

for (const [action, id, variant] of [['stop', 'LIFE-03', 'stop-contract'], ['start', 'LIFE-04', 'start-contract']] as const) {
  test(`${id} [p1:${variant}] lifecycle request preserves the revision precondition and does not delete intent`, async () => {
    const {api, requests} = recordedApi({activation: {metadata: {uid: 'fixture-uid'}, spec: {enabled: action === 'start'}}});
    await api.request('/api/models/fixture-cpu/' + action, {method: 'POST', body: JSON.stringify({expectedRevision: 'generation:fixture-uid:1'})});
    expect(requests[0]?.init.method).toBe('POST'); expect(JSON.parse(String(requests[0]?.init.body))).toEqual({expectedRevision: 'generation:fixture-uid:1'});
    expect(new Headers(requests[0]?.init.headers).get('X-MagicStick-CSRF')).toBe('dashboard');
  });
}

test('LIFE-06 [p1:remove-contract] deletion uses the model endpoint without inventing a stop/delete alias', async () => {
  const {api, requests} = recordedApi({removed: true}); await api.removeModel('fixture-cpu');
  expect(requests[0]?.path).toBe('/api/models/fixture-cpu'); expect(requests[0]?.init.method).toBe('DELETE');
});
