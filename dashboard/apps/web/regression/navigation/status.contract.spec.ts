import {test, expect} from '@playwright/test';
import {recordedApi} from '../fixtures/api-client.ts';

test('NAV-06 [p1:status-contract] shared API preserves root causes and unknown readings', async () => {
  const payload = {pods: [{phase: 'Failed', message: 'Controlled failure'}], hardwareOperators: {},
    fluxKustomizations: [{conditions: [{type: 'Ready', status: 'False', message: 'Controlled reconcile failure'}]}]};
  const {api} = recordedApi(payload); expect(await api.status()).toEqual(payload);
  const models = {activations: [], computeMemory: {devices: [{totalMi: null, freeMi: null, metricsAvailable: false}]}};
  expect(await recordedApi(models).api.models()).toEqual(models);
});
