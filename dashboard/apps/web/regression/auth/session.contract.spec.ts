import {test, expect} from '@playwright/test';
import {recordedApi} from '../fixtures/api-client.ts';

test('AUTH-02 [p1:anonymous-contract] unauthorized inventory/session does not become an authenticated empty success', async () => {
  for (const status of [401, 403, 503]) {
    const {api, requests} = recordedApi({error: 'Controlled denial'}, status);
    await expect(api.session()).rejects.toMatchObject({status});
    await expect(api.models()).rejects.toMatchObject({status});
    expect(requests.every(item => item.init.method === 'GET' && item.init.cache === 'no-store')).toBe(true);
    expect(requests.every(item => !new Headers(item.init.headers).has('Authorization'))).toBe(true);
  }
  // The shared schema intentionally defaults absent fields for compatibility.
  // Empty success must still carry neither an actor nor a privileged role.
  const {api} = recordedApi({});
  await expect(api.session()).resolves.toMatchObject({subject: '', roles: []});
  const malformed = recordedApi({roles: 'magicstick-admin'});
  await expect(malformed.api.session()).rejects.toThrow();
});
