import {test, expect} from '@playwright/test';
import {recordedApi} from '../fixtures/api-client.ts';

test('KEY-01 [p1:key-create-contract] named-key write uses the existing endpoint and CSRF contract', async () => {
  const {api, requests} = recordedApi({item: {id: 'fixture-id', name: 'fixture-key'}, key: 'sk-synthetic'});
  const result = await api.createApiKey('fixture-key');
  expect(result.key).toBe('sk-synthetic'); expect(requests).toHaveLength(1);
  expect(requests[0]?.path).toBe('/api/api-access');
  expect(requests[0]?.init.method).toBe('POST'); expect(JSON.parse(String(requests[0]?.init.body))).toEqual({name: 'fixture-key'});
  expect(new Headers(requests[0]?.init.headers).get('X-MagicStick-CSRF')).toBe('dashboard');
});

test('KEY-03 [p1:key-revoke-contract] revoke addresses exactly one encoded immutable key ID', async () => {
  const {api, requests} = recordedApi({status: 'revoked'});
  await api.revokeApiKey('fixture/id');
  expect(requests[0]?.path).toBe('/api/api-access/fixture%2Fid'); expect(requests[0]?.init.method).toBe('DELETE');
  expect(requests[0]?.init.body).toBeUndefined();
  expect(new Headers(requests[0]?.init.headers).get('X-MagicStick-CSRF')).toBe('dashboard');
});
